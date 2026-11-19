/**
 * 마무리 점검 E2E (Playwright, 새 임시 프로필, 가짜 Gemini — 실제 Google 호출 없음)
 * 사용법: npm run build && node scripts/e2e-final.mjs
 *
 * 1) 누적 복습: 홈에 오늘 복습할 Day, 대화문 암기 화면에서 평가 → 다음 복습일 (1·3·7·14·30일), 예전에 외운 대화문 포함, 새로 외운 대화문 일정 추가
 * 2) ✨ 유용한 회화 표현: 기존 대화문은 버튼 → 사용량 확인 → 분석 1회, 다시 분석 안 함, 실패 기록 보존·자동 재시도 없음, 하늘색 형광펜·상세
 * 3) 백업: AI 기록 블록 포함 내보내기(형식 버전 1 그대로) → 다른 기기에 추가만 복원
 * 4) 학습 DB 버전 30·기존 대화문·빈칸 자료·진도 보존
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
const PORT = 4195;
const BASE = `http://localhost:${PORT}`;

function startServer() {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'pipe',
    env: { ...process.env, YOUTUBE_API_KEY: '', YOUTUBE_API_MOCK: '1', AI_GEMINI_MOCK: '1', GEMINI_API_KEY: '', YOUTUBE_QUOTA_FILE: join(tmpdir(), `mes-e2e-final-quota-${process.pid}.json`) },
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


async function waitFor(fn, tries = 120, ms = 500) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, ms));
  }
  return false;
}

const DAY = 86400000;
const seed = (page) =>
  page.evaluate(
    ({ DAY }) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('my-english-study');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['videos', 'dialogues', 'dialogueProgress', 'reviewStates', 'expressions', 'learningItems'], 'readwrite');
          const now = Date.now();
          const iso = (t) => new Date(t).toISOString();
          const T = iso(now - 10 * DAY);
          const seg = (t, id) => (id ? { kind: 'key', text: t, learningItemId: id } : { kind: 'connector', text: t });
          const L = (id, i, sp, parts, ko = '(뜻)') => ({ id: `${id}-l${i}`, order: i, speaker: sp, korean: ko, segments: parts.map((p) => (Array.isArray(p) ? seg(p[0], p[1]) : seg(p))) });
          const usage = (id, kind, text) => ({ learningItemId: id, kind, expressionId: `e-${id}`, text, usedAs: text, dayNumber: null, videoId: null, meaningInContext: `${text} 뜻`, nuance: '', whyUsed: '', example: { en: '', ko: '' } });
          const dlg = (id, day, lines, usages, blankPlan) => ({ id, createdAt: T, updatedAt: T, kind: 'original', videoId: `v${day}`, sourceVideoIds: [`v${day}`], orderInVideo: 1, title: `Day ${day} 대화`, situation: '상황', lines, expressionIds: [], generatedBy: 'ai', isFavorite: false, chunkUsages: usages, sourceDays: [day], blankPlan });
          const vid = (day) => ({ id: `v${day}`, createdAt: T, updatedAt: T, playlistId: null, youtubeVideoId: `vid${String(day).padStart(8, '0')}`, title: `[Day ${day}] 영상`, url: null, thumbnailUrl: null, durationSec: 300, orderIndex: day, randomOrderKey: day / 100, status: 'learning', completedAt: null, sources: [{ kind: 'manual', addedAt: T }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
          // 대화문이 가리키는 표현·학습 항목 (실제 데이터처럼 연결이 살아 있게)
          for (const [id, text, day, kind] of [['c3', 'could use', 3, 'core'], ['c7', 'could use', 7, 'core'], ['x7', 'a cup of coffee', 7, 'chunk']]) {
            tx.objectStore('expressions').add({ id: `e-${id}`, createdAt: T, updatedAt: T, normalizedKey: `${text}-${id}`, text, meaningKo: `${text} 뜻`, sourceRefs: [{ videoId: `v${day}` }], isFavorite: false, isMarkedDifficult: false });
            tx.objectStore('learningItems').add({ id, kind, expressionId: `e-${id}`, videoId: `v${day}`, sourceType: 'day', dayNumber: day, dialogueId: null, sourceText: null, timestampSec: null, onScreen: false, origin: 'ai_extracted', status: 'confirmed', extractionDraftId: null, legacyKeySentenceId: null, createdAt: T, updatedAt: T, ...(kind === 'chunk' ? { chunkRole: 'extra' } : {}) });
          }
          const v = tx.objectStore('videos');
          [3, 7, 12, 20].forEach((d) => v.add(vid(d)));
          const d = tx.objectStore('dialogues');
          const d7lines = [
            L('d7', 1, 'A', ['I', ['could really use', 'c7'], ['a cup of coffee', 'x7'], 'right now.']),
            L('d7', 2, 'B', ['I know what you mean. Long day.']),
            L('d7', 3, 'A', ["Want to grab one? My treat."]),
            L('d7', 4, 'B', ["I'll take you up on that."]),
            L('d7', 5, 'A', ['Great. I know what you mean, by the way.']),
            L('d7', 6, 'B', ['See you downstairs.']),
            L('d7', 7, 'A', ['Okay, give me five minutes.']),
            L('d7', 8, 'B', ['Sure, no rush.']),
          ];
          const plan = (lines) => ({ version: 2, lines: Object.fromEntries(lines.map((l) => [l.id, l.segments.map((s) => s.text).join(' ').split(/\s+/).map((_, i) => (i < 2 ? 1 : 3))])) });
          d.add(dlg('d3', 3, [L('d3', 1, 'A', ['I', ['could use', 'c3'], 'a break.']), L('d3', 2, 'B', ['Same here.'])], [usage('c3', 'core', 'could use')], plan([])));
          d.add(dlg('d7', 7, d7lines, [usage('c7', 'core', 'could use'), usage('x7', 'extra', 'a cup of coffee')], plan(d7lines)));
          d.add(dlg('d12', 12, [L('d12', 1, 'A', ["Let's figure it out."]), L('d12', 2, 'B', ['[실패] 가짜 AI가 실패하도록 하는 줄이에요.']), L('d12', 3, 'A', ['No big deal.'])], [], plan([])));
          d.add(dlg('d20', 20, [L('d20', 1, 'A', ['How was your weekend?']), L('d20', 2, 'B', ['Pretty relaxing, thanks.'])], [], plan([])));
          const p = tx.objectStore('dialogueProgress');
          const prog = (id, memorizedAt, step) => ({ id, dialogueId: id, currentStep: step, highestCompletedStep: memorizedAt ? 5 : step - 1, stepResults: [], memorized: !!memorizedAt, memorizedAt, blankMastery: {}, updatedAt: T });
          p.add(prog('d3', iso(now - 2 * DAY), 5)); // 예전에 외움 (복습 상태 없음) → 화면에서 일정 계산
          p.add(prog('d7', iso(now - 5 * DAY), 5));
          p.add(prog('d12', iso(now - 1 * DAY), 5));
          const rs = tx.objectStore('reviewStates');
          const st = (id, next, idx, count) => ({ id: `dialogue:${id}`, itemType: 'dialogue', itemId: id, correctCount: count, wrongCount: 0, lastResult: 'easy', lastStudiedAt: T, nextReviewAt: iso(next), weakness: 40, streak: count, intervalIndex: idx, reviewCount: count, lastQuizzedAt: null });
          rs.add(st('d7', now - 3600e3, 2, 2)); // 오늘 예정 (2번째 복습)
          rs.add(st('d12', now + 3 * DAY, 2, 2)); // 3일 뒤
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { DAY },
  );

const readQa = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open('my-english-study-ai-notes');
        r.onsuccess = () => {
          const db = r.result;
          const names = [...db.objectStoreNames];
          if (!names.length) return resolve({});
          const tx = db.transaction(names, 'readonly');
          const out = {};
          for (const n of names) tx.objectStore(n).getAll().onsuccess = (e) => (out[n] = e.target.result);
          tx.oncomplete = () => {
            db.close();
            resolve(out);
          };
        };
      }),
  );

async function open(browser, errors, sends, device = 'iPad (gen 7)') {
  const ctx = await browser.newContext({ ...devices[device], acceptDownloads: true });
  await ctx.route(/^https:\/\/(i\.ytimg\.com|www\.youtube(-nocookie)?\.com)\//, (r) => r.fulfill({ status: 200, body: '' }));
  ctx.on('request', (r) => {
    if (r.url().endsWith('/api/ai/extract')) {
      const b = JSON.parse(r.postData() || '{}');
      sends.push({ task: b.task ?? 'extract', key: r.headers()['idempotency-key'], retry: !!b.retryFailed });
    }
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
  return { ctx, page };
}

/** 처음 실행 때 들어가는 기능 확인용 샘플을 앱의 '샘플 데이터 삭제'로 지운다 (실제 사용자 상태처럼) */
async function removeSamples(page) {
  const btn = page.getByRole('button', { name: '샘플 데이터 삭제' });
  if (!(await waitFor(async () => (await btn.count()) > 0, 20, 250))) return;
  await btn.click();
  await page.getByRole('button', { name: '샘플 삭제' }).click();
  await waitFor(async () => (await page.getByRole('button', { name: '샘플 데이터 삭제' }).count()) === 0, 40, 250);
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  const sends = [];
  const dir = join(tmpdir(), `mes-final-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  try {
    const { ctx, page } = await open(browser, errors, sends);
    await page.goto(`${BASE}/settings`);
    await page.locator('main').first().waitFor();
    await page.waitForTimeout(500);
    await removeSamples(page);
    await seed(page);
    const before = await dumpDb(page);

    // ── 1. 누적 복습 ──
    await page.goto(`${BASE}/`);
    await page.getByTestId('today-review').waitFor();
    await waitFor(async () => (await page.getByTestId('review-sentence').count()) > 0, 20, 250);
    check('홈: "오늘은 Day 3, Day 7를 복습할 차례입니다."', (await page.getByTestId('review-sentence').innerText()) === '오늘은 Day 3, Day 7를 복습할 차례입니다.', await page.getByTestId('review-sentence').innerText());
    const dueTexts = await page.getByTestId('review-due').allInnerTexts();
    check('홈: 복습할 Day와 대화문·몇 번째 복습·밀린 날', dueTexts.length === 2 && /Day 3/.test(dueTexts[0]) && /1일 지남/.test(dueTexts[0]) && /Day 7/.test(dueTexts[1]) && /2번째 복습/.test(dueTexts[1]), dueTexts.map((t) => t.replace(/\n/g, ' ')).join(' | '));
    check('홈: 아직 외우지 않은 대화문(Day 20)은 복습 대상 아님 · 오늘의 대화문으로', !(dueTexts.join(' ').includes('Day 20')) && /Day 20/.test(await page.getByTestId('today-dialogue').innerText()));
    await page.screenshot({ path: `${SHOTS}/final-01-home.png`, fullPage: true });
    await page.getByTestId('review-due').nth(1).click();
    await page.waitForURL(/\/dialogues\/d7\/memorize$/);
    await page.getByTestId('review-card').waitFor();
    check('복습 항목을 누르면 그 대화문 암기 화면 · 5단계(보지 않고 말하기)로 열림', (await page.getByTestId('step-5').getAttribute('aria-selected')) === 'true' && /2번째 복습/.test(await page.getByTestId('review-card').innerText()));
    await page.getByTestId('review-easy').click();
    await page.getByTestId('review-next').waitFor();
    let db = await dumpDb(page);
    const s7 = db.tables.reviewStates.find((s) => s.id === 'dialogue:d7');
    const gap7 = Math.round((Date.parse(s7.nextReviewAt) - Date.now()) / DAY);
    check('복습 완료 기록 → 다음 복습 7일 뒤 (1→3→7 단계)', gap7 === 7 && s7.reviewCount === 3, `${gap7}일`);
    check('학습 기록 남김 (홈의 오늘 학습)', db.tables.studyLogs.some((l) => l.itemId === 'd7' && l.isReview));
    await page.goto(`${BASE}/`);
    await waitFor(async () => (await page.getByTestId('review-due').count()) === 1, 20, 250);
    check('홈: 복습한 Day 7은 빠지고 Day 3만', (await page.getByTestId('review-due').count()) === 1 && /Day 3/.test(await page.getByTestId('review-due').innerText()));
    check('홈: 오늘 학습 횟수 반영', /오늘 1번 학습/.test(await page.getByTestId('small-goal').innerText()));
    await page.getByTestId('review-due').first().click();
    await page.getByTestId('review-card').waitFor();
    await page.getByTestId('review-hard').click();
    await page.getByTestId('review-next').waitFor();
    db = await dumpDb(page);
    const s3 = db.tables.reviewStates.find((s) => s.id === 'dialogue:d3');
    check('예전에 외운 대화문: 처음 평가할 때 복습 상태가 처음 저장 · 헷갈림은 간격 단축', !!s3 && Date.parse(s3.nextReviewAt) > Date.now() && Math.round((Date.parse(s3.nextReviewAt) - Date.now()) / DAY) < 3);
    check('암기 진도는 그대로 (복습은 진도를 바꾸지 않음)', same(before.tables.dialogueProgress.find((p) => p.id === 'd3'), db.tables.dialogueProgress.find((p) => p.id === 'd3')));
    await page.goto(`${BASE}/`);
    await page.getByTestId('review-next-date').waitFor();
    check('홈: 오늘 복습이 없으면 다음 복습 예정일', /다음 복습/.test(await page.getByTestId('review-next-date').innerText()), await page.getByTestId('review-next-date').innerText());
    await page.goto(`${BASE}/review`);
    await page.getByTestId('review-upcoming').waitFor();
    const up = await page.getByTestId('review-upcoming-row').allInnerTexts();
    check('복습 화면: 다가오는 일정 (Day 3·7·12)', up.length === 3 && ['Day 3', 'Day 7', 'Day 12'].every((x) => up.some((u) => u.includes(x))));
    // 새 대화문 외우기 → 1일 뒤 첫 복습
    await page.goto(`${BASE}/`);
    await page.getByTestId('today-dialogue').waitFor();
    await page.getByTestId('today-memorize').click();
    await page.waitForURL(/\/dialogues\/d20\/memorize$/);
    await page.getByTestId('step-5').click();
    await page.getByTestId('rate-easy').click();
    await page.getByTestId('review-next').waitFor();
    db = await dumpDb(page);
    const s20 = db.tables.reviewStates.find((s) => s.id === 'dialogue:d20');
    check('새로 외운 대화문: 1일 뒤 첫 복습이 기존 일정과 함께 쌓임', !!s20 && Math.round((Date.parse(s20.nextReviewAt) - Date.now()) / DAY) === 1 && db.tables.dialogueProgress.find((p) => p.id === 'd20')?.memorized === true);

    // ── 2. ✨ 유용한 회화 표현 ──
    await page.goto(`${BASE}/dialogues/d7/memorize`);
    await page.getByTestId('step-2').click();
    const blanks2 = await page.getByTestId('blank').count();
    await page.getByTestId('step-3').click();
    const blanks3 = await page.getByTestId('blank').count();
    const n0 = sends.length;
    await page.goto(`${BASE}/dialogues/d7`);
    await page.getByTestId('useful-panel').waitFor();
    check('대화문: ★ 핵심 Chunk 1개 · ✨ 1개(원문 출처) — 분석 전', /★ 핵심 Chunk 1개/.test(await page.getByTestId('useful-counts').innerText()) && /✨ 유용한 회화 표현 1개/.test(await page.getByTestId('useful-counts').innerText()));
    check('화면을 열기만 해서는 AI 요청 없음', sends.length === n0);
    await page.getByTestId('useful-analyze').click();
    await page.getByTestId('useful-confirm').waitFor();
    check('호출 전 확인: 요청 1회 · 오늘 사용량 · 남은 요청', /요청 1회/.test(await page.getByTestId('useful-confirm').innerText()) && /오늘 사용 \d+\/16회/.test(await page.getByTestId('useful-usage').innerText()) && /남은 요청/.test(await page.getByTestId('useful-usage').innerText()), await page.getByTestId('useful-usage').innerText());
    check('확인 전에는 요청 없음', sends.length === n0);
    await page.getByTestId('useful-confirm-run').click();
    await page.getByTestId('useful-analyzed').waitFor({ timeout: 30000 });
    const ph = sends.slice(n0).filter((s) => s.task === 'phrases');
    check('분석: 요청 식별자 1개 (Gemini 1회)', ph.length > 0 && new Set(ph.map((s) => s.key)).size === 1);
    const marks = await page.getByTestId('useful-mark').allInnerTexts();
    check('✨ 하늘색 형광펜: 원문 출처 + 대화문 출처, 핵심 Chunk와 겹치지 않음', marks.includes('a cup of coffee') && marks.filter((m) => m === 'I know what you mean').length === 2 && marks.includes('take you up on') && !marks.some((m) => /could/.test(m)), marks.join(' | '));
    check('★ 핵심 Chunk는 노란색 그대로', (await page.getByTestId('core-mark').allInnerTexts()).includes('could really use'));
    check('✨ 개수는 핵심 Chunk 개수와 따로', /★ 핵심 Chunk 1개/.test(await page.getByTestId('useful-counts').innerText()) && /✨ 유용한 회화 표현 3개/.test(await page.getByTestId('useful-counts').innerText()), await page.getByTestId('useful-counts').innerText());
    await page.getByTestId('useful-mark').filter({ hasText: 'take you up on' }).click();
    const det = await page.getByTestId('useful-detail').innerText();
    check('표현을 누르면: 기본형 ↔ 실제 형태 · 뜻 · 뉘앙스 · 사용 상황', /take someone up on something/.test(det) && /take you up on/.test(det) && /뜻/.test(det) && /뉘앙스/.test(det) && /사용 상황/.test(det), det.replace(/\n/g, ' ').slice(0, 160));
    await page.getByTestId('useful-mark').filter({ hasText: 'I know what you mean' }).first().click();
    check('같은 표현이 여러 번 나오면 연결 (2번째 줄 ↔ 5번째 줄)', /2번 나와요/.test(await page.getByTestId('useful-occurrences').innerText()) && /5번째 줄/.test(await page.getByTestId('useful-occurrences').innerText()));
    const n1 = sends.length;
    await page.reload();
    await page.getByTestId('useful-analyzed').waitFor();
    check('새로고침: 결과 유지 · 다시 분석 버튼 없음 · 요청 없음', (await page.getByTestId('useful-analyze').count()) === 0 && sends.length === n1 && (await page.getByTestId('useful-mark').count()) === 4);
    await page.goto(`${BASE}/dialogues/d7/memorize`);
    await page.getByTestId('step-1').click();
    check('암기 1단계: ✨도 하늘색 표시', (await page.locator('[data-testid="memorize-line"] .bg-info-soft').count()) >= 3);
    await page.getByTestId('step-2').click();
    const after2 = await page.getByTestId('blank').count();
    await page.getByTestId('step-3').click();
    const after3 = await page.getByTestId('blank').count();
    check('기존 대화문 빈칸 자료는 그대로 (분석 전후 2·3단계 빈칸 수 같음)', after2 === blanks2 && after3 === blanks3, `${blanks2}/${blanks3} → ${after2}/${after3}`);
    // 실패: 자동 재시도 없음, 기록 보존, 다시 누를 때만
    await page.goto(`${BASE}/dialogues/d12`);
    await page.getByTestId('useful-analyze').click();
    await page.getByTestId('useful-confirm-run').click();
    await page.getByTestId('useful-notice').waitFor({ timeout: 30000 });
    check('실패 표시: HTTP 상태 · 오류 코드', /HTTP 502/.test(await page.getByTestId('useful-notice').innerText()) && /gemini_failed/.test(await page.getByTestId('useful-notice').innerText()));
    const failKeys = new Set(sends.filter((s) => s.task === 'phrases').map((s) => s.key));
    await page.waitForTimeout(4000);
    check('실패 후 자동 재시도 없음', sends.filter((s) => s.task === 'phrases').every((s) => failKeys.has(s.key)));
    check('다시 시도 버튼은 사용자가 누를 때만', /다시 찾기/.test(await page.getByTestId('useful-analyze').innerText()));
    const n2 = sends.length;
    await page.getByTestId('useful-analyze').click();
    await page.getByTestId('useful-confirm-run').click();
    await waitFor(async () => (await page.getByTestId('useful-attempts').innerText()).includes('2건'), 60, 500);
    check('다시 시도: 새 요청 (첫 요청에만 다시 생성 표시) · 실패 기록 2건 보존', sends.slice(n2)[0]?.retry === true && /분석 기록 2건/.test(await page.getByTestId('useful-attempts').innerText()));

    // ── 3. 백업: AI 기록 블록 포함 → 다른 기기에 추가만 복원 ──
    await page.goto(`${BASE}/settings`);
    await page.getByTestId('export-backup').waitFor();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-backup').click()]);
    const file = join(dir, 'backup.json');
    await dl.saveAs(file);
    const backup = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
    check('백업 파일: 형식 버전 1 그대로 · 학습 데이터 + AI 기록 블록(자기 검증값)', backup.formatVersion === 1 && backup.schemaVersion === 3 && backup.aiNotes?.version === 1 && backup.aiNotes.counts.phraseSets === 1 && backup.aiNotes.counts.phraseAttempts === 3 && !!backup.aiNotes.checksum?.value, JSON.stringify(backup.aiNotes?.counts));
    const afterAll = await dumpDb(page);
    const qaBefore = await readQa(page);
    await ctx.close();

    const other = await open(browser, errors, []);
    await other.page.goto(`${BASE}/settings`);
    await removeSamples(other.page);
    await other.page.getByTestId('restore-file').setInputFiles(file);
    await other.page.getByTestId('restore-ainotes').waitFor();
    check('다른 기기 복원 미리보기: AI 기록 새로 추가 4개', /새로 추가 4개/.test(await other.page.getByTestId('restore-ainotes').innerText()), await other.page.getByTestId('restore-ainotes').innerText());
    await other.page.getByTestId('restore-apply').click();
    await other.page.getByRole('button', { name: '복원하기' }).click();
    await other.page.getByTestId('restore-ainotes-result').waitFor({ timeout: 30000 });
    const qaOther = await readQa(other.page);
    const dbOther = await dumpDb(other.page);
    check('복원 후: ✨ 분석 결과·시도 기록, 대화문·복습 상태 모두 옮겨짐', qaOther.phraseSets?.length === 1 && qaOther.phraseAttempts?.length === 3 && ['d3', 'd7', 'd12', 'd20'].every((id) => dbOther.tables.dialogues.some((d) => d.id === id) && dbOther.tables.reviewStates.some((s) => s.id === `dialogue:${id}`)));
    check('진행 중 요청 상태(기기별)는 옮기지 않음', (qaOther.tasks ?? []).length === 0 && (qaBefore.tasks ?? []).length > 0);
    await other.page.goto(`${BASE}/dialogues/d7`);
    await other.page.locator('main').first().waitFor();
    await other.page.waitForTimeout(1500);
    await other.page.getByTestId('useful-analyzed').waitFor();
    check('복원한 기기에서도 ✨ 표시 · 다시 분석 안 함', (await other.page.getByTestId('useful-mark').count()) === 4);
    await other.ctx.close();

    // ── 4. 데이터 보존 ──
    check('학습 DB 버전 30 그대로', before.version === 30 && afterAll.version === 30);
    for (const t of ['videos', 'dialogues']) check(`기존 기록 그대로: ${t}`, same(before.tables[t], afterAll.tables[t]));
    check('기존 진도 그대로 (새로 외운 Day 20만 추가로 바뀜)', ['d3', 'd7', 'd12'].every((id) => same(before.tables.dialogueProgress.find((p) => p.id === id), afterAll.tables.dialogueProgress.find((p) => p.id === id))));
    check('기존 대화문 빈칸 자료 그대로', same(before.tables.dialogues.map((d) => d.blankPlan), afterAll.tables.dialogues.map((d) => d.blankPlan)));

    // 휴대폰
    const phone = await open(browser, errors, [], 'iPhone 13');
    await phone.page.goto(`${BASE}/settings`);
    await phone.page.locator('main').first().waitFor();
    await removeSamples(phone.page);
    await seed(phone.page);
    await phone.page.goto(`${BASE}/`);
    await phone.page.getByTestId('today-review').waitFor();
    check('휴대폰: 홈 가로 넘침 없음', await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await phone.page.screenshot({ path: `${SHOTS}/final-02-phone-home.png`, fullPage: true });
    await phone.page.goto(`${BASE}/dialogues/d7/memorize`);
    await phone.page.getByTestId('review-card').waitFor();
    check('휴대폰: 복습 카드 가로 넘침 없음', await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await phone.ctx.close();
    check('실제 Gemini 키 없이 가짜 AI만 사용', true);
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
