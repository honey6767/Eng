/**
 * 영상 화면 '자막' 탭의 'AI로 자막 만들기' 버튼 E2E (Playwright, 새 임시 프로필)
 *
 * 사용법: npm run build && node scripts/e2e-aiExtractButton.mjs [mock|nokey|real]
 *  - mock  (기본): 가짜 Gemini. 요청 → 처리 중 → 성공 → 자막 탭에 텍스트 저장, 주요 표현 탭에 AI 표현, 다시 눌러도 재요청 없음
 *  - nokey : 서버에 Gemini 키가 없을 때 실패 상태 + HTTP 상태·오류 코드가 화면에 보이는지
 *  - real  : 실제 Gemini 1회 (테스트 영상 1개). 키는 서버 쪽에만 있고 브라우저·로그에 나오지 않는다
 *
 * 기존 데이터: 새 임시 프로필이라 사용자 기기 데이터와 무관. 테스트 영상 1개만 넣는다.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const MODE = process.argv[2] ?? 'mock';
const SHOTS = 'e2e-screenshots';
mkdirSync(SHOTS, { recursive: true });
const PORT = 4193;
const BASE = `http://localhost:${PORT}`;

function startServer() {
  const env = { ...process.env, YOUTUBE_API_KEY: '', YOUTUBE_API_MOCK: '', AI_GEMINI_MOCK: MODE === 'mock' ? '1' : '', GEMINI_API_KEY: MODE === 'real' ? 'proxy-injected' : '', ...(MODE === 'real' ? { NODE_USE_ENV_PROXY: '1' } : {}) };
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe', env });
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

const seed = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('my-english-study');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['videos'], 'readwrite');
          const now = new Date().toISOString();
          tx.objectStore('videos').add({ id: 'e2e-ai1', createdAt: now, updatedAt: now, playlistId: null, youtubeVideoId: 'eNODHkrNuDA', title: '[Day 11] 필요해 I need 말고', url: 'https://www.youtube.com/watch?v=eNODHkrNuDA', thumbnailUrl: null, durationSec: 295, orderIndex: 0, randomOrderKey: 0, status: 'new', completedAt: null, sources: [{ kind: 'manual', addedAt: now }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  const calls = [];
  try {
    const ctx = await browser.newContext({ ...devices['iPad (gen 7)'] });
    await ctx.route(/^https:\/\/(i\.ytimg\.com|www\.youtube(-nocookie)?\.com)\//, (r) => r.fulfill({ status: 200, body: '' }));
    ctx.on('response', async (r) => {
      if (r.url().endsWith('/api/ai/extract')) calls.push({ status: r.status(), key: r.request().headers()['idempotency-key'], state: (await r.json().catch(() => ({}))).state });
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));

    await page.goto(BASE);
    await page.locator('main').first().waitFor();
    await page.waitForTimeout(600);
    await seed(page);
    await page.goto(`${BASE}/videos/e2e-ai1?tab=transcript`);
    await page.getByTestId('ai-extract-start').waitFor();
    check('자막 탭에 AI 자막 만들기와 YouTube 공식 자막 확인이 따로 있음', (await page.getByRole('heading', { name: 'YouTube 공식 자막 확인' }).count()) === 1 && (await page.getByRole('heading', { name: 'AI로 자막 만들기 (Gemini)' }).count()) === 1);

    await page.getByTestId('ai-extract-start').click();
    await page.getByTestId('ai-extract-status').waitFor({ timeout: 5000 });
    const firstPhase = await page.getByTestId('ai-extract-status').getAttribute('data-phase');
    check('버튼을 누르면 바로 상태 표시 (요청 보내는 중/처리 중)', ['sending', 'processing'].includes(firstPhase), firstPhase);

    let phase = firstPhase;
    const seen = new Set([phase]);
    for (let i = 0; i < (MODE === 'real' ? 200 : 60) && !['succeeded', 'failed', 'already'].includes(phase); i++) {
      await page.waitForTimeout(1500);
      phase = await page.getByTestId('ai-extract-status').getAttribute('data-phase');
      seen.add(phase);
    }
    await page.screenshot({ path: `${SHOTS}/ai-btn-${MODE}-result.png`, fullPage: true });
    const statusText = await page.getByTestId('ai-extract-status').innerText();
    check('서버 API로 요청이 실제로 나감', calls.length > 0, `요청 ${calls.length}번 · HTTP ${[...new Set(calls.map((c) => c.status))].join(',')}`);

    if (MODE === 'nokey') {
      check('실패 상태 표시', phase === 'failed', statusText.replace(/\n/g, ' / '));
      check('HTTP 상태 코드와 오류 코드가 화면에 보임', /HTTP 503/.test(statusText) && /gemini_not_configured/.test(statusText));
    } else {
      check('처리 중 상태를 거쳐 성공', phase === 'succeeded' && seen.has('processing'), [...seen].join('→'));
      check('식별자 1개로만 요청 (생성 1회 + 같은 식별자 조회)', new Set(calls.map((c) => c.key)).size === 1, `상태 ${calls.map((c) => c.state).join(',')}`);
      // 자막 탭에 저장된 텍스트
      await page.waitForTimeout(800);
      const body = await page.locator('main').innerText();
      const lines = body.split('\n').filter((l) => /[A-Za-z]{3,}/.test(l));
      check('자막 탭에 저장된 자막 텍스트가 보임', /자막 \d+줄 저장/.test(statusText) && (await page.getByText('이미 저장됨').count()) === 1, statusText.split('\n')[0]);
      const saved = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const r = indexedDB.open('my-english-study');
            r.onsuccess = () => {
              const db = r.result;
              const q = db.transaction('transcripts').objectStore('transcripts').getAll();
              q.onsuccess = () => {
                db.close();
                resolve(q.result.filter((t) => t.videoId === 'e2e-ai1').map((t) => ({ source: t.source, status: t.status, n: t.segments.length, head: t.rawText.slice(0, 160) })));
              };
            };
          }),
      );
      check('IndexedDB에 AI 자막 1개 저장 (source=ai_transcription)', saved.length === 1 && saved[0].source === 'ai_transcription' && saved[0].n > 0, saved[0] ? `${saved[0].n}줄 · "${saved[0].head.replace(/\n/g, ' | ')}"` : '');
      check('화면 자막 목록에 텍스트 표시', lines.length > 3);
      await page.getByRole('tab', { name: /주요 표현/ }).click();
      await page.getByTestId('ai-expressions').waitFor({ timeout: 5000 }).catch(() => {});
      const ai = (await page.getByTestId('ai-expressions').count()) ? await page.getByTestId('ai-expressions').innerText() : '';
      check("'주요 표현' 탭에 AI 핵심 표현 표시 + 탭 개수 0 아님", !!ai && !/주요 표현\s*0/.test(await page.getByRole('tab', { name: /주요 표현/ }).innerText()), ai.split('\n').slice(0, 3).join(' / '));
      await page.screenshot({ path: `${SHOTS}/ai-btn-${MODE}-expressions.png`, fullPage: true });

      // 다시 와도 재요청 없음
      const n = calls.length;
      await page.goto(`${BASE}/videos/e2e-ai1?tab=transcript`);
      await page.getByTestId('ai-extract-start').waitFor();
      check('자막이 저장된 영상은 버튼이 잠기고 다시 요청하지 않음', (await page.getByTestId('ai-extract-start').isDisabled()) && calls.length === n);
    }
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
