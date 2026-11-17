/**
 * Chunk 교체 패턴 + Chunk별 AI 질문·기록 E2E (Playwright, 새 임시 프로필, 가짜 Gemini — 실제 Google 호출 없음)
 * 사용법: npm run build && node scripts/e2e-qa.mjs
 *
 * 운영 Day 11과 같은 형태의 예전 자료(핵심 Chunk 기록 없음, 추가 표현 4개)로 확인한다:
 * - 추가 덩어리 표현: 기본 Chunk·원문 표현·교체 패턴·활용 예시(한국어 뜻·뜻 차이) — 화면에서만 보완
 * - Chunk별 질문: 문맥 전달, 후속 질문 이어받기(같은 Chunk만), 다른 Chunk와 섞이지 않음, 실패 시 자동 재시도 없음, 다시 시도
 * - 자동 저장·새로고침 뒤 유지, 질문 기록 탭(필터·검색·전체 보기·이어서 질문·답변 복사)
 * - 학습 DB(버전 30)와 기존 자료는 그대로, 질문 기록은 별도 DB
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

const asks = (sends) => sends.filter((s) => s.task === 'ask');
const card = (page, text) => page.locator('[data-testid="content-chunk"], [data-testid="core-chunk"]').filter({ has: page.locator(`[data-testid="chunk-base"]:text-is("${text}"), .en:text-is("${text}")`) }).first();

async function askOn(page, scope, question) {
  if (await scope.getByTestId('qa-open').count()) await scope.getByTestId('qa-open').click();
  const box = scope.getByTestId('qa-box');
  await box.getByTestId('qa-input').fill(question);
  const before = await box.getByTestId('qa-turn').count();
  await box.getByTestId('qa-send').click();
  await waitFor(async () => (await box.getByTestId('qa-turn').count()) > before && (await box.locator('[data-testid="qa-turn"]').last().getAttribute('data-status')) !== 'pending', 60, 500);
  return box;
}

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

    // ── B. Chunk별 AI 질문 ──
    const whichCard = extra('which car to buy');
    let box = await askOn(page, whichCard, '이 단어 대신 다른 단어를 넣어도 돼?');
    let a1 = asks(sends);
    check('질문 1번 = 요청 1개 (요청 식별자 1개)', a1.length >= 1 && new Set(a1.map((s) => s.key)).size === 1, `${a1.length}회`);
    const b1 = a1[0].body;
    check('Chunk 문맥 전달: 출처·Day·구분·기본 Chunk·원문 문장·뜻·교체 패턴·활용 예시', b1.context.base === 'which car to buy' && b1.context.role === 'extra' && b1.context.dayNumber === 11 && /Day 11/.test(b1.context.source) && /which car to buy/.test(b1.context.sentences?.[0] ?? '') && /which \+ 명사 \+ to buy/.test(b1.context.pattern ?? '') && b1.context.examples?.length === 3 && !!b1.context.meaningKo, JSON.stringify(b1.context).slice(0, 200));
    const ans1 = (await box.getByTestId('qa-answer').first().innerText()).replace(/\s+/g, ' ');
    check('답변: 문법 / 회화 자연스러움 / 뉘앙스 / 예문 구분, AI 설명 표시', ['1. 문법', '2. 회화 자연스러움', '3. 의미·뉘앙스', '4. 예문', 'AI 설명'].every((k) => ans1.includes(k)), ans1.slice(0, 120));
    box = await askOn(page, whichCard, '원어민은 어떤 상황에서 써?');
    const b2 = asks(sends).at(-1).body;
    check('후속 질문: 같은 세션·이전 질문 이어받음 (요약만)', b2.sessionId === b1.sessionId && b2.turn === 2 && b2.history.length === 1 && b2.history[0].question === '이 단어 대신 다른 단어를 넣어도 돼?' && /요약/.test(b2.history[0].answer));
    check('후속 답변이 이전 대화를 이어받음', /이전 질문 1개에 이어서/.test(await box.locator('[data-testid="qa-turn"]').last().innerText()));

    const tiredCard = extra('look tired');
    await askOn(page, tiredCard, 'look sleepy도 자연스러운 표현이야?');
    const b3 = asks(sends).at(-1).body;
    check('다른 Chunk 대화는 섞이지 않음 (새 세션, 이전 대화 없음, 원문 표현 전달)', b3.sessionId !== b1.sessionId && b3.history.length === 0 && b3.context.base === 'look tired' && b3.context.original === 'look super tired');

    const coreCard = page.getByTestId('core-chunk').first();
    const coreBox = await askOn(page, coreCard, 'need랑 어떤 차이가 있어?');
    const b4 = asks(sends).at(-1).body;
    check('핵심 Chunk 질문: 구분 core · 강의 설명 전달', b4.context.role === 'core' && /Today's expression is could use/.test(b4.context.taught ?? ''));
    check('강의 내용과 AI 설명 구분 표시', (await coreBox.getByTestId('qa-lecture').count()) === 1 && /강의에서 배운 내용/.test(await coreBox.getByTestId('qa-lecture').innerText()));

    // 실패: 자동 재시도 없음 → 다시 시도
    const nFail0 = asks(sends).length;
    const failBox = await askOn(page, tiredCard, '[실패] 이 질문은 실패해야 해요');
    const failed = failBox.locator('[data-testid="qa-turn"][data-status="failed"]');
    check('실패 상태와 오류 코드 표시', (await failed.count()) === 1 && /gemini_failed/.test(await failed.innerText()));
    const failKeys = new Set(asks(sends).slice(nFail0).map((s) => s.key));
    await page.waitForTimeout(5000);
    check('실패 후 자동 재시도 없음 (기다려도 새 요청 없음)', asks(sends).slice(nFail0).every((s) => failKeys.has(s.key)), `${asks(sends).length - nFail0}회`);
    const nRetry0 = asks(sends).length;
    await failed.getByTestId('qa-retry').click();
    await waitFor(async () => asks(sends).length > nRetry0 && (await failBox.locator('[data-testid="qa-turn"]').last().getAttribute('data-status')) !== 'pending', 60, 500);
    const retried = asks(sends).slice(nRetry0);
    check('다시 시도를 눌러야만 새 요청 (첫 요청에만 다시 생성 표시)', retried.length > 0 && retried[0].retry && !failKeys.has(retried[0].key) && retried.slice(1).every((s) => !s.retry));

    // 중복 요청 방지: 보내는 동안 버튼 잠김
    await tiredCard.getByTestId('qa-input').fill('두 번 눌러도 한 번만');
    const nDup0 = asks(sends).length;
    await tiredCard.getByTestId('qa-send').click();
    await tiredCard.getByTestId('qa-send').click({ force: true, timeout: 1000 }).catch(() => {});
    await waitFor(async () => (await tiredCard.locator('[data-testid="qa-turn"]').last().getAttribute('data-status')) === 'answered', 60, 500);
    const dup = asks(sends).slice(nDup0);
    check('두 번 눌러도 질문 1개·요청 식별자 1개', new Set(dup.map((s) => s.key)).size === 1 && (await tiredCard.locator('[data-testid="qa-question"]', { hasText: '두 번 눌러도 한 번만' }).count()) === 1);

    // 새로고침: 자동 요청 없음, 기록 유지
    const nReload = asks(sends).length;
    await page.reload();
    await page.getByTestId('core-chunks').waitFor();
    await page.waitForTimeout(3000);
    check('새로고침해도 AI 질문 요청 없음', asks(sends).length === nReload);
    await extra('which car to buy').getByTestId('qa-open').click();
    check('새로고침 뒤에도 질문·답변 기록 유지', (await extra('which car to buy').getByTestId('qa-turn').count()) === 2 && /질문 기록 2개|질문 기록/.test(await extra('which car to buy').innerText()));

    // ── C. 질문 기록 탭 ──
    await page.goto(`${BASE}/more`);
    check('더보기에 AI 질문 기록 메뉴', await waitFor(async () => (await page.getByRole('link', { name: /AI 질문 기록/ }).count()) > 0, 20, 250));
    await page.getByRole('link', { name: /AI 질문 기록/ }).first().click();
    await page.getByTestId('ai-questions-page').waitFor();
    await page.getByTestId('qa-session').first().waitFor();
    const sessions = await page.getByTestId('qa-session').allInnerTexts();
    check('대화(Chunk)별로 최신 질문 순', sessions.length === 3 && /look tired/.test(sessions[0]), sessions.map((s) => s.split('\n')[0]).join(' | '));
    check('Day·Chunk·구분 표시', /Day 11/.test(sessions[0]) && sessions.some((s) => /핵심 Chunk/.test(s)) && sessions.some((s) => /추가 덩어리 표현/.test(s)));
    await page.getByTestId('qa-filter-chunk').selectOption({ label: 'which car to buy' });
    check('Chunk 필터', (await page.getByTestId('qa-session').count()) === 1);
    await page.getByTestId('qa-filter-chunk').selectOption('');
    await page.getByTestId('qa-filter-day').selectOption('11');
    check('Day 필터', (await page.getByTestId('qa-session').count()) === 3);
    await page.getByTestId('qa-search').fill('sleepy');
    check('검색', (await page.getByTestId('qa-session').count()) === 1 && /look tired/.test(await page.getByTestId('qa-session').innerText()));
    await page.getByTestId('qa-search').fill('');
    await page.getByTestId('qa-filter-chunk').selectOption({ label: 'which car to buy' });
    await page.getByTestId('qa-session-toggle').first().click();
    const histBox = page.getByTestId('qa-session').first();
    await waitFor(async () => (await histBox.getByTestId('qa-answer').count()) === 2, 20, 250);
    check('질문과 답변 전체 확인', (await histBox.getByTestId('qa-turn').count()) === 2 && (await histBox.getByTestId('qa-answer').count()) === 2);
    await histBox.getByTestId('qa-copy').first().click();
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    check('답변 복사', /^Q\. 이 단어 대신/.test(clip) && /1\. 문법/.test(clip), clip.slice(0, 60));
    const nCont = asks(sends).length;
    await histBox.getByTestId('qa-input').fill('기록 화면에서 이어서 질문');
    await histBox.getByTestId('qa-send').click();
    await waitFor(async () => (await histBox.getByTestId('qa-turn').count()) === 3 && (await histBox.locator('[data-testid="qa-turn"]').last().getAttribute('data-status')) === 'answered', 60, 500);
    const b5 = asks(sends).at(-1)?.body;
    check('기록 탭에서 기존 대화에 이어서 질문', asks(sends).length > nCont && b5.sessionId === b1.sessionId && b5.turn === 3 && b5.history.length === 2);
    await page.screenshot({ path: `${SHOTS}/qa-02-history.png`, fullPage: true });

    // ── D. 데이터 보존 ──
    const after = await dumpDb(page);
    for (const t of ['videos', 'transcripts', 'keySentences', 'expressions', 'learningItems', 'dialogues', 'reviewStates', 'dialogueProgress']) check(`학습 DB 그대로: ${t}`, same(before.tables[t], after.tables[t]));
    {
      // studyQueue(학습 순서)는 기존 기능이 시드한 영상을 순서에 넣은 것 — 질문 기능과 무관. 나머지 appMeta는 그대로여야 한다
      const meta = (d) => Object.fromEntries(d.tables.appMeta.filter((m) => m.key !== 'studyQueue').map((m) => [m.key, m.value]));
      const aiTasks = after.tables.appMeta.find((m) => m.key === 'aiTasks')?.value ?? {};
      check('학습 DB 그대로: appMeta (자료 생성 요청 기록·실패 기록 포함, 질문 요청은 여기 저장 안 함)', same(meta(before), meta(after)) && !Object.keys(aiTasks).some((k) => k.startsWith('ask:')));
    }
    check('학습 DB 버전 30 그대로', before.version === 30 && after.version === 30, String(after.version));
    const qa = await page.evaluate(() => new Promise((resolve) => {
      const r = indexedDB.open('my-english-study-ai-qa');
      r.onsuccess = () => {
        const db = r.result;
        const tx = db.transaction(['turns', 'sessions'], 'readonly');
        const out = {};
        tx.objectStore('turns').getAll().onsuccess = (e) => (out.turns = e.target.result);
        tx.objectStore('sessions').getAll().onsuccess = (e) => (out.sessions = e.target.result);
        tx.oncomplete = () => { db.close(); resolve(out); };
      };
    }));
    check('질문 기록은 별도 DB에 저장 (질문·답변·시간·Day·Chunk·세션·후속 관계)', qa.sessions.length === 3 && qa.turns.length === 7 && qa.turns.every((t) => t.question && t.createdAt && t.sessionId && t.chunkKey && t.dayNumber === 11) && qa.turns.some((t) => t.parentTurnId));
    check('Day 11 실패 요청은 자동 재시도 안 함 (자료 생성 요청 0)', sends.filter((s) => s.task !== 'ask').length === 0);
    await ctx.close();

    // ── 휴대폰 화면 ──
    const phone = await openSeeded(browser, { key: true, device: 'iPhone 13' }, [], errors);
    await phone.page.goto(`${BASE}/videos/d11`);
    await phone.page.getByTestId('core-chunks').waitFor();
    await phone.page.locator('[data-testid="extra-chunks"] [data-testid="qa-open"]').first().click();
    check('휴대폰: Chunk 화면·질문창 가로 넘침 없음', await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await phone.page.goto(`${BASE}/ai-questions`);
    await phone.page.getByTestId('ai-questions-page').waitFor();
    check('휴대폰: 질문 기록 화면 가로 넘침 없음', await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
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
