/**
 * 2단계 E2E 점검 (Playwright)
 * 사용법: npm run build && npm run e2e:stage2
 *
 * - 서버 A (YOUTUBE_API_MOCK=1): 가짜 Google 응답으로 재생목록/개별 등록, 중복 방지, 자막, 상태, 무작위 순서를 검사
 * - 서버 B (API 키 없음): 제한 모드 표시와 실패 처리 검사
 * - 프록시 차단 시뮬레이션: 서버 없이 ID만으로 등록
 * 실제 YouTube 호출은 하지 않는다 (실제 API 테스트는 별도로 키가 있을 때만 수행).
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const SHOTS = 'e2e-screenshots';
mkdirSync(SHOTS, { recursive: true });
rmSync('node_modules/.cache/my-english-study/youtube-quota.mock.json', { force: true });

const FIXTURES = join(tmpdir(), `mes-e2e-${Date.now()}`);
mkdirSync(FIXTURES, { recursive: true });
const SRT = '1\n00:00:01,000 --> 00:00:04,000\nHello and welcome.\n\n2\n00:01:05,500 --> 00:01:08,000\nLet\'s get started.\n';
const VTT = 'WEBVTT\n\nintro\n00:00:02.000 --> 00:00:05.000 align:start\n<c>First cue</c>\n\n00:00:05.000 --> 00:00:09.000\nSecond cue\n\n00:00:09.000 --> 00:00:12.000\nThird cue\n';
const TXT = '0:00\nWelcome back\n0:07\nToday we will learn\nfive phrases\n1:02:03 Last line\n';
writeFileSync(join(FIXTURES, 'captions.txt'), TXT);

function startServer(port, env) {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort'], {
    stdio: 'pipe',
    env: { ...process.env, YOUTUBE_API_KEY: '', YOUTUBE_API_MOCK: '', ...env },
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('preview server timeout')), 15000);
    server.stdout.on('data', (d) => {
      if (String(d).includes(String(port))) {
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
  console.log(`   (text="${last.slice(0, 120)}", expected ${re})`);
  return false;
}
async function countIs(loc, n, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((await loc.count()) === n) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`   (count=${await loc.count()}, expected ${n})`);
  return false;
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function register(page, url) {
  const input = page.getByLabel('YouTube URL');
  await input.fill(url);
  await page.getByRole('button', { name: '등록', exact: true }).click();
}

// ───────────────────────────────────────── 서버 A: 가짜 YouTube API
async function mockSuite(base) {
  console.log('\n── 서버 A: YouTube API (MOCK) ──');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  // 썸네일 이미지(i.ytimg.com)는 이 테스트 환경에서 차단되므로 빈 응답으로 대체
  await context.route(/i\.ytimg\.com|youtube-nocookie\.com/, (r) => r.fulfill({ status: 200, body: '' }));

  await page.goto(`${base}/videos`);
  check('API 연결 상태 표시 (MOCK 모드 명시)', (await visible(page.getByText('YouTube API 연결됨'))) && (await visible(page.getByText('테스트용 가짜 응답(MOCK) 모드'))));

  // 1~2. 재생목록 등록 + 전체(페이지네이션)
  await register(page, 'https://www.youtube.com/playlist?list=PLmockPlaylist0000001&si=abc');
  const result = page.getByTestId('import-result');
  check('재생목록 등록: 새 영상 120개 (3페이지 전체)', await textMatches(result, /재생목록을 등록했어요[\s\S]*새 영상 120개 추가/, 15000));
  check('비공개/삭제 영상 구분 표시', await textMatches(result, /불러올 수 없는 영상 2개 \(비공개 1 · 삭제 1\)/));
  check('API 사용량 표시 (7 단위)', await textMatches(result, /사용량: 7 단위/));
  await page.screenshot({ path: `${SHOTS}/s2-01-playlist-imported.png`, fullPage: false });
  check('목록: 실제 120 + 샘플 3', await textMatches(page.getByRole('tablist', { name: '학습 상태 필터' }).getByRole('tab', { name: /^전체/ }), /123/));

  // 같은 재생목록 재등록
  await register(page, 'https://youtube.com/playlist?list=PLmockPlaylist0000001');
  check('같은 재생목록 재등록 → 중복 생성 없음', await textMatches(result, /이미 등록된 재생목록[\s\S]*새 영상 0개 추가[\s\S]*변경 없음 120개/));
  check('재생목록 행 1개(+샘플 1)', await countIs(page.getByTestId('playlist-row'), 2));

  // 3~4. 개별 URL: 재생목록에 있는 영상 / 새 영상
  await register(page, 'https://youtu.be/mockvid0005?si=x');
  check('재생목록에 있는 영상을 개별 URL로 등록 → 출처만 연결', await textMatches(result, /이미 등록된 영상이에요 — 기존 학습 기록은 그대로/));
  await register(page, 'https://www.youtube.com/watch?v=mocksolo001');
  check('새 개별 영상 등록', await textMatches(result, /새 영상을 등록했어요/));
  check('전체 영상 수 124 (중복 없음)', await textMatches(page.getByRole('tablist', { name: '학습 상태 필터' }).getByRole('tab', { name: /^전체/ }), /124/));
  await register(page, 'https://www.youtube.com/watch?v=mocksolo001');
  check('같은 개별 영상 재등록 → 정보만 갱신', await textMatches(result, /이미 개별 등록된 영상이에요/));

  await register(page, 'https://www.youtube.com/watch?v=mockvid0007&list=PLmockPlaylist0000001&index=7');
  check('재생목록 안 영상 URL → 등록 방식 선택지', await visible(page.getByRole('button', { name: '이 영상만 등록' })));
  await register(page, 'https://vimeo.com/123');
  check('잘못된 URL → 오류 안내', await visible(page.getByRole('alert').getByText('YouTube 주소가 아닙니다.')));

  // 출처 필터
  await page.getByLabel('출처 필터').selectOption({ label: '재생목록: [MOCK] 테스트 재생목록' });
  check('출처 필터: 재생목록 120개', await textMatches(page.getByRole('tablist', { name: '학습 상태 필터' }).getByRole('tab', { name: /^전체/ }), /120/));
  await page.getByLabel('출처 필터').selectOption({ label: '개별 등록 영상' });
  check('출처 필터: 개별 등록 2개 (중복 연결 포함)', await textMatches(page.getByRole('tablist', { name: '학습 상태 필터' }).getByRole('tab', { name: /^전체/ }), /2/));
  await page.getByLabel('출처 필터').selectOption('all');

  // 5. 상세: 제목·길이·출처
  await page.getByLabel('출처 필터').selectOption({ label: '개별 등록 영상' });
  await page.getByTestId('video-list').getByText('[MOCK] 테스트 영상 5', { exact: true }).click();
  check('길이 "12분 35초" 형식', await textMatches(page.getByTestId('video-duration'), /^\d+분 \d+초$/));
  check('출처: 재생목록 + 개별 URL 모두 표시', await textMatches(page.getByTestId('video-sources'), /재생목록 ‘\[MOCK\] 테스트 재생목록’ 5번째[\s\S]*개별 URL 등록/));
  await page.screenshot({ path: `${SHOTS}/s2-02-video-detail.png`, fullPage: true });

  // 9. 학습 상태 저장
  await page.getByRole('radio', { name: '학습 완료' }).click();
  await page.waitForTimeout(300);
  await page.reload();
  check('학습 상태(학습 완료) 새로고침 후 유지', (await page.getByRole('radio', { name: '학습 완료' }).getAttribute('aria-checked')) === 'true');

  // 6. 자막 자동 가져오기 — 트랙 없음
  check('실제 영상은 원문·Chunk 탭이 기본', (await page.getByRole('tab', { name: /^원문·Chunk/ }).getAttribute('aria-selected')) === 'true');
  await page.getByRole('tab', { name: /^자막/ }).click();
  check('자막 탭: YouTube 공식 자막 확인', await visible(page.getByRole('heading', { name: 'YouTube 공식 자막 확인' })));
  await page.getByRole('button', { name: '공식 자막 트랙 확인' }).click();
  check('자막 확인: 트랙 없음 → 성공으로 표시하지 않음', await textMatches(page.getByTestId('caption-check-result'), /자막 트랙 없음/));
  check('자막 미등록 상태 유지', await visible(page.getByRole('heading', { name: '자막 직접 입력' })));

  // 7~8. 자막 붙여넣기 (SRT) → 저장 → 타임스탬프로 재생 위치 이동
  await page.getByLabel('자막 붙여넣기').fill(SRT);
  check('SRT 미리보기', await textMatches(page.getByTestId('transcript-preview'), /SRT · 2개 구간 · 타임스탬프 2개/));
  await page.getByRole('button', { name: '자막 저장' }).click();
  check('SRT 저장 후 자막 표시', await textMatches(page.getByTestId('transcript-meta'), /직접 입력 · SRT · 2개 구간/));
  await page.getByRole('button', { name: '1:05부터 재생' }).click();
  const iframe = page.getByTestId('youtube-player');
  check('타임스탬프 → 영상 해당 위치 재생 (start=65)', (await visible(iframe)) && /start=65/.test((await iframe.getAttribute('src')) ?? ''));
  await page.reload();
  check('자막 새로고침 후 유지', await textMatches(page.getByTestId('transcript-meta'), /SRT · 2개 구간/));

  // VTT로 교체 (확인 창)
  await page.getByRole('button', { name: '자막 교체' }).click();
  await page.getByLabel('자막 붙여넣기').fill(VTT);
  check('VTT 미리보기 (큐 식별자·태그 정리)', await textMatches(page.getByTestId('transcript-preview'), /WebVTT · 3개 구간/));
  await page.getByRole('button', { name: '자막 저장' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '교체' }).click();
  check('VTT 교체 저장', await textMatches(page.getByTestId('transcript-meta'), /WebVTT · 3개 구간/));
  check('VTT 태그 제거된 문장', await visible(page.getByTestId('transcript-segments').getByText('First cue', { exact: true })));

  // 타임스탬프 텍스트 파일 업로드
  await page.getByRole('button', { name: '자막 교체' }).click();
  await page.getByTestId('transcript-file').setInputFiles(join(FIXTURES, 'captions.txt'));
  check('텍스트 파일(YouTube 스크립트 형식) 불러오기', await textMatches(page.getByTestId('transcript-preview'), /타임스탬프 텍스트 · 3개 구간/));
  await page.getByRole('button', { name: '취소' }).click();

  // 자막 트랙이 있는 영상: 권한 없음
  await page.goto(`${base}/videos`);
  await page.getByTestId('video-list').getByText('[MOCK] 테스트 영상 1', { exact: true }).click();
  await page.getByRole('tab', { name: /^자막/ }).click();
  await page.getByRole('button', { name: '공식 자막 트랙 확인' }).click();
  check('자막 트랙 있음 → "권한 없음"으로 정확히 표시', await textMatches(page.getByTestId('caption-check-result'), /자동 가져오기 불가 · 권한 없음/));
  check('확인된 트랙 정보 표시', await visible(page.getByText(/확인된 트랙: en\(자동 생성\)/)));
  await page.screenshot({ path: `${SHOTS}/s2-03-transcript.png`, fullPage: true });

  // 10. 무작위 학습 순서: 유지·건너뛰기·학습 시작
  await page.goto(`${base}/videos`);
  // 7+7(재생목록 2회) + 1+1+1(개별 3회) + 50+50(자막 확인 2회) = 117
  check('API 사용량 누적 표시 (자막 확인 50단위 포함 117)', await textMatches(page.getByText(/오늘 사용량/).first(), /오늘 사용량 117 \/ 9,000/));
  const title = page.getByTestId('queue-current-title');
  await title.waitFor();
  const first = (await title.textContent()).trim();
  check('추천 영상은 실제 영상 (샘플 제외)', !first.startsWith('[샘플]'));
  check('대상: 실제 121개 중 완료 1개 제외 → 120/120', await textMatches(page.getByTestId('queue-progress'), /1회차 · 이번 회차 남은 영상 120\/120/));
  await page.reload();
  check('새로고침해도 추천 순서 유지', await textMatches(title, new RegExp(`^${first.replace(/[[\]]/g, '\\$&')}$`)));
  await page.getByRole('button', { name: '건너뛰기' }).click();
  const afterSkip = page.getByTestId('queue-current-title');
  check('건너뛰기 → 다음 영상', await textMatches(afterSkip, new RegExp(`^(?!${first.replace(/[[\]]/g, '\\$&')}$)`)));
  const second = (await afterSkip.textContent()).trim();
  await page.getByRole('button', { name: '이 영상 학습 시작' }).click();
  await page.waitForURL(/\/videos\/[^/]+$/);
  check('학습 시작 → 상세 화면 + 학습 중', (await page.getByRole('radio', { name: '학습 중' }).getAttribute('aria-checked')) === 'true');
  await page.goto(`${base}/videos`);
  check('학습 시작한 영상은 이번 회차에서 다음으로 넘어감', await textMatches(page.getByTestId('queue-current-title'), new RegExp(`^(?!${second.replace(/[[\]]/g, '\\$&')}$)`)));
  await page.screenshot({ path: `${SHOTS}/s2-04-videos-page.png`, fullPage: false });

  // 오늘의 신규 영상(무작위 순서)은 A단계부터 '콘텐츠 준비 > 영상' 화면에 있다. 홈은 오늘의 대화문을 보여 준다.
  check('영상 화면: 오늘의 신규 영상 카드', await visible(page.getByTestId('study-queue').getByRole('button', { name: '이 영상 학습 시작' })));
  await page.goto(base);
  check('홈: 오늘의 대화문 표시', await visible(page.getByTestId('today-dialogue')));
  // 12. 기존(샘플) 데이터 보존
  await page.goto(`${base}/dialogues`);
  check('기존 샘플 대화문 유지 (대화문 3)', await textMatches(page.getByRole('tab', { name: /^Day 대화문/ }), /3/));
  await page.goto(base);
  check('기존 암기 기록 유지 (외운 대화문 1)', await textMatches(page.getByTestId('stat-외운 대화문'), /^1$/));
  await page.goto(`${base}/videos`);
  check('전체 영상 = 124', await textMatches(page.getByRole('tablist', { name: '학습 상태 필터' }).getByRole('tab', { name: /^전체/ }), /124/));

  // 샘플 삭제 → 실제 영상 보존
  await page.goto(`${base}/settings`);
  await page.getByRole('button', { name: '샘플 데이터 삭제' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '샘플 삭제' }).click();
  await page.getByRole('button', { name: '샘플 데이터 다시 넣기' }).waitFor();
  await page.goto(`${base}/videos`);
  check('샘플 삭제 후 실제 영상 121개 보존', await textMatches(page.getByRole('tablist', { name: '학습 상태 필터' }).getByRole('tab', { name: /^전체/ }), /121/));
  await page.goto(`${base}/videos/${await page.evaluate(() => '')}`);
  await page.goto(`${base}/videos`);
  await page.getByTestId('video-list').getByText('[MOCK] 테스트 영상 5', { exact: true }).click();
  await page.getByRole('tab', { name: /^자막/ }).click();
  check('샘플 삭제 후 실제 영상의 자막 보존', await textMatches(page.getByTestId('transcript-meta'), /WebVTT · 3개 구간/));
  // 샘플 다시 넣기 → 실제 데이터 그대로
  await page.goto(`${base}/settings`);
  await page.getByRole('button', { name: '샘플 데이터 다시 넣기' }).click();
  await page.getByRole('button', { name: '샘플 데이터 삭제' }).waitFor();
  await page.goto(`${base}/videos`);
  check('샘플 다시 넣기 후 124개 (실제 데이터 그대로)', await textMatches(page.getByRole('tablist', { name: '학습 상태 필터' }).getByRole('tab', { name: /^전체/ }), /124/));

  // 11. 전체 학습 후 재셔플 — 작은 재생목록으로 새 브라우저에서
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx2.route(/i\.ytimg\.com|youtube-nocookie\.com/, (r) => r.fulfill({ status: 200, body: '' }));
  const p2 = await ctx2.newPage();
  await p2.goto(`${base}/videos`);
  await register(p2, 'https://www.youtube.com/playlist?list=PLmockPlaylist0000002');
  await textMatches(p2.getByTestId('import-result'), /새 영상 3개/);
  check('작은 재생목록: 1회차 3/3', await textMatches(p2.getByTestId('queue-progress'), /1회차 · 이번 회차 남은 영상 3\/3/));
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const t = (await p2.getByTestId('queue-current-title').textContent()).trim();
    seen.push(t);
    if (i === 1) {
      // 두 번째 영상은 학습 완료 처리 → 다음 회차에서 제외되어야 함
      await p2.getByRole('button', { name: '이 영상 학습 시작' }).click();
      await p2.waitForURL(/\/videos\/[^/]+$/);
      await p2.getByRole('radio', { name: '학습 완료' }).click();
      await p2.waitForTimeout(200);
    } else {
      await p2.getByRole('button', { name: '이 영상 학습 시작' }).click();
      await p2.waitForURL(/\/videos\/[^/]+$/);
    }
    await p2.goto(`${base}/videos`);
    await p2.getByTestId('study-queue').waitFor();
  }
  check('1회차에 3개 영상을 한 번씩 추천 (중복 없음)', new Set(seen).size === 3, seen.join(' / '));
  check('모두 학습 후 2회차로 재셔플, 완료 영상 제외 (2/2)', await textMatches(p2.getByTestId('queue-progress'), /2회차 · 이번 회차 남은 영상 2\/2/));
  check('2회차 추천에 완료 영상 없음', !(await textMatches(p2.getByTestId('queue-current-title'), new RegExp(`^${seen[1].replace(/[[\]]/g, '\\$&')}$`), 800)));
  await p2.getByLabel('완료 영상 포함').check();
  check('완료 영상 포함 옵션 → 3개로 다시 섞기', await textMatches(p2.getByTestId('queue-progress'), /3회차 · 이번 회차 남은 영상 3\/3 · 완료 영상 포함/));
  await ctx2.close();

  // 모바일 레이아웃
  const mctx = await browser.newContext({ ...devices['iPhone 13'] });
  await mctx.route(/i\.ytimg\.com|youtube-nocookie\.com/, (r) => r.fulfill({ status: 200, body: '' }));
  const mp = await mctx.newPage();
  await mp.goto(`${base}/videos`);
  await register(mp, 'https://www.youtube.com/playlist?list=PLmockPlaylist0000002');
  await textMatches(mp.getByTestId('import-result'), /새 영상/);
  check('모바일: 영상 화면 가로 스크롤 없음', await noOverflow(mp));
  await mp.screenshot({ path: `${SHOTS}/s2-05-mobile-videos.png`, fullPage: true });
  await mp.getByTestId('video-list').getByText(/^\[MOCK\]/).first().click();
  await mp.getByRole('tab', { name: /^자막/ }).click();
  await mp.getByRole('heading', { name: /자막 직접 입력|YouTube 공식 자막 확인/ }).first().waitFor();
  check('모바일: 영상 상세 가로 스크롤 없음', await noOverflow(mp));
  await mp.screenshot({ path: `${SHOTS}/s2-06-mobile-detail.png`, fullPage: true });
  await mctx.close();

  // 프록시 없음 시뮬레이션: 서버 없이 ID만으로 등록
  const nctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await nctx.route('**/api/youtube/**', (r) => r.abort());
  await nctx.route(/i\.ytimg\.com/, (r) => r.fulfill({ status: 200, body: '' }));
  const np = await nctx.newPage();
  await np.goto(`${base}/videos`);
  check('프록시 없음 상태 명확히 표시', await visible(np.getByText('영상 정보 서버 없음')));
  await register(np, 'https://youtu.be/dQw4w9WgXcQ');
  await np.getByLabel('영상 제목').fill('직접 입력한 제목');
  await np.getByRole('button', { name: 'ID만으로 등록' }).click();
  check('서버 없이 ID만으로 등록', await textMatches(np.getByTestId('import-result'), /새 영상을 등록했어요[\s\S]*직접 입력한 제목/));
  await register(np, 'https://www.youtube.com/playlist?list=PLmockPlaylist0000001');
  check('서버 없이 재생목록 → 불가 안내', await visible(np.getByRole('alert').getByText(/재생목록을 불러오려면 영상 정보 서버/)));
  await nctx.close();

  // 할당량 초과 (마지막: 이후 호출이 모두 차단됨)
  await page.goto(`${base}/videos`);
  await register(page, 'https://www.youtube.com/playlist?list=PLmockQuotaExceeded01');
  check('무료 할당량 초과 → 호출 중단 안내', await visible(page.getByRole('alert').getByText(/무료 할당량을 모두 사용했습니다/)));
  await page.reload();
  check('할당량 소진 상태 표시', await visible(page.getByText(/오늘 할당량 소진/)));
  await register(page, 'https://youtu.be/mockvid0099');
  check('소진 후 추가 호출 차단', await visible(page.getByRole('alert').getByText(/할당량/)));

  check('콘솔 오류 없음 (서버 A)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
}

// ───────────────────────────────────────── 서버 B: API 키 없음 (제한 모드)
async function limitedSuite(base) {
  console.log('\n── 서버 B: API 키 없음 (제한 모드) ──');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${base}/videos`);
  check('제한 모드 표시', await visible(page.getByText('API 키 미설정 · 제한 모드')));
  await register(page, 'https://youtu.be/dQw4w9WgXcQ');
  // 이 테스트 환경은 youtube.com 접속이 차단되어 oEmbed가 실패한다 → 실패를 정직하게 표시해야 함
  const alert = page.getByRole('alert');
  const ok = await visible(alert, 15000);
  const msg = ok ? (await alert.textContent()) ?? '' : '';
  check('oEmbed 실패 시 성공으로 표시하지 않고 오류 안내', ok && !/등록했어요/.test(msg), msg.trim());
  check('실패 시 영상이 저장되지 않음', await textMatches(page.getByRole('tablist', { name: '학습 상태 필터' }).getByRole('tab', { name: /^전체/ }), /3$/));
  await page.goto(`${base}/settings`);
  check('설정: API 키 무료 발급 안내', await visible(page.getByText('YouTube Data API v3', { exact: true }).first()));
  await page.screenshot({ path: `${SHOTS}/s2-07-settings.png`, fullPage: true });
  await browser.close();
}

const servers = [];
try {
  servers.push(await startServer(4180, { YOUTUBE_API_MOCK: '1' }));
  servers.push(await startServer(4181, {}));
  await mockSuite('http://localhost:4180');
  await limitedSuite('http://localhost:4181');
} catch (e) {
  console.error(e);
  results.push({ name: 'suite crashed', ok: false, detail: String(e) });
} finally {
  servers.forEach((s) => s.kill());
  rmSync(FIXTURES, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n결과: ${results.length - failed.length}/${results.length} 통과`);
process.exit(failed.length ? 1 : 0);
