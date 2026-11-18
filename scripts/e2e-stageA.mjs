/**
 * A단계 E2E 점검 (Playwright) — 디자인 시스템 · 홈 · 메뉴 개편
 * 사용법: npm run build && npm run e2e:stageA
 *
 * - iPad 세로(하단 탭)·가로(사이드바) 메뉴 구조
 * - 홈: 오늘의 대화문 · 작은 목표 · 오늘 다시 만나면 좋아요(최대 3개) · 성장 기록 · 응원 문구
 * - 압박·실패 표현 없음, 가로 넘침·화면 축소 없음, 브라우저 오류 없음
 * - 모든 화면을 둘러본 전후로 IndexedDB의 모든 테이블이 값까지 같은지 (A단계는 데이터 변경 없음)
 * 외부 서비스는 호출하지 않는다.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const SHOTS = 'e2e-screenshots';
mkdirSync(SHOTS, { recursive: true });
const PORT = 4184;
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

/** IndexedDB 전체 덤프 (모든 테이블, 키 순서) — 앱 코드를 거치지 않고 직접 읽는다 */
const dumpDb = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('my-english-study');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const names = [...db.objectStoreNames].sort();
          const tx = db.transaction(names, 'readonly');
          const out = { version: db.version };
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

const fits = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && window.innerWidth <= screen.width + 1);

const PRESSURE = /개 남았|밀린|실패했|연속 학습이 끊|벌칙|순위/;

async function suite(label, device, isPortrait) {
  console.log(`\n── iPad ${label} ──`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...device });
  await context.route(/^https:\/\/(i\.ytimg\.com|www\.youtube(-nocookie)?\.com)\//, (r) => r.fulfill({ status: 200, body: '' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  const overflow = [];
  const settle = async () => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
  };
  const look = async (name) => {
    await settle();
    if (!(await fits(page))) overflow.push(name);
    await page.screenshot({ path: `${SHOTS}/sA-${label}-${name}.png`, fullPage: false });
  };
  const navName = isPortrait ? '하단 메뉴' : '주 메뉴';
  const nav = (name) => page.getByRole('navigation', { name: navName }).getByRole('link', { name, exact: true });

  await page.goto(BASE);
  await page.getByTestId('today-dialogue').waitFor();
  await settle();
  const before = await dumpDb(page);

  // 메뉴 구조
  if (isPortrait) {
    const tabs = await page.getByRole('navigation', { name: '하단 메뉴' }).getByRole('link').allTextContents();
    check('세로: 하단 탭 = 홈·외우기·복습·컬렉션·더보기', JSON.stringify(tabs.map((t) => t.trim())) === JSON.stringify(['홈', '외우기', '복습', '컬렉션', '더보기']), tabs.join(','));
    check('세로: 사이드바 숨김', !(await page.getByRole('navigation', { name: '주 메뉴' }).isVisible()));
  } else {
    const links = (await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link').allTextContents()).map((t) => t.trim());
    check(
      '가로: 사이드바 = 학습 메뉴 4 + 콘텐츠 준비·기록·설정',
      JSON.stringify(links) === JSON.stringify(['홈', '외우기', '복습', '컬렉션', '영상 · 핵심 표현', '표현 노트', '자료 생성', 'Day 정리', '즐겨찾기', '설정']),
      links.join(','),
    );
    check('가로: 하단 탭 숨김', !(await page.getByRole('navigation', { name: '하단 메뉴' }).isVisible()));
  }

  // 홈
  const today = page.getByTestId('today-dialogue');
  check('홈: 오늘의 대화문 + 큰 암기 버튼(5단계 암기 화면으로)', (await visible(today.getByText('저녁 메뉴 정하기'))) && (await today.getByTestId('today-memorize').getAttribute('href'))?.endsWith('/memorize') === true);
  check('홈: 이어서 할 단계 표시', /2단계.*3단계/.test((await page.getByTestId('today-step').textContent()) ?? ''));
  check('홈: 예상 소요 시간', await visible(today.getByText(/약 \d+분/)));
  check('홈: 작은 목표 (실패 표현 없음)', await visible(page.getByTestId('small-goal')));
  const reviewCard = page.getByTestId('today-review');
  check('홈: 오늘의 복습 — 대화문 단위(오늘 복습할 Day 또는 다음 복습일 안내)', (await visible(reviewCard.getByText('오늘의 복습'))) && (await reviewCard.locator('[data-testid="review-sentence"], [data-testid="review-next-date"], [data-testid="review-empty"]').count()) === 1);
  check('홈: 성장 기록 (외운 대화문·모은 핵심 표현·이번 주)', (await visible(page.getByTestId('stat-외운 대화문'))) && (await visible(page.getByTestId('stat-모은 핵심 표현'))) && (await visible(page.getByTestId('stat-이번 주 학습'))));
  const cheer1 = await page.getByTestId('home-cheer').textContent();
  await page.getByRole('button', { name: '톡이에게 다른 응원 듣기' }).click();
  const cheer2 = await page.getByTestId('home-cheer').textContent();
  check('홈: 톡이를 누르면 다른 응원 문구', !!cheer1 && cheer1 !== cheer2, `${cheer1} → ${cheer2}`);
  check('홈: 압박·실패 표현 없음', !PRESSURE.test(await page.locator('main').innerText()));
  await look('01-home');
  await page.screenshot({ path: `${SHOTS}/sA-${label}-01-home-full.png`, fullPage: true });

  // 오늘의 대화문 → 상세
  await today.getByRole('link', { name: /대화문 먼저 읽어 보기/ }).click();
  check('대화문 먼저 읽어 보기 → 대화문 상세', await visible(page.getByRole('heading', { name: '저녁 메뉴 정하기' })));
  await look('02-dialogue-detail');

  // 외우기
  await nav('외우기').click();
  check('외우기: 대화문 목록', await visible(page.getByRole('heading', { name: '외우기' })));
  await look('03-dialogues');

  // 복습
  await nav('복습').click();
  await page.getByRole('heading', { name: '복습', exact: true }).waitFor();
  await look('04-review');

  // 컬렉션
  await nav('컬렉션').click();
  check('컬렉션: 톡이 + 정복한 대화문', (await visible(page.getByTestId('toki-card'))) && (await visible(page.getByTestId('collection-list').getByText('늦게 온 친구와 이사 이야기'))));
  check('컬렉션: 압박·순위 표현 없음', !PRESSURE.test((await page.locator('main').innerText()).replace('순위나 비교는 없어요', '')));
  await look('05-collection');

  // 콘텐츠 준비·기록·설정 (세로는 더보기 안)
  const goSecondary = async (name) => {
    if (isPortrait) {
      await nav('더보기').click();
      await page.getByRole('link', { name: new RegExp(name) }).click();
    } else {
      await nav(name).click();
    }
  };
  if (isPortrait) {
    await nav('더보기').click();
    check('더보기: 콘텐츠 준비·내 기록·앱 묶음', (await visible(page.getByRole('region', { name: '콘텐츠 준비' }))) && (await visible(page.getByRole('region', { name: '앱' }))));
    await look('06-more');
  }
  await goSecondary('영상 · 핵심 표현');
  await page.getByRole('heading', { name: '영상', exact: true }).waitFor();
  check('영상(콘텐츠 준비): 기존 영상 3개 유지', (await page.getByTestId('video-list').locator('li').count()) === 3);
  await look('07-videos');
  await page.getByTestId('video-list').getByText('[샘플] 친구와 나누는 일상 안부 표현 5가지').click();
  for (const [tab, name] of [['주요 표현', '08-video-notes'], ['원문·Chunk', '09-video-sentences'], ['대화문', '10-video-dialogues'], ['자막', '11-video-transcript']]) {
    await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
    await look(name);
  }
  check('영상 상세: 3단계 핵심 문장 화면 유지', (await page.getByRole('tab', { name: /^원문·Chunk/ }).count()) === 1);
  await goSecondary('표현 노트');
  await page.getByRole('heading', { name: '표현 노트' }).waitFor();
  await look('12-expressions');
  await goSecondary('즐겨찾기');
  await page.getByRole('heading', { name: '즐겨찾기' }).waitFor();
  await look('13-favorites');
  await goSecondary('설정');
  await page.getByRole('heading', { name: '설정' }).waitFor();
  await look('14-settings');

  // 새로고침해도 같음
  await page.goto(BASE);
  await page.getByTestId('today-dialogue').waitFor();
  await settle();
  const after = await dumpDb(page);
  const tables = Object.keys(before).filter((k) => k !== 'version');
  const changed = tables.filter((t) => JSON.stringify(before[t]) !== JSON.stringify(after[t]));
  // Dexie는 IndexedDB 버전을 (Dexie 버전 × 10)으로 저장한다 → 20 = 스키마 v2
  check('A단계 화면 사용으로 DB 버전이 바뀌지 않음 (B1-a부터 v3)', before.version === after.version && after.version / 10 === 3, `IndexedDB version ${after.version} = Dexie v${after.version / 10}`);
  check(`모든 화면을 둘러본 전후 DB ${tables.length}개 테이블 값까지 동일`, changed.length === 0, changed.join(', '));
  check('가로 넘침·화면 축소 없음 (모든 화면)', overflow.length === 0, overflow.join(', '));
  check('브라우저 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
}

let server;
try {
  server = await startServer();
  await suite('portrait', devices['iPad Pro 11'], true);
  await suite('landscape', devices['iPad Pro 11 landscape'], false);
} catch (e) {
  console.error(e);
  results.push({ name: 'suite crashed', ok: false, detail: String(e) });
} finally {
  server?.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n결과: ${results.length - failed.length}/${results.length} 통과`);
process.exit(failed.length ? 1 : 0);
