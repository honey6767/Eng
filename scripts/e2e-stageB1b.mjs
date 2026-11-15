/**
 * B1-b E2E 점검 (Playwright, 실제 Chromium · 새 임시 프로필) — 가짜 Gemini(AI_GEMINI_MOCK=1), 실제 Google 호출 없음
 * 사용법: npm run build && npm run e2e:stageB1b
 *
 * - 새 기기(v3)에 자막 없는 영상 2개 + 자막 있는 영상 1개 + 긴 영상 1개를 테스트 데이터로 넣는다 (IndexedDB 직접)
 * - 영상 화면 '학습 시작' → 자막 추출이 백그라운드로 시작 → 진행 중에 새로고침 → 같은 요청 식별자로 이어서 완료
 * - 영상마다 요청 식별자 1개, 자막 있는 영상·긴 영상은 요청 없음, 결과는 검토 대기 초안으로 저장
 * - 기존 데이터: '학습 시작'이 원래 바꾸는 값(영상 학습 상태·학습 순서) 말고는 그대로
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const SHOTS = 'e2e-screenshots';
mkdirSync(SHOTS, { recursive: true });
const PORT = 4188;
const BASE = `http://localhost:${PORT}`;

function startServer() {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'pipe',
    env: { ...process.env, YOUTUBE_API_KEY: '', YOUTUBE_API_MOCK: '', AI_GEMINI_MOCK: '1', GEMINI_API_KEY: '' },
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
const canon = (v) => (v && typeof v === 'object' ? (Array.isArray(v) ? v.map(canon) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id ?? r.key, r]));

const dumpDb = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('my-english-study');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const names = [...db.objectStoreNames];
          const out = { version: db.version, tables: {} };
          const tx = db.transaction(names, 'readonly');
          let left = names.length;
          for (const n of names) {
            const r = tx.objectStore(n).getAll();
            r.onsuccess = () => {
              out.tables[n] = r.result;
              if (--left === 0) {
                db.close();
                resolve(out);
              }
            };
          }
        };
      }),
  );

const seedVideos = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('my-english-study');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['videos', 'transcripts'], 'readwrite');
          const now = '2026-11-15T09:00:00.000Z';
          const v = (id, yt, title, dur, i) => ({ id, createdAt: now, updatedAt: now, playlistId: null, youtubeVideoId: yt, title, url: null, thumbnailUrl: null, durationSec: dur, orderIndex: i, randomOrderKey: i / 10, status: 'new', completedAt: null, sources: [{ kind: 'manual', addedAt: now }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
          const vs = tx.objectStore('videos');
          vs.add(v('e2e-v1', 'eNODHkrNuDA', '[Day 11] 필요해 I need 말고', 295, 0));
          vs.add(v('e2e-v2', 'bbbbbbbbbbb', '[Day 12] 두 번째 영상', 240, 1));
          vs.add(v('e2e-v3', 'ccccccccccc', '[Day 13] 자막 있는 영상', 260, 2));
          vs.add(v('e2e-v4', 'ddddddddddd', '긴 강의 9시간', 32400, 3));
          tx.objectStore('transcripts').add({ id: 'e2e-tr3', createdAt: now, updatedAt: now, videoId: 'e2e-v3', source: 'manual_paste', status: 'success', rawText: 'hello', segments: [], format: 'plain' });
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
  try {
    const ctx = await browser.newContext({ ...devices['iPad (gen 7)'] });
    await ctx.route(/^https:\/\/(i\.ytimg\.com|www\.youtube(-nocookie)?\.com)\//, (r) => r.fulfill({ status: 200, body: '' }));
    const keys = [];
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
    ctx.on('request', (r) => {
      if (r.url().endsWith('/api/ai/extract')) keys.push({ key: r.headers()['idempotency-key'], body: r.postData() });
    });

    await page.goto(BASE);
    await page.locator('main').first().waitFor();
    await page.waitForTimeout(600);
    await seedVideos(page);
    const before = await dumpDb(page);
    check('준비: 새 기기 v3(30) + 테스트 영상 4개', before.version === 30 && before.tables.videos.filter((v) => v.id.startsWith('e2e-')).length === 4);

    await page.goto(`${BASE}/videos`);
    await page.getByText('이 영상 학습 시작').waitFor();
    const startedTitle = await page.getByTestId('queue-current-title').innerText();
    await page.getByText('이 영상 학습 시작').click();
    // 첫 생성 요청이 나갈 때까지
    for (let i = 0; i < 40 && keys.length === 0; i++) await page.waitForTimeout(250);
    check("'학습 시작'을 누르면 자막 추출 요청이 백그라운드로 시작", keys.length > 0, startedTitle);
    const mid = await dumpDb(page);
    check('진행 중 작업·요청 기록이 기기에 저장됨', mid.tables.extractionJobs.some((j) => j.status === 'running') && mid.tables.aiRequests.length >= 1);

    // 앱을 닫았다 연 것처럼 새로고침
    await page.reload();
    await page.locator('main').first().waitFor();
    await page.goto(`${BASE}/videos`);
    await page.getByTestId('extraction-status').waitFor({ timeout: 15000 });
    await page.screenshot({ path: `${SHOTS}/sB1b-01-extracting.png`, fullPage: true });

    // 완료까지 (가짜 Gemini: 영상당 조회 1~2번, 15초 간격)
    let done = null;
    for (let i = 0; i < 80; i++) {
      await page.waitForTimeout(2000);
      const d = await dumpDb(page);
      if (d.tables.extractionJobs.filter((j) => j.status === 'succeeded').length === 2) {
        done = d;
        break;
      }
    }
    check('새로고침 뒤에도 이어서 2개 영상 모두 완료', !!done);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/sB1b-02-done.png`, fullPage: true });
    const after = done ?? (await dumpDb(page));

    const distinct = [...new Set(keys.map((k) => k.key))];
    const perVideo = {};
    for (const k of keys) perVideo[JSON.parse(k.body).videoId] = new Set([...(perVideo[JSON.parse(k.body).videoId] ?? []), k.key]);
    check('영상마다 요청 식별자 1개 (새로고침 뒤에도 같은 식별자로 조회)', distinct.length === 2 && Object.values(perVideo).every((s) => s.size === 1), `요청 ${keys.length}번 · 식별자 ${distinct.length}개`);
    check('자막 있는 영상·긴 영상은 요청 없음', !perVideo.ccccccccccc && !perVideo.ddddddddddd);
    const jobs = byId(after.tables.extractionJobs);
    check('긴 영상은 건너뜀(긴 영상)으로 표시', jobs['job-e2e-v4']?.status === 'skipped' && jobs['job-e2e-v4']?.lastError?.code === 'too_long');
    check('결과는 검토 대기 초안 2개로 저장 (원본 텍스트 보존)', after.tables.extractionDrafts.length === 2 && after.tables.extractionDrafts.every((d) => d.status === 'pending_review' && d.rawText));
    check('요청 장부: 2건 모두 succeeded', after.tables.aiRequests.length === 2 && after.tables.aiRequests.every((r) => r.status === 'succeeded'));
    check('화면에 완료 개수 표시', /완료 2/.test(await page.getByTestId('extraction-counts').innerText()));

    // 기존 데이터 보존: '학습 시작'이 원래 바꾸는 값(시작한 영상의 학습 상태)과 학습 순서 설정 말고는 그대로
    for (const t of ['playlists', 'transcripts', 'expressionNotes', 'keySentences', 'dialogues', 'dialogueCompositions', 'expressions', 'reviewStates', 'dialogueProgress', 'studyLogs']) {
      check(`기존 ${t} 그대로`, same(byId(after.tables[t]), byId(before.tables[t])));
    }
    const bv = byId(before.tables.videos);
    const av = byId(after.tables.videos);
    const changed = Object.keys(bv).filter((id) => !same(bv[id], av[id]));
    const onlyStatus = changed.every((id) => {
      const { status: _s, updatedAt: _u, startedAt: _t, ...restB } = bv[id];
      const { status: _s2, updatedAt: _u2, startedAt: _t2, ...restA } = av[id];
      return same(restA, restB);
    });
    check("영상: '학습 시작'으로 바뀐 학습 상태·시작 시각 1개 말고는 그대로", changed.length <= 1 && onlyStatus && Object.keys(av).length === Object.keys(bv).length, changed.join(','));
    const metaKeys = (rows) => new Set(rows.map((m) => m.key));
    check('appMeta: 기존 키 유지, 새로 생긴 키는 extractionRun', [...metaKeys(before.tables.appMeta)].every((k) => metaKeys(after.tables.appMeta).has(k)) && [...metaKeys(after.tables.appMeta)].filter((k) => !metaKeys(before.tables.appMeta).has(k)).every((k) => k === 'extractionRun'));

    // 다시 시작해도 재요청 없음
    const n = keys.length;
    await page.goto(`${BASE}/videos`);
    await page.getByText('이 영상 학습 시작').first().click().catch(() => {});
    await page.waitForTimeout(3000);
    check('완료 뒤 다시 학습을 시작해도 추출 요청 없음 (저장된 결과 재사용)', keys.length === n);

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
