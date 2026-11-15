/**
 * 배포 준비 E2E 점검 (Playwright) — 보안 헤더 · CSP 위반 · 웹 앱 매니페스트 · 홈 화면 아이콘 · 빌드 결과물
 * 사용법: npm run build && npm run e2e:deploy
 *
 * - 미리보기 서버가 Pages와 같은 보안 헤더를 보내는지 (server/securityHeaders.ts 하나에서 생성)
 * - dist/_headers(Pages용) 내용이 같은지
 * - 주요 화면 + 영상 재생(임베드)에서 CSP 위반이 하나도 없는지
 * - 매니페스트를 Chromium이 오류 없이 읽는지, 아이콘 크기가 맞는지, iOS 홈 화면 태그가 있는지
 * - 빌드 결과물에 비밀정보 형식(Google API 키)이 없는지
 * 외부 서비스는 호출하지 않는다 (YouTube 요청은 가짜 응답으로 대체).
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const SHOTS = 'e2e-screenshots';
mkdirSync(SHOTS, { recursive: true });
const PORT = 4188;
const BASE = `http://localhost:${PORT}`;

function startServer() {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'pipe',
    env: { ...process.env, YOUTUBE_API_KEY: '', YOUTUBE_API_MOCK: '' },
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('preview server timeout')), 15000);
    server.stdout.on('data', (d) => {
      if (String(d).includes(String(PORT))) {
        clearTimeout(t);
        resolve(server);
      }
    });
  });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** PNG 가로·세로 (IHDR) */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

async function main() {
  // ── 빌드 결과물 ──
  const headersFile = readFileSync('dist/_headers', 'utf8');
  check('dist/_headers 생성 (모든 경로 /*)', headersFile.includes('\n/*\n') && headersFile.includes('Content-Security-Policy:'));
  const leaked = walk('dist').filter((f) => /\.(js|css|html|json|webmanifest|txt|map)$/.test(f) && /AIza[0-9A-Za-z_-]{20,}/.test(readFileSync(f, 'utf8')));
  check('빌드 결과물에 Google API 키 형식 없음', leaked.length === 0, leaked.join(','));
  check('404.html 없음 (Pages가 SPA로 처리)', !walk('dist').some((f) => f.endsWith('404.html')));

  const server = await startServer();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ...devices['iPad (gen 7)'] });
    // 외부 YouTube 요청은 가짜 응답 (썸네일 = 1×1 PNG, 임베드 = 빈 HTML)
    const png1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await context.route(/^https:\/\/i\.ytimg\.com\//, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: png1 }));
    await context.route(/^https:\/\/www\.youtube-nocookie\.com\//, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>embed</title>' }));
    const page = await context.newPage();
    const violations = [];
    const errors = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (/Content Security Policy/i.test(t)) violations.push(t.slice(0, 200));
      else if (!/Failed to load resource/.test(t)) errors.push(t.slice(0, 200));
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
    });

    // ── 응답 헤더 ──
    const res = await page.goto(BASE);
    const h = res.headers();
    const expected = {
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'cross-origin-opener-policy': 'same-origin',
      'strict-transport-security': 'max-age=31536000',
    };
    check('기본 보안 헤더 전송', Object.entries(expected).every(([k, v]) => h[k] === v), Object.keys(expected).filter((k) => h[k] !== expected[k]).join(',') || '모두 일치');
    const csp = h['content-security-policy'] ?? '';
    check('CSP 전송 (스크립트 self만, unsafe-inline/eval 없음)', csp.includes("script-src 'self'") && !/unsafe-(inline|eval)/.test(csp));
    check('_headers 파일과 미리보기 헤더가 같은 CSP', headersFile.includes(`Content-Security-Policy: ${csp}`));
    check('Permissions-Policy (카메라·마이크·위치·결제·USB 차단)', /camera=\(\)/.test(h['permissions-policy'] ?? '') && /microphone=\(\)/.test(h['permissions-policy'] ?? ''));

    // ── 주요 화면 둘러보기 (CSP 위반 확인) ──
    await page.getByTestId('today-dialogue').waitFor({ timeout: 10000 });
    for (const path of ['/dialogues', '/review', '/collection', '/expressions', '/favorites', '/videos', '/settings', '/more']) {
      await page.goto(BASE + path);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(250);
    }
    // 영상 상세 → 재생 (youtube-nocookie 임베드). 샘플 영상에는 YouTube ID가 없어 테스트용 영상 1개를 DB에 직접 넣는다.
    const vid = 'e2e-deploy-video';
    await page.evaluate(
      (id) =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open('my-english-study');
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('videos', 'readwrite');
            const now = new Date().toISOString();
            tx.objectStore('videos').put({
              id, createdAt: now, updatedAt: now, playlistId: null, youtubeVideoId: 'dQw4w9WgXcQ', title: '[E2E] 재생 확인용 영상',
              url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
              durationSec: 60, orderIndex: 999, randomOrderKey: 0.5, status: 'new', completedAt: null,
              sources: [{ kind: 'manual', addedAt: now }], channelTitle: null, metadataSource: 'manual', captionCheck: null,
            });
            tx.oncomplete = () => { db.close(); resolve(true); };
            tx.onerror = () => reject(tx.error);
          };
        }),
      vid,
    );
    await page.goto(`${BASE}/videos/${vid}`);
    await page.getByRole('button', { name: '[E2E] 재생 확인용 영상 재생' }).click();
    await page.getByTestId('youtube-player').waitFor({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(500);
    check('영상 재생: 공식 임베드 iframe 표시', await page.getByTestId('youtube-player').isVisible().catch(() => false));
    const domViolations = await page.evaluate(() => window.__cspViolations);
    check('CSP 위반 없음 (주요 화면 9개 + 영상 재생)', violations.length === 0 && domViolations.length === 0, [...violations, ...domViolations].slice(0, 3).join(' | '));

    // ── 웹 앱 매니페스트 · 아이콘 ──
    await page.goto(BASE);
    const head = await page.evaluate(() => ({
      manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href'),
      apple: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'),
      capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute('content'),
      title: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content'),
    }));
    check('index.html: 매니페스트·apple-touch-icon·홈 화면 태그', head.manifest === '/manifest.webmanifest' && head.apple === '/apple-touch-icon.png' && head.capable === 'yes' && !!head.title, JSON.stringify(head));
    const cdp = await context.newCDPSession(page);
    const app = await cdp.send('Page.getAppManifest');
    const parsed = app.data ? JSON.parse(app.data) : null;
    check('Chromium이 매니페스트를 오류 없이 읽음', !!parsed && app.errors.length === 0, app.errors.map((e) => e.message).join(' | '));
    check('매니페스트: standalone · 시작 주소 / · 이름', parsed?.display === 'standalone' && parsed?.start_url === '/' && parsed?.name === 'My English Study');
    const icons = [
      ['/apple-touch-icon.png', 180],
      ...(parsed?.icons ?? []).map((i) => [i.src, Number(String(i.sizes).split('x')[0])]),
    ];
    for (const [src, size] of icons) {
      const r = await page.request.get(BASE + src);
      const dim = pngSize(Buffer.from(await r.body()));
      check(`아이콘 ${src} = ${size}×${size} PNG`, r.ok() && dim?.w === size && dim?.h === size, dim ? `${dim.w}×${dim.h}` : `HTTP ${r.status()}`);
    }
    check('매니페스트에 maskable 아이콘', (parsed?.icons ?? []).some((i) => i.purpose === 'maskable'));
    await page.screenshot({ path: `${SHOTS}/sDeploy-home.png` });
    check('브라우저 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.kill();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 통과`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
