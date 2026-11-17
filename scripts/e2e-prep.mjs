/**
 * 학습 자료 자동 생성 E2E (Playwright, 새 임시 프로필, 가짜 YouTube·가짜 Gemini — 실제 Google 호출 없음)
 * 사용법: npm run build && node scripts/e2e-prep.mjs
 *
 * 영상 등록 → 자동 대기열 → 순차 생성 → 저장 → 학습
 * - 기존 영상은 '기존 영상 자료 만들기 시작'을 누르기 전에는 처리하지 않음
 * - 누락분만 보완 (문장이 있으면 공통 Chunk·대화문만), 이미 있는 자료는 다시 만들지 않음
 * - could … use (사이 부사 허용) 공통 Chunk, Day 통합 대화문(원문 출처·한국어·Chunk 설명), 빈칸 5단계 암기
 * - 실패만 다시 시도, 새로고침(앱 다시 열기) 뒤 같은 요청 식별자로 이어서, 다른 기기는 보관 결과 재사용
 * - 기존 데이터 그대로, DB 버전 그대로, 휴대폰 화면
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
const PORT = 4199;
const BASE = `http://localhost:${PORT}`;

function startServer() {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'pipe',
    // 가짜 YouTube 사용량은 파일에 쌓이므로 실행마다 새 파일 (오늘 다른 점검에서 쓴 양과 섞이지 않게)
    env: { ...process.env, YOUTUBE_API_KEY: '', YOUTUBE_API_MOCK: '1', AI_GEMINI_MOCK: '1', GEMINI_API_KEY: '', YOUTUBE_QUOTA_FILE: join(tmpdir(), `mes-e2e-prep-quota-${process.pid}.json`) },
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

const DAY11 = ['Welcome to Day 11.', "Today's expression is could use. It sounds softer than need.", '1. I could seriously use a cup of coffee right now.', '2. We could use some help.', '3. You look super tired. You could use some rest.', '4. I could really use a nap.', 'See you!'];

const seed = (page, day11) =>
  page.evaluate(
    (day11) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('my-english-study');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['videos', 'transcripts', 'keySentences', 'expressions', 'reviewStates', 'dialogues', 'dialogueProgress'], 'readwrite');
          const now = '2026-11-16T09:00:00.000Z';
          const v = (id, yt, title, i, dur = 300) => ({ id, createdAt: now, updatedAt: now, playlistId: null, youtubeVideoId: yt, title, url: null, thumbnailUrl: null, durationSec: dur, orderIndex: i, randomOrderKey: i / 10, status: 'new', completedAt: null, sources: [{ kind: 'manual', addedAt: now }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
          const tr = (vid, lines) => ({ id: `tr-${vid}`, createdAt: now, updatedAt: now, videoId: vid, source: 'manual_paste', status: 'success', rawText: lines.join('\n'), segments: lines.map((text, i) => ({ startSec: i * 10, endSec: i * 10 + 9, text })), format: 'timestamped' });
          const vs = tx.objectStore('videos');
          vs.add(v('d11', 'eNODHkrNuDA', '[Day 11] 필요해 I need 말고', 0));
          vs.add(v('d12', 'bbbbbbbbbbb', '[Day 12] 좋은 생각이야', 1));
          vs.add(v('d13', 'ccccccccccc', '[Day 13] 자막 없음', 2));
          vs.add(v('bad', 'mockFail001', '[Day 14] 실패하는 영상', 3));
          vs.add(v('long', 'ddddddddddd', '[Day 15] 긴 영상', 4, 32400));
          const ts = tx.objectStore('transcripts');
          ts.add(tr('d11', day11));
          ts.add(tr('d12', ['Day 12.', '1. That sounds like a good idea.', '2. We should catch up soon.']));
          ts.add(tr('bad', ['1. I could use a break.']));
          // 운영 Day 11처럼 원문 문장은 이미 있음 (대화문은 없음)
          const ks = tx.objectStore('keySentences');
          day11.filter((l) => /^\d+\./.test(l)).forEach((line, i) => ks.add({ id: `ks-old-${i + 1}`, createdAt: now, updatedAt: now, videoId: 'd11', order: i + 1, english: line.replace(/^\d+\.\s*/, ''), korean: `기존 번역 ${i + 1}`, expressionIds: [], situation: '', timestampSec: (i + 1) * 10, status: 'learning', correctCount: 1, wrongCount: 0, origin: 'ai_extracted', aiNumber: i + 1, selected: i === 0 }));
          // 기존 사용자 데이터
          tx.objectStore('expressions').add({ id: 'ex-user-1', createdAt: now, updatedAt: now, normalizedKey: 'could use', text: 'could use', meaningKo: '내가 쓴 뜻', sourceRefs: [], isFavorite: true, isMarkedDifficult: true });
          tx.objectStore('reviewStates').add({ id: 'expression:ex-user-1', createdAt: now, updatedAt: now, itemType: 'expression', itemId: 'ex-user-1', stage: 2, nextReviewAt: now, lastReviewedAt: now, weakness: 1, history: [] });
          tx.objectStore('dialogues').add({ id: 'dlg-user-1', createdAt: now, updatedAt: now, kind: 'original', videoId: 'd12', sourceVideoIds: [], orderInVideo: 1, title: '기존 대화문', situation: '기존', lines: [], expressionIds: [], generatedBy: 'manual', isFavorite: true });
          tx.objectStore('dialogueProgress').add({ id: 'dlg-user-1', dialogueId: 'dlg-user-1', currentStep: 3, highestCompletedStep: 2, stepResults: [], memorized: false, memorizedAt: null, blankMastery: {}, updatedAt: now });
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    day11,
  );

async function waitFor(fn, tries = 120, ms = 1000) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, ms));
  }
  return false;
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  const sends = [];
  try {
    const ctx = await browser.newContext({ ...devices['iPad (gen 7)'] });
    await ctx.route(/^https:\/\/(i\.ytimg\.com|www\.youtube(-nocookie)?\.com)\//, (r) => r.fulfill({ status: 200, body: '' }));
    ctx.on('response', async (r) => {
      if (!r.url().endsWith('/api/ai/extract')) return;
      const b = JSON.parse(r.request().postData() || '{}');
      sends.push({ task: b.task ?? 'extract', videoId: b.videoId, key: r.request().headers()['idempotency-key'], retry: !!b.retryFailed, status: r.status(), state: (await r.json().catch(() => ({}))).state });
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));

    await page.goto(BASE);
    await page.locator('main').first().waitFor();
    await page.waitForTimeout(600);
    await seed(page, DAY11);
    const before = await dumpDb(page);

    // ── 앱을 열어도 기존 영상은 처리하지 않음 (수동 시작) ──
    await page.goto(`${BASE}/extraction`);
    await page.getByTestId('prep-status').waitFor();
    await page.waitForTimeout(1500);
    check('기존 영상은 시작 전에는 처리 안 함 (AI 요청 0)', sends.length === 0, await page.getByTestId('prep-counts').innerText());

    // ── 새 영상 등록 → 자동 대기열 → 생성 ──
    await page.goto(`${BASE}/videos`);
    await page.getByLabel('YouTube URL').fill('https://www.youtube.com/watch?v=mocksolo001');
    await page.getByRole('button', { name: '등록', exact: true }).click();
    const newDone = await waitFor(async () => (await dumpDb(page)).tables.dialogues.some((d) => d.generatedBy === 'ai' && d.sourceVideoIds?.length && !['d11', 'd12', 'd13'].includes(d.videoId)), 90);
    check('새 영상 등록만으로 자동 생성: 자막 → 문장·Chunk·공통 Chunk·대화문 저장', newDone, sends.filter((s) => s.videoId === 'mocksolo001').map((s) => s.task).filter((t, i, a) => a.indexOf(t) === i).join('→'));
    check('기존 영상은 여전히 처리 안 함', !sends.some((s) => ['eNODHkrNuDA', 'bbbbbbbbbbb', 'ccccccccccc'].includes(s.videoId)));

    // ── 기존 영상 자료 만들기 시작 ──
    await page.goto(`${BASE}/extraction`);
    await page.getByTestId('prep-start-all').click();
    // 중간에 새로고침(앱 다시 열기) — 같은 요청 식별자로 이어서
    await waitFor(async () => sends.some((s) => s.task === 'pack' && s.videoId === 'bbbbbbbbbbb'), 60, 500);
    await page.reload();
    await page.locator('main').first().waitFor();
    const allDone = await waitFor(async () => {
      const t = (await page.getByTestId('prep-counts').count()) ? await page.getByTestId('prep-counts').innerText() : '';
      return /대기 0/.test(t);
    }, 150);
    const counts = await page.getByTestId('prep-counts').innerText();
    check('기존 영상 차례로 처리 완료 (긴 영상은 건너뜀, 실패 1)', allDone && /실패 1/.test(counts) && /건너뜀 1/.test(counts), counts);
    const order = [...new Set(sends.filter((s) => s.task !== 'extract' || s.videoId !== 'mocksolo001').map((s) => s.videoId))].filter((v) => v !== 'mocksolo001');
    check('Day 번호 순으로 처리', order.join(',') === 'eNODHkrNuDA,bbbbbbbbbbb,ccccccccccc,mockFail001', order.join(','));
    const keysPer = (task, vid) => new Set(sends.filter((s) => s.task === task && s.videoId === vid).map((s) => s.key)).size;
    check('새로고침 뒤에도 같은 요청 식별자로 이어서 (영상·단계마다 식별자 1개)', keysPer('pack', 'bbbbbbbbbbb') === 1 && keysPer('daypack', 'eNODHkrNuDA') === 1 && keysPer('extract', 'ccccccccccc') === 1);
    check('누락분만: Day 11은 문장이 있어 공통 Chunk·대화문만(daypack), Day 13은 자막부터', keysPer('pack', 'eNODHkrNuDA') === 0 && keysPer('extract', 'eNODHkrNuDA') === 0 && keysPer('extract', 'ccccccccccc') === 1 && keysPer('pack', 'ccccccccccc') === 1);
    const failText = await page.getByTestId('prep-failed').innerText();
    check('실패 목록: 단계·HTTP 상태·오류 코드', /HTTP 502/.test(failText) && /gemini_failed/.test(failText), failText.split('\n').slice(1, 3).join(' / '));
    await page.screenshot({ path: `${SHOTS}/prep-01-status.png`, fullPage: true });

    // ── 실패만 다시 시도 ──
    const n0 = sends.length;
    await page.getByTestId('prep-retry-all').click();
    await waitFor(async () => sends.slice(n0).some((s) => s.videoId === 'mockFail001' && s.state !== 'pending' && s.state !== undefined), 60, 500);
    const retried = sends.slice(n0).filter((s) => s.videoId === 'mockFail001');
    check('실패만 다시 시도: 그 영상만, 첫 요청에만 다시 생성 표시', retried.length > 0 && retried[0].retry && retried.slice(1).every((s) => !s.retry) && !sends.slice(n0).some((s) => s.videoId !== 'mockFail001'));

    // ── Day 11 원문·Chunk ──
    await page.goto(`${BASE}/videos/d11`);
    await page.getByTestId('core-chunks').waitFor();
    const core = await page.getByTestId('core-chunks').innerText();
    check('Day 11 공통 핵심 Chunk: could … use, could seriously use·could really use 연결', /could … use/.test(core) && /could seriously use/.test(core) && /could really use/.test(core), core.replace(/\n/g, ' / ').slice(0, 600));
    const sents = await page.getByTestId('content-sentence').allInnerTexts();
    check('원문 문장 4개 그대로 (기존 번역 유지)', sents.length === 4 && sents[0].includes('기존 번역 1'));
    check('문장 속 Chunk 강조 (부사는 강조 안 함)', (await page.locator('[data-testid="content-sentence"] mark', { hasText: /^seriously$/ }).count()) === 0 && (await page.locator('[data-testid="content-sentence"] mark', { hasText: /^could$/ }).count()) >= 2);
    const taught = (await page.getByTestId('core-taught').count()) ? await page.getByTestId('core-taught').first().innerText() : '';
    check('핵심 Chunk = 강사가 가르친 표현: 강의 설명 인용 표시', /강의 설명/.test(taught), taught.slice(0, 60));
    check('활용형(could seriously use 등)은 핵심 Chunk 아래 활용 사례로 묶임', /활용 사례/.test(await page.getByTestId('core-occurrences').first().innerText()));
    const extraCard = (await page.getByTestId('extra-chunks').count()) ? await page.getByTestId('extra-chunks').innerText() : '';
    const extraTexts = await page.locator('[data-testid="extra-chunks"] [data-testid="content-chunk"] > div > span.en').allInnerTexts();
    check('추가 덩어리 표현은 별도 카드·AI 추가 표시, 핵심 Chunk 활용형 없음', /추가 덩어리 표현/.test(extraCard) && /AI 추가/.test(extraCard) && extraTexts.length > 0 && !extraTexts.some((t) => /\bcould\b/i.test(t)), extraTexts.join(', '));
    const tired = page.locator('[data-testid="extra-chunks"] [data-testid="content-chunk"]').filter({ hasText: 'look super tired' });
    check('새 자료: AI가 정리한 기본 Chunk look tired · 원문 look super tired · look + 형용사', (await tired.count()) === 1 && (await tired.getByTestId('chunk-base').innerText()) === 'look tired' && /look super tired/.test(await tired.getByTestId('chunk-origin').innerText()) && /look \+ 형용사/.test((await tired.getByTestId('chunk-pattern').innerText()).replace(/\s+/g, ' ')));
    check('추가 덩어리 표현에 의미·실제 문맥 문장', (await page.locator('[data-testid="extra-chunks"] [data-testid="chunk-context"]').count()) > 0);
    await page.screenshot({ path: `${SHOTS}/prep-02-day11-sentences.png`, fullPage: true });

    // ── 대화문 탭 ──
    await page.getByRole('tab', { name: /^대화문/ }).click();
    await page.getByTestId('day-dialogue').waitFor();
    const dlg = await page.getByTestId('day-dialogue').innerText();
    check('Day 통합 대화문: 원문 출처 표시·한국어·Chunk 설명', /원문 1번 문장/.test(dlg) && /\(번역\)/.test(dlg) && /이 대화의 의미/.test(dlg) && /원문 문장 연결/.test(dlg));
    await page.screenshot({ path: `${SHOTS}/prep-03-day11-dialogue.png`, fullPage: true });

    // ── 5단계 암기 ──
    await page.getByRole('link', { name: '5단계 암기 시작' }).first().click();
    await page.getByTestId('memorize-page').waitFor();
    await page.getByTestId('step-2').click();
    const blanks2 = await page.getByTestId('blank').count();
    await page.getByTestId('step-3').click();
    const blanks3 = await page.getByTestId('blank').count();
    await page.getByLabel('빈칸 양').fill('60');
    const blanks3b = await page.getByTestId('blank').count();
    await page.getByTestId('step-4').click();
    const blanks4 = await page.getByTestId('blank').count();
    check('빈칸: 2단계 Chunk만 < 3단계 < 빈칸 양 올림 < 4단계', blanks2 > 0 && blanks2 < blanks3 && blanks3 < blanks3b && blanks3b < blanks4, `${blanks2} < ${blanks3} < ${blanks3b} < ${blanks4}`);
    await page.getByTestId('blank').first().click();
    check('빈칸을 누르면 정답 공개', (await page.getByTestId('blank').count()) === blanks4 - 1);
    await page.getByTestId('step-5').click();
    check('5단계: 영어를 가리고 한국어만', (await page.getByTestId('line-hidden').count()) > 0 && (await page.getByTestId('memorize-line').count()) === 0);
    await page.getByTestId('step-2').click();
    await page.getByTestId('rate-easy').click();
    await page.waitForTimeout(500);
    const prog = (await dumpDb(page)).tables.dialogueProgress.find((p) => p.dialogueId.startsWith('dlg-day-') && p.stepResults.length);
    check('암기 진도 저장 (2단계 완료 → 3단계)', prog && prog.highestCompletedStep === 2 && prog.currentStep === 3);
    await page.screenshot({ path: `${SHOTS}/prep-04-memorize.png`, fullPage: true });

    // ── 저장·보존 ──
    const after = await dumpDb(page);
    const d11 = after.tables.dialogues.find((d) => d.videoId === 'd11' && d.generatedBy === 'ai');
    {
      const db = await dumpDb(page);
      const ex = db.tables.expressions.find((e) => e.text === 'look tired');
      const li = ex && db.tables.learningItems.find((i) => i.expressionId === ex.id && i.videoId === 'd11');
      check('저장: 기본 Chunk(look tired)와 원문 형태(look super tired)를 나눠 저장, 활용 예시는 검사 통과한 것만(뜻 포함), 원문 문장은 그대로', !!li && li.chunkRole === 'extra' && li.chunk.surface === 'look super tired' && li.chunk.pattern === 'look + 형용사' && li.chunk.swapExamples.map((x) => x.en).join(',') === 'look happy,look busy' && li.chunk.swapExamples.every((x) => x.ko) && db.tables.keySentences.some((k) => k.english === 'You look super tired. You could use some rest.'));
    }
    check('저장: 대화문에 빈칸 자료·출처 Day·Chunk 사용', d11 && d11.blankPlan && Object.keys(d11.blankPlan.lines).length === d11.lines.length && d11.sourceDays[0] === 11 && d11.chunkUsages.length > 0);
    for (const t of ['videos', 'transcripts', 'reviewStates', 'studyLogs', 'playlists', 'expressionNotes']) {
      const a = byId(after.tables[t]);
      const kept = Object.entries(byId(before.tables[t])).every(([id, r]) => same(a[id], r));
      check(`기존 ${t} 그대로`, kept);
    }
    for (const t of ['keySentences', 'expressions', 'dialogues', 'dialogueProgress']) {
      const a = byId(after.tables[t]);
      const kept = Object.entries(byId(before.tables[t])).every(([id, r]) => same(a[id], r));
      check(`기존 ${t} 그대로 (새 기록만 추가)`, kept, `추가 ${after.tables[t].length - before.tables[t].length}개`);
    }
    check('DB 버전 그대로', after.version === before.version, String(after.version));

    // ── 다른 기기 (새 프로필): 같은 영상은 서버 보관 결과를 받음 ──
    const ctx2 = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx2.route(/^https:\/\/(i\.ytimg\.com|www\.youtube(-nocookie)?\.com)\//, (r) => r.fulfill({ status: 200, body: '' }));
    const s2 = [];
    ctx2.on('response', async (r) => {
      if (r.url().endsWith('/api/ai/extract')) s2.push({ task: JSON.parse(r.request().postData() || '{}').task ?? 'extract', state: (await r.json().catch(() => ({}))).state });
    });
    const p2 = await ctx2.newPage();
    await p2.goto(BASE);
    await p2.locator('main').first().waitFor();
    await p2.waitForTimeout(600);
    await p2.evaluate(
      (lines) =>
        new Promise((resolve) => {
          const req = indexedDB.open('my-english-study');
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(['videos', 'transcripts'], 'readwrite');
            const now = '2026-11-16T09:00:00.000Z';
            tx.objectStore('videos').add({ id: 'p12', createdAt: now, updatedAt: now, playlistId: null, youtubeVideoId: 'bbbbbbbbbbb', title: '[Day 12] 좋은 생각이야', url: null, thumbnailUrl: null, durationSec: 300, orderIndex: 0, randomOrderKey: 0, status: 'new', completedAt: null, sources: [{ kind: 'manual', addedAt: now }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
            tx.objectStore('transcripts').add({ id: 'tr-p12', createdAt: now, updatedAt: now, videoId: 'p12', source: 'manual_paste', status: 'success', rawText: lines.join('\n'), segments: lines.map((text, i) => ({ startSec: i * 10, endSec: i * 10 + 9, text })), format: 'timestamped' });
            tx.oncomplete = () => {
              db.close();
              resolve(true);
            };
          };
        }),
      ['Day 12.', '1. That sounds like a good idea.', '2. We should catch up soon.'],
    );
    await p2.goto(`${BASE}/videos/p12`);
    await p2.getByTestId('video-prep-enqueue').click();
    await waitFor(async () => (await p2.getByTestId('core-chunks').count()) > 0 || (await p2.getByTestId('content-sentence').count()) > 0, 30);
    check('다른 기기: 같은 영상은 첫 응답부터 보관 결과 (새로 생성 안 함)', s2.length > 0 && s2[0].state === 'succeeded', s2.map((x) => `${x.task}:${x.state}`).join(','));
    await p2.goto(`${BASE}/dialogues/combine`);
    await p2.getByTestId('combine-page').waitFor();
    check('휴대폰: 화면 가로 넘침 없음', await p2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    const dl = (await dumpDb(p2)).tables.dialogues.find((d) => d.generatedBy === 'ai');
    if (dl) {
      await p2.goto(`${BASE}/dialogues/${dl.id}/memorize`);
      await p2.getByTestId('memorize-page').waitFor();
      check('휴대폰: 암기 화면 가로 넘침 없음', await p2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      await p2.screenshot({ path: `${SHOTS}/prep-05-phone-memorize.png`, fullPage: true });
    }
    await ctx2.close();

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
