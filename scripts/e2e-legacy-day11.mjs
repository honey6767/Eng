/**
 * 예전 기준 Day 11 자료 E2E (Playwright, 새 임시 프로필, 가짜 Gemini — 실제 Google 호출 없음)
 * 사용법: npm run build && node scripts/e2e-legacy-day11.mjs
 *
 * 운영에서 실제로 만든 Day 11 자료와 같은 형태로 저장해 두고 확인한다:
 *   원문 문장 5개 · 문장 속 Chunk 9개(could use some help from, could seriously use …) · 핵심 Chunk 기록 없음
 * 1) 자막 추출 때 찾은 강사 표현(could use) 기록이 있을 때 + Day 11 자료 생성이 HTTP 502로 실패한 상태
 *    - 화면에서만 could use를 핵심 Chunk로, 활용형은 그 아래, 나머지는 추가 덩어리 표현
 *    - 통합 대화문 후보도 같은 구분
 *    - 앱을 열고 기다려도 실패한 작업을 자동으로 다시 요청하지 않음 (AI 요청 0)
 *    - 저장 데이터 그대로
 * 2) 강사 표현 기록도 없을 때: 공통 부분으로 추정 (추정이라고 표시)
 * 3) 결과를 아직 못 받은 요청이 남아 있을 때: 같은 요청 식별자·예전 요청 내용(dp1)으로 이어서 확인만
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const SHOTS = 'e2e-screenshots';
mkdirSync(SHOTS, { recursive: true });
const PORT = 4197;
const BASE = `http://localhost:${PORT}`;

function startServer() {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'pipe',
    env: { ...process.env, YOUTUBE_API_KEY: '', YOUTUBE_API_MOCK: '1', AI_GEMINI_MOCK: '1', GEMINI_API_KEY: '', YOUTUBE_QUOTA_FILE: join(tmpdir(), `mes-e2e-legacy-quota-${process.pid}.json`) },
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

// 운영 Day 11 실제 자료 (실제 Gemini 결과와 같은 문장·Chunk)
const SENT = ['I could seriously use a cup of coffee right now.', 'We could use some help from chatGPT.', 'You look super tired. You could use some rest.', 'I could use some advice on which car to buy.', "I didn't get much sleep last night. I could really use a nap."];
const CHUNKS = [['look super tired', 3], ['could use some advice on', 4], ['which car to buy', 4], ['could seriously use', 1], ['a cup of coffee', 1], ["didn't get much sleep", 5], ['could really use a nap', 5], ['could use some rest', 3], ['could use some help from', 2]];
const STORED_REQ = '3f1c2b7a-8d4e-4a51-9c3e-1b2d3e4f5a6b';

const seed = (page, opts) =>
  page.evaluate(
    ({ SENT, CHUNKS, opts, STORED_REQ }) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('my-english-study');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['videos', 'transcripts', 'keySentences', 'expressions', 'learningItems', 'appMeta'], 'readwrite');
          const now = '2026-11-16T09:00:00.000Z';
          tx.objectStore('videos').add({ id: 'd11', createdAt: now, updatedAt: now, playlistId: null, youtubeVideoId: 'eNODHkrNuDA', title: '[Day 11] 필요해 I need 말고', url: null, thumbnailUrl: null, durationSec: 300, orderIndex: 0, randomOrderKey: 0, status: 'learning', completedAt: null, sources: [{ kind: 'manual', addedAt: now }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
          const lines = ["Today's expression is could use.", ...SENT.map((s, i) => `${i + 1}. ${s}`)];
          tx.objectStore('transcripts').add({ id: 'tr-d11', createdAt: now, updatedAt: now, videoId: 'd11', source: 'ai_generated', status: 'success', rawText: lines.join('\n'), segments: lines.map((text, i) => ({ startSec: 41 + i * 10, endSec: 50 + i * 10, text })), format: 'timestamped' });
          SENT.forEach((s, i) => tx.objectStore('keySentences').add({ id: `ks-${i + 1}`, createdAt: now, updatedAt: now, videoId: 'd11', order: i + 1, aiNumber: i + 1, origin: 'ai_extracted', english: s, korean: `번역 ${i + 1}`, expressionIds: [], situation: '', timestampSec: 140 + i * 5, status: 'learning', correctCount: 0, wrongCount: 0 }));
          const li = (id, kind, expressionId, extra) => ({ id, kind, expressionId, videoId: 'd11', sourceType: 'day', dayNumber: 11, dialogueId: null, sourceText: null, timestampSec: null, onScreen: false, origin: 'ai_extracted', status: 'confirmed', extractionDraftId: null, legacyKeySentenceId: null, createdAt: now, updatedAt: now, ...extra });
          CHUNKS.forEach(([t, n], i) => {
            tx.objectStore('expressions').add({ id: `ex-c${i}`, createdAt: now, updatedAt: now, normalizedKey: t, text: t, meaningKo: `${t} 뜻`, sourceRefs: [], isFavorite: false, isMarkedDifficult: false });
            tx.objectStore('learningItems').add(li(`li-c${i}`, 'chunk', `ex-c${i}`, { sentenceId: `ks-${n}`, selected: t === 'could seriously use', chunk: { meaningInSentence: `${t} 뜻`, nuance: '뉘앙스', usage: '', comparison: '', examples: [], surface: t } }));
          });
          if (opts.key) {
            tx.objectStore('expressions').add({ id: 'ex-key', createdAt: now, updatedAt: now, normalizedKey: 'could use', text: 'could use', meaningKo: '~가 필요하다, ~했으면 좋겠다', sourceRefs: [], isFavorite: false, isMarkedDifficult: false });
            tx.objectStore('learningItems').add(li('li-key', 'key', 'ex-key', { sourceText: "Today's expression is could use.", timestampSec: 41 }));
          }
          const body = { task: 'daypack', videoId: 'eNODHkrNuDA', title: '[Day 11] 필요해 I need 말고', seriesKind: 'day', dayNumber: 11, sentences: SENT.map((text, i) => ({ number: i + 1, text, chunks: [] })), promptVersion: 'dp1' };
          if (opts.failed502) {
            tx.objectStore('appMeta').put({ key: 'prepState', value: { allStarted: true, queue: [], videos: { d11: { status: 'failed', stage: 'daypack', error: { code: 'gemini_failed', message: 'Gemini 응답을 받지 못했어요.', httpStatus: 502 }, attempts: 1, updatedAt: now } }, retry: [], pausedUntil: null, pauseReason: null, pauseMessage: null, updatedAt: now } });
            tx.objectStore('appMeta').put({ key: 'aiTasks', value: { 'daypack:d11': { requestId: STORED_REQ, body, status: 'failed', startedAt: now, updatedAt: now, resultText: null, error: { code: 'gemini_failed', message: 'Gemini 응답을 받지 못했어요.', httpStatus: 502 } } } });
          }
          if (opts.inflight) {
            tx.objectStore('appMeta').put({ key: 'prepState', value: { allStarted: false, queue: ['d11'], videos: {}, retry: [], pausedUntil: null, pauseReason: null, pauseMessage: null, updatedAt: now } });
            tx.objectStore('appMeta').put({ key: 'aiTasks', value: { 'daypack:d11': { requestId: STORED_REQ, body, status: 'sent', startedAt: now, updatedAt: now, resultText: null, error: null } } });
          }
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { SENT, CHUNKS, opts, STORED_REQ },
  );

async function openSeeded(browser, opts, sends, errors) {
  const ctx = await browser.newContext({ ...devices['iPad (gen 7)'] });
  await ctx.route(/^https:\/\/(i\.ytimg\.com|www\.youtube(-nocookie)?\.com)\//, (r) => r.fulfill({ status: 200, body: '' }));
  ctx.on('request', (r) => {
    if (!r.url().endsWith('/api/ai/extract')) return;
    const b = JSON.parse(r.postData() || '{}');
    sends.push({ task: b.task ?? 'extract', videoId: b.videoId, key: r.headers()['idempotency-key'], retry: !!b.retryFailed, promptVersion: b.promptVersion });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
  // 시드 전에 앱이 대기열을 돌리지 않게: 빈 페이지에서 DB만 만들고 시드 → 그 뒤 앱 열기
  await page.goto(`${BASE}/settings`);
  await page.locator('main').first().waitFor();
  await page.waitForTimeout(500);
  await seed(page, opts);
  return { ctx, page };
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  try {
    // ── 1) 강사 표현 기록 있음 + 502 실패 상태 ──
    const sends = [];
    const { ctx, page } = await openSeeded(browser, { key: true, failed502: true }, sends, errors);
    const before = await dumpDb(page);
    await page.goto(`${BASE}/videos/d11`);
    await page.getByTestId('core-chunks').waitFor();
    const core = await page.getByTestId('core-chunks').innerText();
    const coreLabel = await page.locator('[data-testid="core-chunk"] .en').first().innerText();
    check('핵심 Chunk 기록이 없어도 could use를 핵심 Chunk로 표시', /^could … use$|^could use$/.test(coreLabel) && (await page.getByTestId('core-chunk').count()) === 1, coreLabel);
    check('근거: 자막 추출 때 찾은 강사 표현 · 화면에서만 묶었다는 안내', (await page.locator('[data-testid="core-chunk"]').getAttribute('data-basis')) === 'key' && /화면에서만 묶었어요/.test(await page.getByTestId('core-inferred').innerText()));
    check('강의 설명 인용', /Today's expression is could use\./.test(await page.getByTestId('core-taught').innerText()));
    const occ = await page.getByTestId('core-occurrences').innerText();
    check('기존 활용형은 핵심 Chunk 아래 활용 사례로 (5문장 모두)', /활용 사례 5개/.test(occ) && /could seriously use/.test(occ) && /could really use/.test(occ), occ.replace(/\n/g, ' / ').slice(0, 300));
    check('기존 고름 표시 유지 (could seriously use ✓ 고름)', (await page.locator('[data-testid="select-variant"][aria-pressed="true"]').count()) === 1);
    const extraTexts = await page.locator('[data-testid="extra-chunks"] [data-testid="content-chunk"] > div > span.en').allInnerTexts();
    check('get much sleep 등 나머지는 추가 덩어리 표현으로 분리', extraTexts.length === 4 && extraTexts.some((t) => /get much sleep/.test(t)) && !extraTexts.some((t) => /\bcould\b/.test(t)), extraTexts.join(', '));
    check('추가 덩어리 표현 카드에 AI 추가 표시', /추가 덩어리 표현/.test(await page.getByTestId('extra-chunks').innerText()) && /AI 추가/.test(await page.getByTestId('extra-chunks').innerText()));
    check('개수 표시', /핵심 Chunk 1개 · 추가 표현 4개/.test(await page.getByTestId('content-counts').innerText()), await page.getByTestId('content-counts').innerText());
    await page.screenshot({ path: `${SHOTS}/legacy-01-day11.png`, fullPage: true });

    await page.goto(`${BASE}/dialogues/combine`);
    await page.getByTestId('combine-page').waitFor();
    const day11Card = page.locator('[data-testid="combine-page"] section').nth(1).locator('div.space-y-3 > div').filter({ hasText: 'Day 11' });
    const cands = await day11Card.locator('label').allInnerTexts();
    const variantCands = cands.filter((t) => /could (seriously|really) use|could use some/.test(t.split('\n')[0]));
    check('통합 대화문 후보: could use(핵심)·추가 표현 4개, 활용형은 따로 없음', cands.length === 5 && variantCands.length === 0 && cands.some((t) => /^could use/.test(t) && /핵심/.test(t)) && cands.filter((t) => /추가 · AI/.test(t)).length === 4, cands.map((t) => t.split('\n')[0]).join(' | '));
    check('활용형의 고름 표시는 could use 후보에 이어짐', cands.some((t) => /^could use/.test(t) && /고름/.test(t)));

    await page.goto(`${BASE}/extraction`);
    await page.getByTestId('prep-status').waitFor();
    await page.waitForTimeout(8000);
    const failText = (await page.getByTestId('prep-failed').count()) ? await page.getByTestId('prep-failed').innerText() : '';
    check('HTTP 502 실패는 실패 목록에 그대로 (자동 재시도 안 함)', /HTTP 502/.test(failText) && /gemini_failed/.test(failText), failText.split('\n').slice(0, 3).join(' / '));
    await page.reload();
    await page.getByTestId('prep-status').waitFor();
    await page.waitForTimeout(5000);
    check('앱을 열고 새로고침해도 AI 요청 0건 (중복 생성 없음)', sends.length === 0, JSON.stringify(sends));
    const after = await dumpDb(page);
    for (const t of ['videos', 'transcripts', 'keySentences', 'expressions', 'learningItems', 'dialogues', 'reviewStates']) check(`저장 데이터 그대로: ${t}`, same(before.tables[t], after.tables[t]));
    const meta = (d, k) => d.tables.appMeta.find((m) => m.key === k)?.value;
    check('실패 기록·요청 기록 그대로 (502 · 같은 요청 식별자)', same(meta(before, 'aiTasks'), meta(after, 'aiTasks')) && meta(after, 'prepState').videos.d11.error.httpStatus === 502);
    check('DB 버전 그대로', before.version === after.version, String(after.version));
    await ctx.close();

    // ── 2) 강사 표현 기록 없음: 공통 부분으로 추정 ──
    const sends2 = [];
    const c2 = await openSeeded(browser, { key: false }, sends2, errors);
    await c2.page.goto(`${BASE}/videos/d11`);
    await c2.page.getByTestId('core-chunks').waitFor();
    check('강사 표현 기록이 없으면 공통 부분 could use로 추정 (추정이라고 표시)', (await c2.page.locator('[data-testid="core-chunk"]').getAttribute('data-basis')) === 'common' && /추정/.test(await c2.page.getByTestId('core-inferred').innerText()) && /활용 사례 5개/.test(await c2.page.getByTestId('core-occurrences').innerText()));
    const extra2 = await c2.page.locator('[data-testid="extra-chunks"] [data-testid="content-chunk"] > div > span.en').allInnerTexts();
    check('이때도 나머지 4개는 추가 덩어리 표현', extra2.length === 4, extra2.join(', '));
    check('강의 설명 인용은 없으면 표시 안 함 (지어내지 않음)', (await c2.page.getByTestId('core-taught').count()) === 0);
    await c2.page.waitForTimeout(3000);
    check('AI 요청 0건', sends2.length === 0);
    await c2.page.screenshot({ path: `${SHOTS}/legacy-02-day11-common.png`, fullPage: true });
    await c2.ctx.close();

    // ── 3) 결과를 아직 못 받은 요청: 같은 식별자·예전 요청 내용으로 이어서 확인만 ──
    const sends3 = [];
    const c3 = await openSeeded(browser, { key: true, inflight: true }, sends3, errors);
    await c3.page.goto(`${BASE}/extraction`);
    await c3.page.getByTestId('prep-status').waitFor();
    await c3.page.waitForTimeout(6000);
    const keys = [...new Set(sends3.map((s) => s.key))];
    check('남은 요청은 같은 요청 식별자로 이어서 (새 식별자 없음)', sends3.length > 0 && keys.length === 1 && keys[0] === STORED_REQ, `${sends3.length}회 · ${keys.join(',')}`);
    check('이어서 보낼 때 예전 요청 내용(dp1) 그대로 · 다시 생성 표시 없음', sends3.every((s) => s.promptVersion === 'dp1' && !s.retry));
    await c3.ctx.close();

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
