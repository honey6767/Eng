/**
 * 3단계 E2E 점검 (Playwright, 아이패드 화면)
 * 사용법: npm run build && npm run e2e:stage3
 *
 * - 핵심 문장 5개 선정 (자막에서 선택 · 여러 줄 합치기 · 일부만 사용 · 직접 입력), 원문 보호, 중복 방지
 * - 핵심 표현 연결 (단어 선택, 자동 위치), 번역·상황 수정, 선정 취소 제한
 * - 주요 표현 노트 직접 입력, 무료 AI 도움(요청문 → 답변 붙여넣기)
 * - 새로고침 후 유지, 기존 학습 데이터(학습 기록·복습 기록·진행도·대화문) 변화 없음
 * 외부 서비스(YouTube·AI)는 호출하지 않는다.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const SHOTS = 'e2e-screenshots';
mkdirSync(SHOTS, { recursive: true });
const PORT = 4183;
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
const visible = (loc, timeout = 6000) => loc.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
async function textMatches(loc, re, timeout = 6000) {
  const end = Date.now() + timeout;
  let last = '';
  while (Date.now() < end) {
    last = ((await loc.first().textContent().catch(() => '')) ?? '').trim();
    if (re.test(last)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`   (text="${last.slice(0, 160)}", expected ${re})`);
  return false;
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/** IndexedDB에서 직접 읽기 (앱 코드를 거치지 않고 저장 상태 확인) */
const readDb = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('my-english-study');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const names = ['studyLogs', 'reviewStates', 'dialogueProgress', 'dialogues', 'keySentences', 'expressionNotes', 'expressions'];
          const tx = db.transaction(names, 'readonly');
          const out = {};
          let left = names.length;
          for (const n of names) {
            const r = tx.objectStore(n).getAll();
            r.onsuccess = () => {
              out[n] = r.result;
              if (--left === 0) {
                db.close();
                resolve(out);
              }
            };
          }
        };
      }),
  );

const TRANSCRIPT = `0:05 Hey everyone, welcome back to the channel.
0:12 Today we're learning five expressions for making plans.
0:20 Do you want to grab a bite later?
0:31 First up, a classic. I'm down
0:34 for whatever.
0:45 It completely slipped my mind.
0:58 Next one. You can't go wrong with that. Trust me.
1:10 Thanks for watching!`;

const AI_ANSWER = `물론이죠! 결과입니다.
\`\`\`json
{
  "sentences": [
    { "order": 1, "korean": "이따 간단히 뭐 좀 먹을래?", "situation": "식사를 제안할 때" },
    { "order": 2, "korean": "AI가 덮어쓰면 안 되는 번역", "situation": "무엇이든 괜찮을 때" }
  ],
  "notes": [
    { "expression": "grab a bite", "meaningKo": "간단히 먹다", "nuance": "가볍고 캐주얼함", "usageContext": "친구에게 식사 제안",
      "examples": [{ "en": "Let's grab a bite after class.", "ko": "수업 끝나고 간단히 먹자." }] }
  ]
}
\`\`\``;

async function run() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPad (gen 7)'] });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await context.route(/i\.ytimg\.com|youtube-nocookie\.com|youtube\.com/, (r) => r.fulfill({ status: 200, body: '' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  const confirmDialog = async (label) => {
    await page.getByRole('alertdialog').getByRole('button', { name: label, exact: true }).click();
  };

  await page.goto(`${BASE}/`);
  await visible(page.getByText('오늘의 학습'), 10000);
  const before = await readDb(page);

  // 샘플 신규 영상 (핵심 문장 없음)
  await page.goto(`${BASE}/videos`);
  await page.getByText('[샘플] 아직 학습하지 않은 신규 영상', { exact: true }).first().click();
  await page.getByRole('tab', { name: /^자막/ }).click();
  await page.getByLabel('자막 붙여넣기').fill(TRANSCRIPT);
  await page.getByRole('button', { name: '자막 저장' }).click();
  check('자막 저장', await visible(page.getByTestId('transcript-segments')));

  await page.getByRole('tab', { name: /^원문·Chunk/ }).click();
  check('핵심 문장 0/5 표시', await textMatches(page.getByTestId('key-sentence-count'), /^0$/));
  await page.screenshot({ path: `${SHOTS}/s3-01-sentences-empty.png` });

  const list = page.getByTestId('transcript-pick-list');
  const pick = (text) => list.getByRole('button', { name: new RegExp(text) }).click();
  const save = async () => {
    await page.getByRole('button', { name: '핵심 문장으로 저장' }).click();
    check('저장 전 “원문은 고칠 수 없음” 확인 창', await visible(page.getByRole('alertdialog').getByText(/영어 원문은 저장한 뒤 고칠 수 없어요/)));
    await confirmDialog('저장');
  };

  // 1) 한 줄 그대로
  await pick('grab a bite later');
  check('저장될 원문 미리보기 = 자막 원문', await textMatches(page.getByTestId('pending-english'), /^Do you want to grab a bite later\?$/));
  await save();
  check('1번째 문장 저장', await textMatches(page.getByTestId('key-sentence-count'), /^1$/));

  // 2) 두 줄로 나뉜 문장 합치기 + 앞부분 빼기
  await pick("I'm down");
  await page.getByRole('button', { name: '다음 줄 포함' }).click();
  const sel = page.getByTestId('transcript-selection');
  await sel.getByRole('button', { name: "I'm", exact: true }).click();
  await sel.getByRole('button', { name: 'whatever', exact: true }).click();
  check('두 줄 합치기 + 일부만 사용', await textMatches(page.getByTestId('pending-english'), /^I'm down for whatever$/));
  await page.screenshot({ path: `${SHOTS}/s3-02-transcript-merge.png` });
  await save();

  // 3) 그대로
  await pick('slipped my mind');
  await save();
  // 4) 일부만
  await pick("can't go wrong");
  await sel.getByRole('button', { name: 'You', exact: true }).click();
  await sel.getByRole('button', { name: 'that', exact: true }).click();
  check('문장 일부만 사용', await textMatches(page.getByTestId('pending-english'), /^You can't go wrong with that$/));
  await save();

  // 중복 방지
  await pick('slipped my mind');
  await page.getByRole('button', { name: '핵심 문장으로 저장' }).click();
  await confirmDialog('저장');
  check('같은 문장 중복 선정 차단', await visible(page.getByText('이미 핵심 문장으로 선정한 문장입니다.')));
  await page.getByRole('button', { name: '선택 취소' }).click();

  // 5) 직접 입력
  await page.getByRole('tab', { name: '직접 입력' }).click();
  await page.getByLabel('영어 문장').fill("I'll take your word for it.");
  await page.getByLabel('영상 시간 입력').fill('1:02');
  await page.getByRole('button', { name: '핵심 문장으로 저장' }).click();
  await confirmDialog('저장');
  check('5개 선정 완료 · 추가 칸 사라짐', (await textMatches(page.getByTestId('key-sentence-count'), /^5$/)) && !(await visible(page.getByTestId('add-key-sentence'), 1000)));
  check('원문 잠금 표시 5개', (await page.getByText('원문 잠김').count()) === 5);

  // 핵심 표현 연결 (단어 선택 → 사전형으로 수정)
  const card = page.getByTestId('key-sentence-card').filter({ hasText: 'slipped my mind' });
  await card.getByRole('button', { name: '+ 핵심 표현 추가' }).click();
  await card.getByRole('button', { name: 'slipped', exact: true }).click();
  await card.getByRole('button', { name: 'mind', exact: true }).click();
  check('단어 선택 → 표현 칸 자동 입력', (await card.getByRole('textbox', { name: '핵심 표현', exact: true }).inputValue()) === 'slipped my mind');
  await card.getByRole('textbox', { name: '핵심 표현', exact: true }).fill('slip my mind');
  await card.getByLabel('표현 뜻').fill('깜빡 잊다');
  await card.getByRole('button', { name: '연결', exact: true }).click();
  check('문장 속 표현 강조 = 실제 형태(slipped my mind)', await textMatches(card.locator('mark'), /^slipped my mind$/));

  // 자동 위치 탐색
  const card2 = page.getByTestId('key-sentence-card').filter({ hasText: 'grab a bite' });
  await card2.getByRole('button', { name: '+ 핵심 표현 추가' }).click();
  await card2.getByRole('textbox', { name: '핵심 표현', exact: true }).fill('grab a bite');
  await card2.getByLabel('표현 뜻').fill('간단히 먹다');
  await card2.getByRole('button', { name: '연결', exact: true }).click();
  check('위치 자동 탐색', await textMatches(card2.locator('mark'), /^grab a bite$/));

  // 번역·상황 수정
  await card.getByRole('button', { name: '번역·상황 수정' }).click();
  await card.getByLabel('번역', { exact: true }).fill('완전히 깜빡했어.');
  await card.getByLabel('사용 상황', { exact: true }).fill('약속을 잊었을 때');
  await card.getByRole('button', { name: '저장', exact: true }).click();
  check('번역·상황 저장', await visible(card.getByText('완전히 깜빡했어.')));
  check('영어 원문 수정 칸 없음', (await card.locator('input[aria-label="영어 문장"], textarea[aria-label="영어 문장"]').count()) === 0);
  await page.screenshot({ path: `${SHOTS}/s3-03-sentences-done.png`, fullPage: true });

  // 주요 표현 노트: 노트 없는 핵심 표현 → 바로 추가
  await page.getByRole('tab', { name: /^주요 표현/ }).click();
  await page.getByRole('button', { name: 'slip my mind' }).click();
  const editor = page.getByTestId('note-editor');
  check('노트 칸 자동 입력 (표현·뜻)', (await editor.getByLabel('노트 표현').inputValue()) === 'slip my mind' && (await editor.getByLabel('노트 뜻').inputValue()) === '깜빡 잊다');
  await editor.getByLabel('노트 뉘앙스').fill("'forget'보다 부드럽고 변명처럼 들리지 않음");
  await editor.getByLabel('노트 사용 상황').fill('약속·할 일을 깜빡했을 때');
  await editor.getByLabel('예문 1 영어').fill('Sorry, your birthday totally slipped my mind.');
  await editor.getByLabel('예문 1 번역').fill('미안, 네 생일을 완전히 깜빡했어.');
  await editor.getByLabel('설명 시간').fill('0:45');
  await editor.getByRole('button', { name: '저장', exact: true }).click();
  const group = page.getByTestId('expression-note-group').filter({ hasText: 'slip my mind' });
  check('표현 노트 저장 (영상 설명)', (await visible(group)) && (await visible(group.getByText('영상 설명'))));

  // 무료 AI 도움
  const ai = page.getByTestId('ai-assist');
  await ai.getByRole('button', { name: '열기' }).click();
  await ai.getByRole('button', { name: '요청문 복사' }).click();
  check('요청문 복사', await visible(page.getByText(/요청문을 복사했어요|직접 복사해 주세요/)));
  await ai.getByRole('button', { name: '요청문 보기' }).click();
  const prompt = await ai.getByLabel('AI 요청문').inputValue();
  check('요청문에 핵심 문장 원문 5개 포함', ["Do you want to grab a bite later?", "I'm down for whatever", 'It completely slipped my mind.', "You can't go wrong with that", "I'll take your word for it."].every((s) => prompt.includes(`"${s}"`)));
  await ai.getByLabel('AI 답변').fill(AI_ANSWER);
  await ai.getByRole('button', { name: '내용 확인' }).click();
  check('AI 답변 해석 미리보기', await textMatches(page.getByTestId('ai-preview'), /번역·상황 제안 2개 · 표현 노트 1개/));
  await page.screenshot({ path: `${SHOTS}/s3-04-ai-assist.png`, fullPage: true });
  await ai.getByRole('button', { name: '3. 저장' }).click();
  const aiGroup = page.getByTestId('expression-note-group').filter({ hasText: 'grab a bite' });
  check('AI 보충 노트 = 확인 필요로 저장', (await visible(aiGroup.getByText('AI 보충'))) && (await visible(aiGroup.getByText('확인 필요'))));

  // 새로고침 후 유지 + 저장 내용 확인
  await page.reload();
  await page.getByRole('tab', { name: /^원문·Chunk/ }).click();
  check('새로고침 후 5개 유지', await textMatches(page.getByTestId('key-sentence-count'), /^5$/));
  check('AI 번역은 빈 칸만 채움', await visible(page.getByText('이따 간단히 뭐 좀 먹을래?')));
  const after = await readDb(page);
  const mine = after.keySentences.filter((s) => !before.keySentences.some((b) => b.id === s.id));
  const englishes = mine.map((s) => s.english).sort();
  check(
    '저장된 원문 5개가 자막 그대로',
    JSON.stringify(englishes) ===
      JSON.stringify(["Do you want to grab a bite later?", "I'll take your word for it.", "I'm down for whatever", 'It completely slipped my mind.', "You can't go wrong with that"].sort()),
    englishes.join(' | '),
  );
  const slip = mine.find((s) => s.english.includes('slipped'));
  const sp = slip?.expressionSpans?.[0];
  check('표현 위치 저장 (글자 위치)', !!sp && slip.english.slice(sp.start, sp.end) === 'slipped my mind');
  check('샘플 영상에 추가한 문장은 샘플로 표시', mine.every((s) => s.isSample === true));

  // 기존 데이터 보존
  const same = (k) => JSON.stringify(after[k]) === JSON.stringify(before[k]);
  check('학습 기록 그대로', same('studyLogs'));
  check('복습 기록 그대로', same('reviewStates'));
  check('5단계 진행도 그대로', same('dialogueProgress'));
  check('대화문 그대로', same('dialogues'));
  const flags = (rows) => rows.map((e) => `${e.id}:${e.isFavorite}:${e.isMarkedDifficult}`);
  check('기존 표현의 즐겨찾기·어려움 표시 그대로', flags(before.expressions).every((f) => flags(after.expressions).includes(f)));

  // 선정 취소: 대화문에서 쓰인 샘플 문장은 불가
  await page.goto(`${BASE}/videos`);
  await page.getByText('[샘플] 친구와 나누는 일상 안부 표현 5가지', { exact: true }).first().click();
  await page.getByRole('tab', { name: /^원문·Chunk/ }).click();
  const used = page.getByTestId('key-sentence-card').first();
  check('대화문에서 쓰인 문장은 선정 취소 불가', (await used.getByRole('button', { name: '선정 취소' }).isDisabled()) && (await visible(used.getByText(/대화문에서 사용 중/))));
  // "I'm running a bit behind" — 표현(running behind) 사이에 다른 단어가 있어 자동으로 찾지 못함 → 직접 지정 안내
  check('자동 위치를 못 찾으면 “위치 지정 필요” 안내 (임의로 강조하지 않음)', (await visible(used.getByText('위치 지정 필요'))) && (await used.locator('mark').count()) === 0);
  const hand = page.getByTestId('key-sentence-card').filter({ hasText: 'need a hand' });
  check('샘플 문장 표현 강조 (자동 위치)', await textMatches(hand.locator('mark'), /^need a hand$/));
  // 직접 위치 지정: running ~ behind
  await used.getByRole('button', { name: '위치 지정' }).click();
  await used.getByRole('button', { name: 'running', exact: true }).click();
  await used.getByRole('button', { name: 'behind', exact: true }).click();
  await used.getByRole('button', { name: '위치 저장' }).click();
  check('직접 위치 지정 → 강조', await textMatches(used.locator('mark'), /^running a bit behind$/));
  check('세로 화면 가로 넘침 없음', await noOverflow(page));
  await page.screenshot({ path: `${SHOTS}/s3-05-sample-sentences.png`, fullPage: true });

  // 가로 화면
  await page.setViewportSize({ width: 1080, height: 810 });
  await page.reload();
  await page.getByRole('tab', { name: /^주요 표현/ }).click();
  check('가로 화면 가로 넘침 없음', await noOverflow(page));
  await page.screenshot({ path: `${SHOTS}/s3-06-landscape-notes.png` });

  check('브라우저 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
}

let server;
try {
  server = await startServer();
  await run();
} catch (e) {
  console.error(e);
  results.push({ name: 'suite crashed', ok: false, detail: String(e) });
} finally {
  server?.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n결과: ${results.length - failed.length}/${results.length} 통과`);
process.exit(failed.length ? 1 : 0);
