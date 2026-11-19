/**
 * 1단계 E2E 점검 스크립트 (Playwright)
 * 사용법: npm run build && npm run e2e
 *  - vite preview 서버를 띄우고 PC/모바일 뷰포트에서 주요 동선과 데이터 저장·불러오기를 검사한다.
 *  - 스크린샷은 e2e-screenshots/ 에 저장된다.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const PORT = 4179;
const BASE = `http://localhost:${PORT}`;
const SHOTS = 'e2e-screenshots';
mkdirSync(SHOTS, { recursive: true });

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('preview server timeout')), 15000);
  server.stdout.on('data', (d) => {
    if (String(d).includes(String(PORT))) {
      clearTimeout(t);
      resolve();
    }
  });
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 요소가 나타날 때까지 기다린 뒤 true/false */
async function visible(locator, timeout = 5000) {
  return locator.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
}
async function hidden(locator, timeout = 5000) {
  return locator.first().waitFor({ state: 'hidden', timeout }).then(() => true, () => false);
}
/** 개수가 n이 될 때까지 폴링 */
async function countIs(locator, n, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((await locator.count()) === n) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`   (count=${await locator.count()}, expected ${n})`);
  return false;
}
async function textIs(locator, expected, timeout = 5000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = (await locator.textContent().catch(() => null))?.trim();
    if (last === String(expected)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`   (text=${last}, expected ${expected})`);
  return false;
}

async function noHorizontalOverflow(page) {
  // 가로 스크롤뿐 아니라, 내용이 넓어 모바일 브라우저가 화면을 축소(innerWidth > 기기 폭)하는 경우도 잡는다
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && window.innerWidth <= screen.width + 1);
}

const stat = (page, label) => page.getByTestId(`stat-${label}`);

async function runSuite(label, contextOptions) {
  console.log(`\n── ${label} ──`);
  const browser = await chromium.launch();
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  const isMobile = (contextOptions.viewport?.width ?? 1280) < 1024;
  const nav = (name) =>
    isMobile
      ? page.getByRole('navigation', { name: '하단 메뉴' }).getByRole('link', { name, exact: true })
      : page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name, exact: true });
  // 영상 관리는 '콘텐츠 준비'로 이동: 넓은 화면은 사이드바, 좁은 화면은 더보기 안
  const goVideos = async () => {
    if (isMobile) {
      await nav('더보기').click();
      await page.getByRole('link', { name: /영상 · 핵심 표현/ }).click();
    } else {
      await nav('영상 · 핵심 표현').click();
    }
  };
  const overflowPages = [];
  const checkOverflow = async (name) => {
    if (!(await noHorizontalOverflow(page))) overflowPages.push(name);
  };

  // 1. 대시보드 + 최초 샘플 데이터
  await page.goto(BASE);
  await page.getByRole('heading', { name: '오늘의 학습' }).waitFor();
  await page.getByTestId('today-dialogue').waitFor();
  check('홈 로드', true);
  check('샘플 데이터 안내 배너 표시', await visible(page.getByText('샘플 데이터')));
  check('오늘의 대화문 = 이어서 학습할 대화문(저녁 메뉴 정하기)', await visible(page.getByTestId('today-dialogue').getByText('저녁 메뉴 정하기')));
  check('모은 핵심 표현 = 10', await textIs(stat(page, '모은 핵심 표현'), 10));
  check('외운 대화문 = 1', await textIs(stat(page, '외운 대화문'), 1));
  check('오늘의 복습: 대화문 단위 안내', await visible(page.getByTestId('today-review').getByText('오늘의 복습')));
  check('오늘의 대화문: 5단계 암기 화면으로 바로 가는 버튼', ((await page.getByTestId('today-memorize').getAttribute('href')) ?? '').endsWith('/memorize'));
  await checkOverflow('대시보드');
  await page.screenshot({ path: `${SHOTS}/${label}-01-dashboard.png`, fullPage: true });

  // 2. 영상 목록 → 상세 탭
  await goVideos();
  await page.getByRole('heading', { name: '영상', exact: true }).waitFor();
  check('영상 목록 3개', await countIs(page.locator('main ul > li'), 3));
  await checkOverflow('영상 목록');
  await page.screenshot({ path: `${SHOTS}/${label}-02-videos.png`, fullPage: true });
  await page.getByTestId('video-list').getByText('[샘플] 친구와 나누는 일상 안부 표현 5가지').click();
  await page.getByRole('tab', { name: /주요 표현/ }).waitFor();
  check('주요 표현 노트: 영상 설명/AI 보충 구분', await visible(page.getByText('AI 보충', { exact: true })));
  await page.screenshot({ path: `${SHOTS}/${label}-03-video-preview.png`, fullPage: true });
  await page.getByRole('tab', { name: /핵심 문장/ }).click();
  check('핵심 문장 5개', await countIs(page.locator('main ol > li'), 5));
  await checkOverflow('영상 상세');
  await page.screenshot({ path: `${SHOTS}/${label}-04-video-sentences.png`, fullPage: true });
  await page.getByRole('tab', { name: /자막/ }).click();
  check('자막(타임스탬프) 표시', await visible(page.getByText('0:42', { exact: true })));

  // 자막 실패 영상
  await goVideos();
  await page.getByTestId('video-list').getByText('[샘플] 약속 잡을 때 쓰는 표현 5가지').click();
  check('표현 노트 없음 → "설명 내용 확인 필요"', await visible(page.getByText('설명 내용 확인 필요')));
  await page.getByRole('tab', { name: /자막/ }).click();
  check('자막 실패 상태 명확히 표시', await visible(page.getByRole('main').getByText(/샘플: 자막을 가져오지 못한/)));
  await page.getByRole('tab', { name: /대화문/ }).click();
  check('대화문 2개로 분리된 영상', await countIs(page.getByRole('main').getByText(/^대화문 [12]$/), 2));

  // 3. 대화문 상세: 한국어 토글 + 즐겨찾기 저장 → 새로고침 후 유지
  await nav('외우기').click();
  await page.getByText('늦게 온 친구와 이사 이야기').click();
  await page.getByRole('heading', { name: 'STEP 1 · 전체 대화문' }).waitFor();
  check('대화문 핵심 문장 하이라이트 5개', await countIs(page.locator('main mark[title^="핵심 문장"]'), 5));
  await page.getByRole('button', { name: '한국어' }).click();
  check('한국어 숨기기 토글', await hidden(page.getByText('나도 마찬가지야.', { exact: true })));
  await page.getByRole('button', { name: '한국어' }).click();
  await checkOverflow('대화문 상세');
  await page.screenshot({ path: `${SHOTS}/${label}-05-dialogue.png`, fullPage: true });
  const favBtn = page.getByRole('button', { name: /늦게 온 친구와 이사 이야기 즐겨찾기/ });
  await favBtn.click();
  await page.waitForTimeout(300);
  await page.reload();
  await page.getByRole('heading', { name: 'STEP 1 · 전체 대화문' }).waitFor();
  check('대화문 즐겨찾기 → 새로고침 후 유지 (IndexedDB)', await visible(page.getByRole('button', { name: '늦게 온 친구와 이사 이야기 즐겨찾기 해제' })));

  // 4. 표현: 어렵다고 표시 → 대시보드 취약 표현 수 증가 / 즐겨찾기
  if (isMobile) {
    await nav('더보기').click();
    await page.getByRole('link', { name: '표현 노트' }).click();
  } else {
    await nav('표현 노트').click();
  }
  await page.getByRole('heading', { name: '표현 노트' }).waitFor();
  const card = page.locator('main li').filter({ hasText: 'need a hand' });
  await card.getByLabel('어렵다고 표시').check();
  await card.getByRole('button', { name: /즐겨찾기/ }).click();
  await page.waitForTimeout(300);
  await checkOverflow('표현 노트');
  await page.screenshot({ path: `${SHOTS}/${label}-06-expressions.png`, fullPage: true });
  await page.reload();
  await page.getByRole('heading', { name: '표현 노트' }).waitFor();
  const reloadedBox = page.locator('main li').filter({ hasText: 'need a hand' }).getByLabel('어렵다고 표시');
  await reloadedBox.waitFor();
  check('어려움 표시 → 새로고침 후 유지', await reloadedBox.isChecked());
  await nav('홈').click();
  await page.getByTestId('today-dialogue').waitFor();
  check('홈 취약 표현 4 → 5 반영', await visible(page.getByText('다시 만나면 좋은 표현 5개', { exact: false })));

  // 5. 즐겨찾기 화면
  if (isMobile) {
    await nav('더보기').click();
    await page.getByRole('link', { name: '즐겨찾기' }).click();
  } else {
    await nav('즐겨찾기').click();
  }
  await page.getByRole('heading', { name: '즐겨찾기' }).waitFor();
  check('즐겨찾기 화면에 대화문/표현 표시', (await visible(page.getByText('늦게 온 친구와 이사 이야기'))) && (await visible(page.getByText('need a hand', { exact: true }))));
  await checkOverflow('즐겨찾기');

  // 6. 복습 화면
  await nav('복습').click();
  await page.getByRole('heading', { name: '복습', exact: true }).waitFor();
  await checkOverflow('복습');
  await page.screenshot({ path: `${SHOTS}/${label}-07-review.png`, fullPage: true });

  // 7. 설정: 샘플 삭제 (취소 → 유지, 확인 → 삭제), 다시 넣기, 전체 초기화
  await page.goto(`${BASE}/settings`);
  await page.getByRole('heading', { name: '설정' }).waitFor();
  await checkOverflow('설정');
  await page.screenshot({ path: `${SHOTS}/${label}-08-settings.png`, fullPage: true });
  const before = Number(await page.getByTestId('total-records').textContent());
  await page.getByRole('button', { name: '샘플 데이터 삭제' }).click();
  await page.getByRole('alertdialog').waitFor();
  await page.screenshot({ path: `${SHOTS}/${label}-09-confirm.png` });
  await page.getByRole('button', { name: '취소' }).click();
  check('확인 창에서 취소 시 데이터 유지', (await hidden(page.getByRole('alertdialog'))) && Number(await page.getByTestId('total-records').textContent()) === before);
  await page.getByRole('button', { name: '샘플 데이터 삭제' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '샘플 삭제' }).click();
  await page.getByRole('button', { name: '샘플 데이터 다시 넣기' }).waitFor();
  check('샘플 삭제 후 레코드 0', await textIs(page.getByTestId('total-records'), 0));
  await page.goto(BASE);
  await page.getByTestId('today-dialogue').waitFor();
  check('샘플 삭제 후 홈 빈 상태', (await textIs(stat(page, '모은 핵심 표현'), 0)) && (await visible(page.getByText('학습할 대화문이 없어요'))));
  await checkOverflow('대시보드(빈 상태)');
  await page.screenshot({ path: `${SHOTS}/${label}-10-dashboard-empty.png`, fullPage: true });
  await page.reload();
  await page.getByTestId('today-dialogue').waitFor();
  check('샘플 삭제 후 새로고침해도 자동 재생성 안 됨', await textIs(stat(page, '모은 핵심 표현'), 0));

  await page.goto(`${BASE}/settings`);
  await page.getByRole('button', { name: '샘플 데이터 다시 넣기' }).click();
  await page.getByRole('button', { name: '샘플 데이터 삭제' }).waitFor();
  check('샘플 데이터 다시 넣기', await visible(page.getByText('기능 확인용 샘플 데이터가 들어 있습니다', { exact: false })));

  await page.getByRole('button', { name: '전체 초기화' }).click();
  const dialog = page.getByRole('alertdialog');
  const confirmBtn = dialog.getByRole('button', { name: '영구 삭제' });
  check('전체 초기화: 확인 문구 입력 전 버튼 비활성', await confirmBtn.isDisabled());
  await dialog.getByLabel('확인 문구 입력').fill('초기화');
  check('전체 초기화: 확인 문구 입력 후 버튼 활성', await confirmBtn.isEnabled());
  await confirmBtn.click();
  await page.getByRole('button', { name: '샘플 데이터 다시 넣기' }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: '설정' }).waitFor();
  check('전체 초기화 후 새로고침 → 레코드 0 유지', await textIs(page.getByTestId('total-records'), 0));

  // 8. 404
  await page.goto(`${BASE}/dialogues/does-not-exist`);
  check('없는 대화문 → 안내 화면', await visible(page.getByText('대화문을 찾을 수 없어요.')));

  check('가로 스크롤 없음 (모든 화면)', overflowPages.length === 0, overflowPages.join(', '));
  check('콘솔 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
}

try {
  await runSuite('desktop', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await runSuite('mobile', { ...devices['iPhone 13'] });
} catch (e) {
  console.error(e);
  results.push({ name: 'suite crashed', ok: false, detail: String(e) });
} finally {
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n결과: ${results.length - failed.length}/${results.length} 통과`);
process.exit(failed.length ? 1 : 0);
