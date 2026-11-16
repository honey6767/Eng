/**
 * 원문 문장 · Chunk · 통합 대화문 E2E (Playwright, 새 임시 프로필, 가짜 Gemini — 실제 Google 호출 없음)
 * 사용법: npm run build && node scripts/e2e-content.mjs
 *
 * - Day 영상: 번호별 원문 문장 + 문장 속 Chunk가 따로 보이고, 문장·Chunk를 각각 고를 수 있다
 * - 일반 영상: '일반 영상'으로 구분, 맥락에서 고른 문장·Chunk
 * - AI 자막 관리: 자막 있는 영상 문장·Chunk 한꺼번에 만들기
 * - 통합 대화문: 최근 학습한 Day 3개 기본 추천 → Chunk 체크 → 생성 → 사용한 Chunk·출처 Day·한국어·뉘앙스 표시
 * - 기존 데이터(영상·자막·복습 기록·학습 기록·기존 대화문·기존 핵심 문장·기존 표현) 그대로
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const SHOTS = 'e2e-screenshots';
mkdirSync(SHOTS, { recursive: true });
const PORT = 4195;
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

const seed = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('my-english-study');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['videos', 'transcripts', 'keySentences', 'expressions', 'reviewStates', 'dialogues'], 'readwrite');
          const now = '2026-11-16T09:00:00.000Z';
          const v = (id, yt, title, i, status, startedAt) => ({ id, createdAt: now, updatedAt: now, playlistId: null, youtubeVideoId: yt, title, url: null, thumbnailUrl: null, durationSec: 300, orderIndex: i, randomOrderKey: i / 10, status, completedAt: null, startedAt, sources: [{ kind: 'manual', addedAt: now }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
          const tr = (vid, lines) => ({ id: `tr-${vid}`, createdAt: now, updatedAt: now, videoId: vid, source: 'ai_transcription', status: 'success', rawText: lines.join('\n'), segments: lines.map((text, i) => ({ startSec: i * 10, endSec: i * 10 + 9, text })), format: 'timestamped' });
          const vs = tx.objectStore('videos');
          vs.add(v('c11', 'eNODHkrNuDA', '[Day 11] 필요해 I need 말고', 0, 'completed', '2026-11-10T09:00:00.000Z'));
          vs.add(v('c12', 'bbbbbbbbbbb', '[Day 12] 좋은 생각이야', 1, 'in_progress', '2026-11-12T09:00:00.000Z'));
          vs.add(v('c13', 'ccccccccccc', '[Day 13] 알아볼게', 2, 'in_progress', '2026-11-14T09:00:00.000Z'));
          vs.add(v('c05', 'ddddddddddd', '[Day 5] 오래전', 3, 'new', null));
          vs.add(v('g01', 'eeeeeeeeeee', 'Small talk at the office', 4, 'new', null));
          const ts = tx.objectStore('transcripts');
          ts.add(tr('c11', ['Hi guys, welcome to Day 11.', '1. I could use a little break right now.', '2. That sounds like a good idea.', '3. Let me figure out what to do.', '4. I am running late again.', 'See you tomorrow!']));
          ts.add(tr('c12', ['Day 12 starts now.', '1. We should catch up soon.', '2. It is no big deal.', '3. Can you make it tonight?']));
          ts.add(tr('c13', ['Welcome to Day 13.', '1. I need to get back to work.', '2. Let me figure out the plan.']));
          ts.add(tr('c05', ['Day 5.', '1. Sounds like fun.']));
          ts.add(tr('g01', ['So how was your weekend?', 'Honestly, it was no big deal.', 'We should catch up over lunch.', 'The office is in Seoul.']));
          // 기존 사용자 데이터 (그대로 있어야 함)
          tx.objectStore('keySentences').add({ id: 'ks-user-1', createdAt: now, updatedAt: now, videoId: 'c13', order: 1, english: 'I need to get back to work.', korean: '내가 쓴 번역', expressionIds: [], situation: '사무실', timestampSec: 10, status: 'learning', correctCount: 2, wrongCount: 1, origin: 'manual' });
          tx.objectStore('expressions').add({ id: 'ex-user-1', createdAt: now, updatedAt: now, normalizedKey: 'could use', text: 'could use', meaningKo: '내가 쓴 뜻', sourceRefs: [], isFavorite: true, isMarkedDifficult: true });
          tx.objectStore('reviewStates').add({ id: 'expression:ex-user-1', createdAt: now, updatedAt: now, itemType: 'expression', itemId: 'ex-user-1', stage: 2, nextReviewAt: now, lastReviewedAt: now, weakness: 1, history: [] });
          tx.objectStore('dialogues').add({ id: 'dlg-user-1', createdAt: now, updatedAt: now, kind: 'original', videoId: 'c11', sourceVideoIds: [], orderInVideo: 1, title: '기존 대화문', situation: '기존', lines: [], expressionIds: [], generatedBy: 'manual', isFavorite: true });
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );

async function waitPhase(page, testId, done = ['succeeded', 'failed', 'already'], tries = 60) {
  let phase = null;
  for (let i = 0; i < tries; i++) {
    const loc = page.getByTestId(testId).first();
    phase = (await loc.count()) ? await loc.getAttribute('data-phase') : null;
    if (done.includes(phase)) return phase;
    await page.waitForTimeout(1000);
  }
  return phase;
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  const tasks = [];
  try {
    for (const [label, device] of [['iPad', devices['iPad (gen 7)']], ['phone', devices['iPhone 13']]]) {
      if (label === 'phone') break; // 휴대폰 화면은 아래에서 따로 확인
      void device;
    }
    const ctx = await browser.newContext({ ...devices['iPad (gen 7)'] });
    await ctx.route(/^https:\/\/(i\.ytimg\.com|www\.youtube(-nocookie)?\.com)\//, (r) => r.fulfill({ status: 200, body: '' }));
    ctx.on('request', (r) => {
      if (r.url().endsWith('/api/ai/extract')) {
        const b = JSON.parse(r.postData() || '{}');
        tasks.push({ task: b.task ?? 'extract', key: r.headers()['idempotency-key'], videoId: b.videoId, seriesKind: b.seriesKind });
      }
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));

    await page.goto(BASE);
    await page.locator('main').first().waitFor();
    await page.waitForTimeout(600);
    await seed(page);
    const before = await dumpDb(page);

    // ── 자료 생성: 기존 영상 자료 만들기 시작 (대기열이 차례로 처리) ──
    await page.goto(`${BASE}/extraction`);
    await page.getByTestId('prep-start-all').click();
    for (let i = 0; i < 90; i++) {
      await page.waitForTimeout(1000);
      const t = (await page.getByTestId('prep-counts').count()) ? await page.getByTestId('prep-counts').innerText() : '';
      if (/완료 5 · 대기 0/.test(t)) break;
    }
    check('자료 생성: 5개 영상 차례로 완료', /완료 5 · 대기 0/.test(await page.getByTestId('prep-counts').innerText()), await page.getByTestId('prep-counts').innerText());

    // ── Day 11: 원문 문장·Chunk ──
    await page.goto(`${BASE}/videos/c11?tab=sentences`);
    await page.getByTestId('study-content').waitFor();
    const sentences = await page.getByTestId('content-sentence').allInnerTexts();
    check('Day 11: 번호별 원문 문장 4개가 그대로 보임', sentences.length === 4 && sentences[0].startsWith('1') && sentences[0].includes('I could use a little break right now.') && sentences[3].includes('I am running late again.'), sentences.map((s) => s.split('\n')[1]).join(' | '));
    const chunkTexts = await page.getByTestId('content-chunk').allInnerTexts();
    check('Day 11: 문장 속 Chunk가 따로 보임 (a little break · right now …)', ['a little break', 'right now'].every((c) => chunkTexts.some((t) => t.startsWith(c))), `Chunk ${chunkTexts.length}개`);
    await page.getByTestId('content-chunk').first().locator('summary').click();
    const detail = await page.getByTestId('content-chunk').first().innerText();
    check('Chunk 설명: 문장 속 의미·뉘앙스·쓰는 상황·비슷한 표현·예문', ['문장 속 의미', '뉘앙스', '쓰는 상황', '비슷한 표현'].every((k) => detail.includes(k)) && /—/.test(detail));
    await page.getByTestId('select-sentence').first().click();
    await page.getByTestId('select-chunk').first().click();
    await page.waitForTimeout(500);
    check('문장과 Chunk를 각각 고를 수 있음', /고른 문장 1 · 고른 Chunk 1/.test(await page.getByTestId('content-counts').innerText()));
    await page.screenshot({ path: `${SHOTS}/content-01-day11.png`, fullPage: true });

    // ── 일반 영상 ──
    await page.goto(`${BASE}/videos/g01?tab=sentences`);
    await page.getByTestId('study-content').waitFor();
    const gText = await page.getByTestId('study-content').innerText();
    check('일반 영상: "일반 영상"으로 구분, 맥락에서 고른 문장(고유명사 문장 제외)', gText.includes('일반 영상') && gText.includes('no big deal') && !gText.includes('The office is in Seoul.'));
    check('일반 영상 요청은 general, Day 영상은 day로 보냄', tasks.find((t) => t.videoId === 'eeeeeeeeeee')?.seriesKind === 'general' && tasks.find((t) => t.videoId === 'eNODHkrNuDA')?.seriesKind === 'day');
    await page.screenshot({ path: `${SHOTS}/content-02-general.png`, fullPage: true });

    // ── Day 13: 기존 핵심 문장은 그대로, 같은 문장은 연결만 ──
    await page.goto(`${BASE}/videos/c13?tab=sentences`);
    await page.getByTestId('study-content').waitFor();
    const d13 = await page.getByTestId('study-content').innerText();
    check('Day 13: 기존 핵심 문장과 같은 문장은 새로 만들지 않고 연결(직접 고른 핵심 문장 표시)', d13.includes('직접 고른 핵심 문장'));

    // ── 통합 대화문 ──
    await page.goto(`${BASE}/dialogues`);
    await page.getByRole('tab', { name: /여러 Day 조합/ }).click();
    await page.getByTestId('combine-cta').getByRole('link', { name: '만들기' }).click();
    await page.getByTestId('combine-page').waitFor();
    const pressed = async (k) => (await page.getByTestId(`group-${k}`).getAttribute('aria-pressed')) === 'true';
    check('기본 추천: 최근 학습한 Day 13·12·11 (Day 5·일반 영상은 선택 안 됨)', (await pressed('day-13')) && (await pressed('day-12')) && (await pressed('day-11')) && !(await pressed('day-5')));
    const summary0 = await page.getByTestId('combine-summary').innerText();
    // 미리 체크: Day 11의 could use(복습 기록 있음) + 고른 Chunk
    check('미리 체크는 학습함·고름인 Chunk만', /고른 Chunk 1개|고른 Chunk 2개/.test(summary0), summary0);
    // Day 12, Day 13에서 하나씩 더 고름
    for (const k of ['day-12', 'day-13']) {
      const card = page.locator('[data-testid="combine-page"] section').nth(1).locator('div.space-y-3 > div').filter({ hasText: k === 'day-12' ? 'Day 12' : 'Day 13' });
      await card.getByTestId('combine-chunk').first().check();
    }
    const summary = await page.getByTestId('combine-summary').innerText();
    check('서로 다른 Day 3곳에서 Chunk 선택', /Day\/영상 3곳/.test(summary), summary);
    await page.screenshot({ path: `${SHOTS}/content-03-combine.png`, fullPage: true });
    await page.getByTestId('combine-generate').click();
    await page.waitForURL(/\/dialogues\/dlg-ai-/, { timeout: 60000 });
    await page.getByTestId('chunk-usages').waitFor();
    const det = await page.locator('main').innerText();
    check('대화문 상세: 출처 Day 표시', /Day 11/.test(det) && /Day 12/.test(det));
    const usages = await page.getByTestId('chunk-usages').innerText();
    check('사용한 Chunk별 원본 Day·이 상황의 의미·뉘앙스·쓴 이유·응용 예문', /Day \d+에서 배움/.test(usages) && ['이 상황의 의미', '뉘앙스', '쓴 이유', '응용'].every((k) => usages.includes(k)));
    check('대화문에 한국어 번역', /그게 바로/.test(det));
    check('대화 속 Chunk 노란 표시', (await page.locator('main mark').count()) >= 2);
    await page.screenshot({ path: `${SHOTS}/content-04-dialogue.png`, fullPage: true });

    const after = await dumpDb(page);
    const dlg = after.tables.dialogues.find((d) => d.id.startsWith('dlg-ai-'));
    const items = byId(after.tables.learningItems);
    check('저장: 통합 대화문이 사용 Chunk id·출처 Day를 기록', dlg && dlg.chunkUsages.length >= 2 && dlg.chunkUsages.every((u) => items[u.learningItemId]) && dlg.sourceDays.length >= 2, dlg ? `Day ${dlg.sourceDays.join(',')}` : '');
    const chunks = after.tables.learningItems.filter((i) => i.kind === 'chunk');
    const ks = byId(after.tables.keySentences);
    check('저장: Chunk는 원본 문장·영상·Day와 연결', chunks.length > 0 && chunks.every((c) => ks[c.sentenceId] && c.videoId && (c.dayNumber || c.videoId === 'g01')));
    check('AI 요청: 학습 자료 5번(영상당 1번) + 대화문 1개 식별자', new Set(tasks.filter((t) => t.task === 'pack').map((t) => t.key)).size === 5 && new Set(tasks.filter((t) => t.task === 'dialogue').map((t) => t.key)).size === 1);

    // 기존 데이터 보존
    for (const t of ['videos', 'transcripts', 'reviewStates', 'dialogueProgress', 'studyLogs', 'playlists', 'expressionNotes']) check(`기존 ${t} 그대로`, same(byId(after.tables[t]), byId(before.tables[t])));
    for (const t of ['keySentences', 'expressions', 'dialogues']) {
      const a = byId(after.tables[t]);
      const kept = Object.entries(byId(before.tables[t])).every(([id, r]) => same(a[id], r));
      check(`기존 ${t} 그대로 (새 기록만 추가)`, kept, `추가 ${after.tables[t].length - before.tables[t].length}개`);
    }
    check('DB 버전 그대로 (업그레이드 없음)', after.version === before.version, String(after.version));

    // 휴대폰 화면
    const phone = await browser.newContext({ ...devices['iPhone 13'] });
    await phone.route(/^https:\/\/(i\.ytimg\.com|www\.youtube(-nocookie)?\.com)\//, (r) => r.fulfill({ status: 200, body: '' }));
    const pp = await phone.newPage();
    await pp.goto(BASE);
    await pp.locator('main').first().waitFor();
    await pp.goto(`${BASE}/dialogues/combine`);
    await pp.getByTestId('combine-page').waitFor();
    const overflow = await pp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check('휴대폰: 통합 대화문 화면 가로 넘침 없음', !overflow);
    await pp.screenshot({ path: `${SHOTS}/content-05-phone.png`, fullPage: true });
    await phone.close();

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
