/**
 * Chunk 교체 패턴 E2E + AI 질문 기능 제외 확인 (Playwright, 새 임시 프로필, 가짜 Gemini — 실제 Google 호출 없음)
 * 사용법: npm run build && node scripts/e2e-qa.mjs
 *
 * 운영 Day 11과 같은 형태의 예전 자료(핵심 Chunk 기록 없음, 추가 표현 4개)로 확인한다:
 * - 추가 덩어리 표현: 기본 Chunk·원문 표현·교체 패턴·활용 예시(한국어 뜻·뜻 차이) — 화면에서만 보완
 * - AI 질문 기능은 최종 배포에서 제외: Chunk 카드의 질문창·질문 기록 메뉴·화면 없음, 질문 요청 없음
 * - 예전에 저장된 질문 기록(별도 DB)은 지우지 않고 그대로
 * - 학습 DB(버전 30)와 기존 자료는 그대로
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
const PORT = 4196;
const BASE = `http://localhost:${PORT}`;

function startServer() {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'pipe',
    env: { ...process.env, YOUTUBE_API_KEY: '', YOUTUBE_API_MOCK: '1', AI_GEMINI_MOCK: '1', GEMINI_API_KEY: '', YOUTUBE_QUOTA_FILE: join(tmpdir(), `mes-e2e-qa-quota-${process.pid}.json`) },
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
  const ctx = await browser.newContext({ ...devices[opts.device ?? 'iPad (gen 7)'], permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.route(/^https:\/\/(i\.ytimg\.com|www\.youtube(-nocookie)?\.com)\//, (r) => r.fulfill({ status: 200, body: '' }));
  ctx.on('request', (r) => {
    if (!r.url().endsWith('/api/ai/extract')) return;
    const b = JSON.parse(r.postData() || '{}');
    sends.push({ task: b.task ?? 'extract', videoId: b.videoId, key: r.headers()['idempotency-key'], retry: !!b.retryFailed, promptVersion: b.promptVersion, body: b });
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

async function waitFor(fn, tries = 120, ms = 1000) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, ms));
  }
  return false;
}

const card = (page, text) => page.locator('[data-testid="content-chunk"], [data-testid="core-chunk"]').filter({ has: page.locator(`[data-testid="chunk-base"]:text-is("${text}"), .en:text-is("${text}")`) }).first();

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  try {
    const sends = [];
    const { ctx, page } = await openSeeded(browser, { key: true, failed502: true }, sends, errors);
    const before = await dumpDb(page);
    await page.goto(`${BASE}/videos/d11`);
    await page.getByTestId('core-chunks').waitFor();
    await page.waitForTimeout(1500);

    // ── A. 추가 덩어리 표현: 기본 Chunk · 교체 패턴 · 활용 예시 ──
    const extra = (t) => page.locator('[data-testid="extra-chunks"] [data-testid="content-chunk"]').filter({ has: page.locator(`[data-testid="chunk-base"]:text-is("${t}")`) });
    const pat = async (t) => ((await extra(t).getByTestId('chunk-pattern').count()) ? (await extra(t).getByTestId('chunk-pattern').innerText()).replace(/\s+/g, ' ') : '');
    const which = await pat('which car to buy');
    check('which car to buy: 기본 Chunk 그대로, 교체 패턴 which + 명사 + to buy, 자리 설명', (await extra('which car to buy').count()) === 1 && /which \+ 명사 \+ to buy/.test(which) && /사려는 물건/.test(which), which);
    check('which: 활용 예시와 한국어 뜻', ['which phone to buy — 어떤 폰을 살지', 'which laptop to buy — 어떤 노트북을 살지', 'which one to buy — 어떤 것을 살지'].every((x) => which.includes(x)));
    const sleep = await pat("didn't get much sleep");
    check("didn't get much sleep: 패턴 + rest·exercise 예시 + 뜻 차이", /didn't get much \+ 불가산명사/.test(sleep) && /didn't get much rest — 휴식을 별로 취하지 못했다/.test(sleep) && /didn't get much exercise — 운동을 별로 하지 못했다/.test(sleep) && /뜻 차이/.test(sleep), sleep.slice(0, 160));
    const cup = await pat('a cup of coffee');
    check('a cup of coffee: a cup of + 명사 (음료) · 차 한 잔 · 핫초코 한 잔', /a cup of \+ 명사/.test(cup) && /음료/.test(cup) && /a cup of tea — 차 한 잔/.test(cup) && /a cup of hot chocolate — 핫초코 한 잔/.test(cup), cup.slice(0, 120));
    const tired = await pat('look tired');
    const origin = (await extra('look tired').getByTestId('chunk-origin').innerText()).replace(/\s+/g, ' ');
    check('look super tired → 기본 Chunk look tired · 원문 표현 · 뺀 말 super · look + 형용사', /look super tired/.test(origin) && /super/.test(origin) && /look \+ 형용사/.test(tired) && /look happy — 행복해 보이다/.test(tired) && /look familiar — 낯익어 보이다/.test(tired) && /look busy — 바빠 보이다/.test(tired));
    check('예전 자료는 검토된 틀로 화면에서만 보완 표시', (await page.locator('[data-testid="chunk-pattern"][data-source="app"]').count()) === 4);
    check('교체 자리를 칩으로 구분', (await page.getByTestId('pattern-slot').count()) >= 4);
    check('화면을 열기만 해서는 AI 요청 없음', sends.length === 0, JSON.stringify(sends.map((s) => s.task)));
    await page.screenshot({ path: `${SHOTS}/qa-01-patterns.png`, fullPage: true });

    // ── B. AI 질문 기능 제외 ──
    check('Chunk 카드에 AI 질문창 없음', (await page.locator('[data-testid="qa-open"], [data-testid="qa-box"], [data-testid="qa-input"]').count()) === 0);
    // 예전에 저장된 질문 기록(별도 DB)을 흉내 내어 넣고, 앱이 지우지 않는지 확인
    const legacyQa = await page.evaluate(() => new Promise((resolve) => {
      // 앱(Dexie 버전 1 = IndexedDB 버전 10)이 만드는 것과 같은 표·색인 구성 — 예전 빌드를 쓰던 기기의 DB와 같은 모양
      const r = indexedDB.open('my-english-study-ai-notes', 10);
      r.onupgradeneeded = () => {
        const db = r.result;
        const mk = (name, keyPath, idx) => { if (!db.objectStoreNames.contains(name)) { const st = db.createObjectStore(name, { keyPath }); for (const i of idx) st.createIndex(i, i); } };
        mk('sessions', 'id', ['chunkKey', 'videoId', 'dayNumber', 'updatedAt']);
        mk('turns', 'id', ['sessionId', 'chunkKey', 'videoId', 'dayNumber', 'createdAt', 'status']);
        mk('tasks', 'key', []);
        mk('phraseSets', 'dialogueId', []);
        mk('phraseAttempts', 'id', ['dialogueId', 'at']);
      };
      r.onerror = () => resolve(`open-error: ${r.error}`);
      r.onsuccess = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('sessions') || !db.objectStoreNames.contains('turns')) { db.close(); resolve('no-stores'); return; }
        const tx = db.transaction(['sessions', 'turns'], 'readwrite');
        const T = '2026-11-10T00:00:00.000Z';
        tx.objectStore('sessions').put({ id: 'legacy-s1', chunkKey: 'li-x', chunkLabel: 'look tired', role: 'extra', videoId: 'd11', videoTitle: 'Day 11', dayNumber: 11, context: { source: 'Day 11', dayNumber: 11, role: 'extra', base: 'look tired' }, createdAt: T, updatedAt: T, turnCount: 1 });
        tx.objectStore('turns').put({ id: 'legacy-t1', sessionId: 'legacy-s1', turn: 1, parentTurnId: null, question: '예전 질문', status: 'answered', answer: null, error: null, requestId: 'r-old', chunkKey: 'li-x', chunkLabel: 'look tired', videoId: 'd11', dayNumber: 11, history: [], createdAt: T, answeredAt: T });
        tx.oncomplete = () => { db.close(); resolve('ok'); };
      };
    }));
    check('별도 DB에 예전 질문 기록 표가 그대로 있음 (sessions · turns)', legacyQa === 'ok', String(legacyQa));
    await page.goto(`${BASE}/more`);
    await page.waitForTimeout(800);
    check('더보기에 AI 질문 기록 메뉴 없음', (await page.getByRole('link', { name: /AI 질문 기록/ }).count()) === 0);
    check('사이드 메뉴에 AI 질문 기록 없음', (await page.locator('nav a', { hasText: 'AI 질문 기록' }).count()) === 0);
    await page.goto(`${BASE}/ai-questions`);
    await page.waitForTimeout(800);
    check('질문 기록 화면 없음 (주소로 들어가도 열리지 않음)', (await page.getByTestId('ai-questions-page').count()) === 0);
    await page.goto(`${BASE}/videos/d11`);
    await page.getByTestId('core-chunks').waitFor();
    await page.reload();
    await page.getByTestId('core-chunks').waitFor();
    await page.waitForTimeout(3000);
    check('새로고침해도 AI 요청 없음', sends.length === 0, JSON.stringify(sends.map((s) => s.task)));
    check('새로고침 뒤에도 교체 패턴 표시 유지', (await page.locator('[data-testid="chunk-pattern"][data-source="app"]').count()) === 4);

    // ── D. 데이터 보존 ──
    const after = await dumpDb(page);
    for (const t of ['videos', 'transcripts', 'keySentences', 'expressions', 'learningItems', 'dialogues', 'reviewStates', 'dialogueProgress']) check(`학습 DB 그대로: ${t}`, same(before.tables[t], after.tables[t]));
    {
      // studyQueue(학습 순서)는 기존 기능이 시드한 영상을 순서에 넣은 것 — 질문 기능과 무관. 나머지 appMeta는 그대로여야 한다
      const meta = (d) => Object.fromEntries(d.tables.appMeta.filter((m) => m.key !== 'studyQueue').map((m) => [m.key, m.value]));
      const aiTasks = after.tables.appMeta.find((m) => m.key === 'aiTasks')?.value ?? {};
      check('학습 DB 그대로: appMeta (자료 생성 요청 기록·실패 기록 포함)', same(meta(before), meta(after)) && !Object.keys(aiTasks).some((k) => k.startsWith('ask:')));
    }
    check('학습 DB 버전 30 그대로', before.version === 30 && after.version === 30, String(after.version));
    const qa = await page.evaluate(() => new Promise((resolve) => {
      const r = indexedDB.open('my-english-study-ai-notes');
      r.onerror = () => resolve({ sessions: [], turns: [] });
      r.onsuccess = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('sessions') || !db.objectStoreNames.contains('turns')) { db.close(); resolve({ sessions: [], turns: [] }); return; }
        const tx = db.transaction(['turns', 'sessions'], 'readonly');
        const out = {};
        tx.objectStore('turns').getAll().onsuccess = (e) => (out.turns = e.target.result);
        tx.objectStore('sessions').getAll().onsuccess = (e) => (out.sessions = e.target.result);
        tx.oncomplete = () => { db.close(); resolve(out); };
      };
    }));
    check('예전 질문 기록은 지워지지 않고 그대로 (새로고침·화면 이동 뒤)', qa.sessions.length === 1 && qa.turns.length === 1 && qa.turns[0].question === '예전 질문' && qa.sessions[0].id === 'legacy-s1');
    check('Day 11 실패 요청은 자동 재시도 안 함 (AI 요청 0)', sends.length === 0);
    await ctx.close();

    // ── 휴대폰 화면 ──
    const phone = await openSeeded(browser, { key: true, device: 'iPhone 13' }, [], errors);
    await phone.page.goto(`${BASE}/videos/d11`);
    await phone.page.getByTestId('core-chunks').waitFor();
    await phone.page.getByTestId('chunk-pattern').first().waitFor();
    check('휴대폰: Chunk·교체 패턴 화면 가로 넘침 없음', await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await phone.ctx.close();

    check('브라우저 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.kill();
  }
  const failedN = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failedN.length}/${results.length} 통과`);
  process.exit(failedN.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
