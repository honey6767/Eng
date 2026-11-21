/**
 * Day 1~100 분리 E2E (Playwright, 새 임시 프로필, 가짜 YouTube·가짜 Gemini — 실제 Google 호출 없음)
 * 사용법: npm run build && node scripts/e2e-day.mjs
 *
 * - '기존 영상 자료 만들기 시작'·앱 다시 열기에도 Day 1~100 영상은 AI 요청을 보내지 않음 (일반 영상만 자동 준비)
 * - 영상 목록 'Day 1~100 / 일반 영상 / 전체' (기본 전체), Day 배지, Day 자료 상태
 * - Day 영상: 핵심 문장(직접 입력·자막에서 고름) → 'Day 자료 만들기' 1회 → 그 문장만 보냄 (AI 문장·자막 없음, 사용자 요청)
 * - 예전 AI 추출 문장은 '예전 AI 추출 문장 (참고)'로 접혀 있고 지우거나 바꾸지 않음
 * - 예전 방식으로 이미 만든 Day 자료는 그대로 (다시 만들지 않음)
 * - 기존 학습 데이터·DB 버전 그대로, 휴대폰 화면
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
const PORT = 4211;
const BASE = `http://localhost:${PORT}`;

function startServer() {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'pipe',
    env: { ...process.env, YOUTUBE_API_KEY: '', YOUTUBE_API_MOCK: '1', AI_GEMINI_MOCK: '1', GEMINI_API_KEY: '', YOUTUBE_QUOTA_FILE: join(tmpdir(), `mes-e2e-day-quota-${process.pid}.json`) },
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

const NOW = '2026-11-19T01:00:00.000Z';
const TRANSCRIPT = ['Welcome to Day 7.', 'Today we learn could use.', '1. I could use a break.', '2. You could use some rest.', 'We could really use some help here.'];
const VIDEOS = [
  { id: 'd7', yt: 'daySeven007', title: '[Day 7] could use 배우기', transcript: TRANSCRIPT },
  { id: 'd12', yt: 'dayTwelve12', title: '[Day 12] 예전 자료 있음', transcript: ['1. I could use a hand.'] },
  { id: 'd30', yt: 'dayThirty30', title: '[Day 30] 문장 없음' },
  { id: 'd40', yt: 'dayForty040', title: '[Day 40] 너무 긴 문장' },
  { id: 'g150', yt: 'general0150', title: '[Day 150] 일반 영상', transcript: ['1. I could use a break.'] },
  { id: 'gtalk', yt: 'generalTalk', title: 'Small talk at work', transcript: ['1. That sounds like a plan.'] },
];

const seed = (page) =>
  page.evaluate(
    ({ videos, now }) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('my-english-study');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['videos', 'transcripts', 'keySentences', 'expressions', 'learningItems', 'dialogues', 'dialogueProgress', 'reviewStates'], 'readwrite');
          videos.forEach((v, i) => {
            tx.objectStore('videos').add({ id: v.id, createdAt: now, updatedAt: now, playlistId: null, youtubeVideoId: v.yt, title: v.title, url: null, thumbnailUrl: null, durationSec: 300, orderIndex: i, randomOrderKey: i / 10, status: 'new', completedAt: null, sources: [{ kind: 'manual', addedAt: now }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
            if (v.transcript) tx.objectStore('transcripts').add({ id: `tr-${v.id}`, createdAt: now, updatedAt: now, videoId: v.id, source: 'manual_paste', status: 'success', rawText: v.transcript.join('\n'), segments: v.transcript.map((text, j) => ({ startSec: j * 10, endSec: j * 10 + 9, text })), format: 'timestamped' });
          });
          const ks = (id, videoId, order, english, origin, extra = {}) => ({ id, createdAt: now, updatedAt: now, videoId, order, english, korean: `${english} (뜻)`, expressionIds: [], situation: '', timestampSec: null, status: 'not_started', correctCount: 0, wrongCount: 0, origin, ...extra });
          // Day 7: 예전 AI 추출 문장 2개 (학습 기록 있음) + 예전 AI Chunk
          tx.objectStore('keySentences').add(ks('ai7-1', 'd7', 101, 'I could use a break.', 'ai_extracted', { aiNumber: 1, status: 'learning', correctCount: 2 }));
          tx.objectStore('keySentences').add(ks('ai7-2', 'd7', 102, 'You could use some rest.', 'ai_extracted', { aiNumber: 2 }));
          tx.objectStore('expressions').add({ id: 'ex-old', createdAt: now, updatedAt: now, normalizedKey: 'could use', text: 'could use', meaningKo: '예전 뜻', sourceRefs: [], isFavorite: true, isMarkedDifficult: false, origin: 'ai_extracted' });
          // Day 40: 예전 버전에서 넣은 500자 넘는 사용자 문장 + 학습 기록·복습 기록 (선정 취소도 막힘 → 'Day 자료에서 빼기'로 해결)
          tx.objectStore('keySentences').add(ks('u40-1', 'd40', 1, 'I could use a little break.', 'manual'));
          tx.objectStore('keySentences').add(ks('u40-2', 'd40', 2, `Too long ${'word '.repeat(110)}end.`, 'manual', { status: 'learning', correctCount: 3, wrongCount: 1 }));
          tx.objectStore('reviewStates').add({ id: 'sentence:u40-2', createdAt: now, updatedAt: now, itemType: 'sentence', itemId: 'u40-2', intervalIndex: 1, reviewCount: 2, correctCount: 1, streak: 1, lastResult: 'easy', lastStudiedAt: now, nextReviewAt: '2026-11-22T01:00:00.000Z' });
          tx.objectStore('learningItems').add({ id: 'li-old7', createdAt: now, updatedAt: now, expressionId: 'ex-old', videoId: 'd7', sourceType: 'day', dayNumber: 7, kind: 'chunk', dialogueId: null, sourceText: 'I could use a break.', timestampSec: null, onScreen: false, origin: 'ai_extracted', status: 'confirmed', extractionDraftId: null, legacyKeySentenceId: null, sentenceId: 'ai7-1', selected: true });
          // Day 12: 예전 방식으로 이미 만든 Day 자료 (AI 문장 + AI Day 대화문 + 암기 진도)
          tx.objectStore('keySentences').add(ks('ai12-1', 'd12', 101, 'I could use a hand.', 'ai_extracted', { aiNumber: 1, contentRequestId: 'oldreq12' }));
          tx.objectStore('dialogues').add({ id: 'dlg-day-oldreq12', createdAt: now, updatedAt: now, kind: 'original', videoId: 'd12', sourceVideoIds: [], orderInVideo: 1, title: '예전 Day 12 대화문', situation: '예전', lines: [{ id: 'l1', order: 1, speaker: 'A', english: 'I could use a hand.', korean: '도움이 필요해.', segments: [{ kind: 'connector', text: 'I could use a hand.' }], sourceSentenceId: 'ai12-1' }, { id: 'l2', order: 2, speaker: 'B', english: 'Sure.', korean: '그래.', segments: [{ kind: 'connector', text: 'Sure.' }] }], expressionIds: [], generatedBy: 'ai', isFavorite: true, sourceDays: [12] });
          tx.objectStore('dialogueProgress').add({ id: 'dlg-day-oldreq12', dialogueId: 'dlg-day-oldreq12', currentStep: 3, highestCompletedStep: 2, stepResults: [], memorized: false, memorizedAt: null, blankMastery: {}, updatedAt: now });
          tx.objectStore('reviewStates').add({ id: 'dialogue:dlg-day-oldreq12', createdAt: now, updatedAt: now, itemType: 'dialogue', itemId: 'dlg-day-oldreq12', intervalIndex: 1, reviewCount: 1, correctCount: 1, streak: 1, lastResult: 'easy', lastStudiedAt: now, nextReviewAt: '2026-11-21T01:00:00.000Z' });
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { videos: VIDEOS, now: NOW },
  );

async function waitFor(fn, tries = 120, ms = 500) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, ms));
  }
  return false;
}
const visible = (loc, timeout = 5000) => loc.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  const sends = [];
  try {
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.route(/^https:\/\/(i\.ytimg\.com|www\.youtube(-nocookie)?\.com)\//, (r) => r.fulfill({ status: 200, body: '' }));
    ctx.on('response', async (r) => {
      if (!r.url().endsWith('/api/ai/extract')) return;
      const b = JSON.parse(r.request().postData() || '{}');
      const j = await r.json().catch(() => ({}));
      sends.push({ task: b.task ?? 'extract', videoId: b.videoId, body: b, key: r.request().headers()['idempotency-key'], origin: b.origin ?? null, status: r.status(), state: j.state, code: j.code, interactionId: j.interactionId ?? null });
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
    const confirmDialog = (label) => page.getByRole('alertdialog').getByRole('button', { name: label, exact: true }).click();

    await page.goto(BASE);
    await page.locator('main').first().waitFor();
    await page.waitForTimeout(600);
    await seed(page);
    const before = await dumpDb(page);
    const dayYt = new Set(['daySeven007', 'dayTwelve12', 'dayThirty30', 'dayForty040']);
    const generalCreates = () => new Set(sends.filter((s) => s.interactionId && !dayYt.has(s.videoId)).map((s) => s.interactionId)).size;

    // ── 1. 자동 준비: 일반 영상만 ──
    await page.goto(`${BASE}/extraction`);
    await page.getByTestId('prep-start-all').click();
    const allDone = await waitFor(async () => /완료 2/.test((await page.getByTestId('prep-counts').textContent()) ?? ''), 180, 1000);
    check('기존 영상 자료 만들기 시작 → 일반 영상 2개(Day 150 포함) 완료', allDone, (await page.getByTestId('prep-counts').textContent()) ?? '');
    await page.reload(); // 앱 다시 열기
    await page.waitForTimeout(3000);
    check('Day 1~100 영상은 자동 요청 0건 (자막·자료 모두)', sends.filter((s) => dayYt.has(s.videoId)).length === 0, `일반 생성 ${generalCreates()}건`);
    const dayCounts = (await page.getByTestId('prep-day-counts').textContent()) ?? '';
    check('자료 생성 화면: Day 1~100 별도 집계 (완료 1 · 문장 입력 전 2)', /완료 1/.test(dayCounts) && /문장 입력 전 2/.test(dayCounts), dayCounts.split('Day 영상은')[0]);
    check('자동 준비 집계는 일반 영상만', /일반 영상 · 완료 2 · 대기 0 · 실패 0/.test((await page.getByTestId('prep-counts').textContent()) ?? ''));
    await page.screenshot({ path: `${SHOTS}/day-01-prep.png`, fullPage: true });

    // ── 2. 영상 목록 필터 ──
    await page.goto(`${BASE}/videos`);
    const filter = page.getByTestId('series-filter');
    check('목록 필터 기본값 = 전체', (await filter.locator('[data-series="all"]').getAttribute('aria-selected')) === 'true');
    const listTitles = async () => (await page.getByTestId('video-list').locator('li').allTextContents()).join(' | ');
    const allList = await listTitles();
    check('전체: Day·일반 모두 보임', ['[Day 7]', '[Day 12]', '[Day 150]', 'Small talk'].every((t) => allList.includes(t)));
    await filter.locator('[data-series="day"]').click();
    const dayList = await listTitles();
    check('Day 1~100 필터: Day 7·12·30·40만', ['[Day 7]', '[Day 12]', '[Day 30]'].every((t) => dayList.includes(t)) && !dayList.includes('[Day 150]') && !dayList.includes('Small talk'));
    check('Day 배지·Day 자료 상태 표시 (완료 / 문장 입력 전)', dayList.includes('Day 자료 완료') && dayList.includes('문장 입력 전'));
    await page.screenshot({ path: `${SHOTS}/day-02-list-day.png`, fullPage: true });
    await filter.locator('[data-series="general"]').click();
    const genList = await listTitles();
    check('일반 영상 필터: Day 150·Small talk만', genList.includes('[Day 150]') && genList.includes('Small talk') && !genList.includes('[Day 7]'));

    // ── 3. Day 7: 문장 입력 전 → 문장 넣고 Day 자료 만들기 ──
    await page.goto(`${BASE}/videos/d7`);
    const card = page.getByTestId('day-material');
    await card.waitFor();
    check('Day 7: 상태 "문장 입력 전", 만들기 버튼 비활성', (await card.getAttribute('data-state')) === 'no_sentences' && (await page.getByTestId('day-make').isDisabled()));
    const old = page.getByTestId('old-ai-sentences');
    check('예전 AI 추출 문장은 "예전 AI 추출 문장 (참고)"로 접혀 있음', (await old.locator(':scope > summary').textContent())?.includes('예전 AI 추출 문장 (참고) 2개') && !(await old.evaluate((d) => d.open)));
    check('접힌 상태에서는 예전 AI 문장이 보이지 않음', !(await page.getByText('You could use some rest.', { exact: true }).first().isVisible().catch(() => false)));
    await old.locator(':scope > summary').click();
    check('펼치면 예전 AI 문장을 볼 수 있음', await visible(old.getByText('You could use some rest.')));
    await old.locator(':scope > summary').click();
    check('VideoPrepStatus(일반 자동 준비 카드)는 Day 영상에 없음', (await page.getByTestId('video-prep').count()) === 0);
    await page.screenshot({ path: `${SHOTS}/day-03-before.png`, fullPage: true });

    // 자막에서 고르기 1개 + 직접 입력 2개
    const sec = page.getByTestId('day-sentences');
    await sec.getByTestId('transcript-pick-list').getByRole('button', { name: /We could really use some help here/ }).click();
    await sec.getByRole('button', { name: '핵심 문장으로 저장' }).click();
    await confirmDialog('저장');
    await sec.getByRole('tab', { name: '직접 입력' }).click();
    // 500자 넘는 문장: 저장 전에 바로 알려 주고 저장 버튼을 막음 (원문을 자르지 않음)
    await sec.getByLabel('영어 문장').fill(`Way too long ${'word '.repeat(110)}end.`);
    const lenErr = page.getByTestId('day-length-error');
    check('500자 초과 문장: 입력 중 바로 안내(글자 수) + 저장 버튼 비활성', (await visible(lenErr)) && /500자까지예요 \(지금 \d+자\)/.test((await lenErr.textContent()) ?? '') && (await sec.getByRole('button', { name: '핵심 문장으로 저장' }).isDisabled()));
    await sec.getByLabel('영어 문장').fill('');
    for (const en of ['I could use a cup of coffee.', 'That sounds like a plan.']) {
      await sec.getByLabel('영어 문장').fill(en);
      await sec.getByRole('button', { name: '핵심 문장으로 저장' }).click();
      await confirmDialog('저장');
      await page.waitForTimeout(300);
    }
    check('핵심 문장 3/20 (Day는 최대 20개)', (await page.getByTestId('day-sentence-count').textContent())?.trim() === '핵심 문장 3/20');
    check('상태 "만들기 전" + 버튼 활성', (await card.getAttribute('data-state')) === 'ready_to_make' && !(await page.getByTestId('day-make').isDisabled()));
    const sentBefore = sends.length;
    check('문장을 넣기만 해서는 AI 요청 없음', sends.length === sentBefore && sends.filter((s) => dayYt.has(s.videoId)).length === 0);
    await page.getByTestId('day-make').click();
    const made = await waitFor(async () => (await card.getAttribute('data-state')) === 'done', 120, 1000);
    check('Day 자료 만들기 → 완료', made);
    const d7 = sends.filter((s) => s.videoId === 'daySeven007');
    const d7Body = d7[0]?.body ?? {};
    check('Day 7 요청은 daypack 1건(같은 식별자)·사용자 요청 표시', d7.length > 0 && d7.every((s) => s.task === 'daypack' && s.origin === 'user') && new Set(d7.map((s) => s.key)).size === 1 && new Set(d7.filter((s) => s.interactionId).map((s) => s.interactionId)).size === 1);
    check('보낸 문장 = 사용자 문장 3개 그대로 (사용자 순서, 1번부터)', same((d7Body.sentences ?? []).map((s) => [s.number, s.text]), [[1, 'We could really use some help here.'], [2, 'I could use a cup of coffee.'], [3, 'That sounds like a plan.']]));
    check('AI 문장·자막·힌트는 보내지 않음', !('transcript' in d7Body) && !('taughtHints' in d7Body) && !JSON.stringify(d7Body).includes('You could use some rest.') && !JSON.stringify(d7Body).includes('Welcome to Day 7'));
    await page.waitForTimeout(800);
    check('Day 자료(핵심 Chunk·원문 문장) 표시', await visible(page.getByTestId('core-chunks')));
    check('Day 자료 원문 문장 = 사용자 문장 3개', (await page.getByTestId('study-content').first().getByTestId('content-sentence').count()) === 3);
    check('예전 AI 문장은 계속 접혀 있음', !(await page.getByTestId('old-ai-sentences').evaluate((d) => d.open)));
    await page.screenshot({ path: `${SHOTS}/day-04-made.png`, fullPage: true });
    await page.getByRole('tab', { name: /^대화문/ }).click();
    const map = page.getByTestId('source-map');
    await map.waitFor({ timeout: 10000 }).catch(() => {});
    check('Day 대화문: 원문 연결이 사용자 문장 1~3번', (await map.locator('li').count()) === 3 && (await map.textContent())?.includes('We could really use some help here.'));
    await page.getByRole('tab', { name: /^원문·Chunk/ }).click();

    // 자료를 만든 뒤 문장을 하나 더 넣어도 Day 자료의 번호·문장은 그대로 (요청 때 번호), 새 문장은 연결이 없어 선정 취소 가능
    await sec.getByRole('tab', { name: '직접 입력' }).click(); // 탭을 오가면 추가 칸이 '자막에서 선택'으로 돌아감
    await sec.getByLabel('영어 문장').fill('Let me figure it out later.');
    await sec.getByRole('button', { name: '핵심 문장으로 저장' }).click();
    await confirmDialog('저장');
    await page.waitForTimeout(800);
    const nums = await page.getByTestId('study-content').first().getByTestId('content-sentence').allInnerTexts();
    check('문장을 더해도 Day 자료 원문 문장은 요청 때 3개·같은 번호', nums.length === 3 && nums[0].startsWith('1') && nums[0].includes('We could really use some help here.') && nums[2].startsWith('3') && nums[2].includes('That sounds like a plan.'), nums.map((t) => t.split('\n').slice(0, 2).join(' ')).join(' | '));
    const cardOf = (t) => page.getByTestId('key-sentence-card').filter({ hasText: t });
    check('자료에 연결 안 된 새 문장은 선정 취소 가능', !(await cardOf('Let me figure it out later.').getByRole('button', { name: '선정 취소' }).isDisabled()));
    check('대화 원문 출처로 쓰인 문장은 선정 취소 막힘 (이유 표시)', (await cardOf('That sounds like a plan.').getByRole('button', { name: '선정 취소' }).isDisabled()) && /원문 출처|Chunk/.test((await cardOf('That sounds like a plan.').getByRole('button', { name: '선정 취소' }).getAttribute('title')) ?? ''));

    // 다시 눌러도·다시 열어도 새로 만들지 않음
    const createsBefore = new Set(sends.filter((s) => s.interactionId).map((s) => s.interactionId)).size;
    await page.reload();
    await page.waitForTimeout(3000);
    check('완료 뒤에는 만들기 버튼 없음 (다시 만들지 않음)', (await page.getByTestId('day-make').count()) === 0);
    check('다시 열어도 추가 생성 없음', new Set(sends.filter((s) => s.interactionId).map((s) => s.interactionId)).size === createsBefore);

    // ── 3-2. Day 40: 500자 넘는 문장(학습 기록 있음) → 안내 → 'Day 자료에서 빼기' → 나머지로 만들기 ──
    await page.goto(`${BASE}/videos/d40`);
    const card40 = page.getByTestId('day-material');
    await card40.waitFor();
    const prob = (await page.getByTestId('day-material-problem').textContent().catch(() => '')) ?? '';
    check('Day 40: 500자 넘는 문장 → 번호·앞부분·글자 수 + 빼기 안내, 만들기 버튼 비활성', /2번 “Too long/.test(prob) && /\d+자/.test(prob) && /Day 자료에서 빼기/.test(prob) && (await page.getByTestId('day-make').isDisabled()), prob.slice(0, 160));
    const longCard = page.getByTestId('key-sentence-card').filter({ hasText: 'Too long' });
    check('학습 기록이 있어 선정 취소는 막혀 있음', await longCard.getByRole('button', { name: '선정 취소' }).isDisabled());
    await longCard.getByTestId('day-exclude').click();
    await page.waitForTimeout(500);
    check('빼기 → 카드에 "Day 자료에서 뺌" 표시', (await longCard.getAttribute('data-excluded')) === 'true' && (await longCard.getByText('Day 자료에서 뺌').count()) === 1);
    check('Day 자료 카드: 뺀 문장 목록 · 핵심 문장 1/20 · 뺀 문장 1 · 만들기 버튼 활성', (await visible(page.getByTestId('day-excluded'))) && /Too long/.test((await page.getByTestId('day-excluded').textContent()) ?? '') && (await page.getByTestId('day-sentence-count').textContent())?.trim() === '핵심 문장 1/20 · 뺀 문장 1' && !(await page.getByTestId('day-make').isDisabled()));
    await page.reload();
    await card40.waitFor();
    check('새로고침 뒤에도 뺀 상태 유지', (await page.getByTestId('key-sentence-card').filter({ hasText: 'Too long' }).getAttribute('data-excluded')) === 'true');
    // 다시 넣기 → 다시 막힘 → 다시 빼기
    await page.getByTestId('key-sentence-card').filter({ hasText: 'Too long' }).getByTestId('day-include').click();
    await page.waitForTimeout(500);
    check('다시 넣기 → 안내가 돌아오고 만들기 버튼 비활성', (await visible(page.getByTestId('day-material-problem'))) && (await page.getByTestId('day-make').isDisabled()) && (await page.getByTestId('day-excluded').count()) === 0);
    await page.getByTestId('key-sentence-card').filter({ hasText: 'Too long' }).getByTestId('day-exclude').click();
    await page.waitForTimeout(500);
    check('여기까지 Day 40 관련 AI 요청 0건', sends.filter((s) => s.videoId === 'dayForty040').length === 0);
    await page.getByTestId('day-make').click();
    const made40 = await waitFor(async () => (await card40.getAttribute('data-state')) === 'done', 120, 1000);
    const d40 = sends.filter((s) => s.videoId === 'dayForty040');
    const d40Body = d40[0]?.body ?? {};
    check('Day 40 자료 완료 · 요청에는 뺀 문장 없이 1개만 (원문 그대로)', made40 && same((d40Body.sentences ?? []).map((x) => [x.number, x.text]), [[1, 'I could use a little break.']]) && !JSON.stringify(d40.map((x) => x.body)).includes('Too long'));
    await page.waitForTimeout(500);
    check('자료 생성 뒤: 빼기·다시 넣기 버튼 없음, 뺀 문장 목록은 그대로 표시', (await page.getByTestId('day-exclude').count()) === 0 && (await page.getByTestId('day-include').count()) === 0 && /Day 자료에 쓰지 않았어요/.test((await page.getByTestId('day-excluded').textContent()) ?? ''));
    await page.screenshot({ path: `${SHOTS}/day-05-excluded.png`, fullPage: true });

    // ── 4. Day 12: 예전 Day 자료 그대로 ──
    await page.goto(`${BASE}/videos/d12`);
    await page.getByTestId('day-material').waitFor();
    check('Day 12: 예전 방식 Day 자료 = 완료, 만들기 버튼 없음', (await page.getByTestId('day-material').getAttribute('data-state')) === 'done' && (await page.getByTestId('day-make').count()) === 0);
    check('Day 12: 예전 자료(AI 원문 문장)는 접지 않고 그대로 보임', (await page.getByTestId('old-ai-sentences').count()) === 0 && (await visible(page.getByText('I could use a hand.'))));
    check('Day 12 관련 요청 0건', sends.filter((s) => s.videoId === 'dayTwelve12').length === 0);

    // ── 5. 일반 영상 화면은 그대로 ──
    await page.goto(`${BASE}/videos/gtalk`);
    await page.waitForTimeout(800);
    check('일반 영상: Day 카드 없음, 예전 화면(직접 고른 핵심 문장 접힘) 유지', (await page.getByTestId('day-material').count()) === 0 && (await page.getByTestId('manual-sentences').count()) === 1);

    // ── 6. 데이터 보존 ──
    const after = await dumpDb(page);
    check('DB 버전 그대로', after.version === before.version, `v${after.version}`);
    const keep = (t, ids) => ids.every((id) => same(before.tables[t].find((x) => x.id === id), after.tables[t].find((x) => x.id === id)));
    check('예전 AI 문장·학습 기록 그대로', keep('keySentences', ['ai7-1', 'ai7-2', 'ai12-1']));
    check('뺀 문장(학습 기록 있음)과 그 복습 기록 그대로', keep('keySentences', ['u40-1', 'u40-2']) && keep('reviewStates', ['sentence:u40-2']));
    check('뺀 문장은 appMeta dayExclusions에만 기록', same(after.tables.appMeta.find((m) => m.key === 'dayExclusions')?.value, { d40: ['u40-2'] }));
    check('예전 표현·Chunk 그대로', keep('expressions', ['ex-old']) && keep('learningItems', ['li-old7']));
    check('예전 Day 대화문·암기 진도·복습 기록 그대로', keep('dialogues', ['dlg-day-oldreq12']) && keep('dialogueProgress', ['dlg-day-oldreq12']) && keep('reviewStates', ['dialogue:dlg-day-oldreq12']));
    const d7Dialogues = after.tables.dialogues.filter((d) => d.videoId === 'd7');
    check('Day 7 Day 대화문 1개 (중복 없음)', d7Dialogues.length === 1);
    const userIds = new Set(after.tables.keySentences.filter((s) => s.videoId === 'd7' && s.origin !== 'ai_extracted').map((s) => s.id));
    const d7Items = after.tables.learningItems.filter((i) => i.videoId === 'd7' && i.id !== 'li-old7');
    const links = [...d7Items.flatMap((i) => [i.sentenceId, ...(i.occurrences ?? []).map((o) => o.sentenceId)]), ...d7Dialogues[0].lines.map((l) => l.sourceSentenceId)].filter(Boolean);
    check('새 Day 자료는 사용자 문장에만 연결 (예전 AI 문장 연결 없음)', links.length > 0 && links.every((id) => userIds.has(id)));
    check('Day 자료가 문장을 새로 만들지 않음 (사용자 3 + 나중에 넣은 1 + 예전 AI 2)', after.tables.keySentences.filter((s) => s.videoId === 'd7').length === 6);
    check('페이지 오류 없음', errors.length === 0, errors.slice(0, 3).join(' / '));
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
