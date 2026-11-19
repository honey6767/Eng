/**
 * 접근 코드 E2E 점검 (Playwright)
 * 사용법: npm run build && npm run e2e:access
 *
 * 미리보기 서버를 ACCESS_CODE(테스트용 값)와 가짜 YouTube 응답(YOUTUBE_API_MOCK=1)으로 띄워
 * 배포 Worker와 같은 접근 코드 검사를 확인한다. 실제 비밀값·외부 서비스는 쓰지 않는다.
 *
 * - 처음 열면 입력 화면 / 틀린 코드·빈 값 거부 / 맞는 코드 → 앱
 * - 새로고침 후 유지 / 다른 브라우저는 다시 입력 / 로그아웃 후 다시 입력 / 건너뛰기
 * - 인증 실패 요청에서 YouTube 호출 0회 (사용량 그대로)
 * - B0 백업 파일에 접근 코드·인증 헤더·토큰 없음, 복원해도 이 브라우저의 코드는 그대로
 * - 반복 실패 잠금(429), CSP 위반 없음, 화면 넘침 없음, 입력값이 화면 글자로 노출되지 않음
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const SHOTS = 'e2e-screenshots';
const TMP = 'e2e-screenshots/access-files';
mkdirSync(TMP, { recursive: true });
const PORT = 4190;
const BASE = `http://localhost:${PORT}`;
const CODE = 'E2E-access-code-2026'; // 테스트 전용 값 (실제 Secret 아님)
// 이 점검 전용 사용량 기록 (다른 E2E가 남긴 가짜 사용량과 섞이지 않게 매번 새로)
const QUOTA_FILE = resolve(TMP, 'quota-mock.json');
rmSync(QUOTA_FILE, { force: true });

function startServer() {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'pipe',
    env: { ...process.env, YOUTUBE_API_KEY: '', YOUTUBE_API_MOCK: '1', ACCESS_CODE: CODE, YOUTUBE_QUOTA_FILE: QUOTA_FILE },
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
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function newPage(browser, device, errors) {
  const context = await browser.newContext({ ...device, acceptDownloads: true });
  await context.route(/^https:\/\/(i\.ytimg\.com|www\.youtube(-nocookie)?\.com)\//, (r) => r.fulfill({ status: 200, body: '' }));
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // 일부러 틀린 코드를 보내 생기는 401/429 응답 로그는 제외 (요청 실패 자체는 정상 동작)
    if (/Failed to load resource/.test(t)) return;
    errors.push(t.slice(0, 200));
  });
  return { context, page };
}

const quotaUsed = async (request, code) => {
  const r = await request.get(`${BASE}/api/youtube/status`, { headers: { Authorization: `Bearer ${code}` } });
  return (await r.json()).quota?.used;
};

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  try {
    // ── 기기 A ──
    console.log('\n── 기기 A (iPad) ──');
    const { context: ctxA, page: a } = await newPage(browser, devices['iPad (gen 7)'], errors);
    await a.goto(BASE);
    check('처음 열면 접근 코드 입력 화면', await visible(a.getByTestId('access-gate')));
    check('입력 화면에서는 학습 화면이 보이지 않음', !(await a.getByTestId('today-dialogue').isVisible().catch(() => false)));
    check('입력칸은 기본으로 가려짐(password)', (await a.getByTestId('access-input').getAttribute('type')) === 'password');
    check('빈 값이면 확인 버튼 비활성', await a.getByTestId('access-submit').isDisabled());
    await a.screenshot({ path: `${SHOTS}/sAccess-01-gate-ipad.png` });

    await a.getByTestId('access-input').fill('wrong-code-0000');
    await a.getByTestId('access-submit').click();
    check('잘못된 코드: 차단 + 다시 입력 안내', /맞지 않아요/.test((await a.getByTestId('access-error').textContent()) ?? ''));
    check('잘못된 코드: 저장되지 않음', (await a.evaluate(() => localStorage.getItem('mes:accessCode'))) === null);
    check('잘못된 코드: 화면 글자에 입력값 노출 없음', !(await a.locator('body').innerText()).includes('wrong-code-0000'));
    await a.screenshot({ path: `${SHOTS}/sAccess-02-wrong.png` });

    await a.getByTestId('access-input').fill(CODE);
    await a.getByTestId('access-submit').click();
    check('정상 코드: 허용 → 학습 화면', await visible(a.getByTestId('today-dialogue'), 8000));
    check('정상 코드: 이 브라우저 localStorage에만 저장', (await a.evaluate(() => localStorage.getItem('mes:accessCode'))) === CODE);
    check('학습 화면 글자에 코드 노출 없음', !(await a.locator('body').innerText()).includes(CODE));
    const idbHasCode = await a.evaluate(
      (code) =>
        new Promise((resolve) => {
          const req = indexedDB.open('my-english-study');
          req.onsuccess = () => {
            const db = req.result;
            const names = [...db.objectStoreNames];
            const tx = db.transaction(names, 'readonly');
            let left = names.length;
            let found = false;
            for (const n of names) {
              tx.objectStore(n).getAll().onsuccess = (e) => {
                if (JSON.stringify(e.target.result).includes(code)) found = true;
                if (--left === 0) {
                  db.close();
                  resolve(found);
                }
              };
            }
          };
        }),
      CODE,
    );
    check('IndexedDB 학습 데이터에 코드 없음', idbHasCode === false);

    await a.reload();
    check('새로고침 후 같은 브라우저: 인증 유지 (입력 화면 없음)', (await visible(a.getByTestId('today-dialogue'), 8000)) && !(await a.getByTestId('access-gate').isVisible().catch(() => false)));

    await a.goto(`${BASE}/settings#access`);
    await a.getByTestId('access-panel').waitFor();
    await a.waitForTimeout(600);
    check('설정: 저장됨 · 확인됨 표시', /저장됨 · 확인됨/.test((await a.getByTestId('access-status').textContent()) ?? ''));
    check('설정: 영상 정보 서버 연결됨 (코드로 상태 확인)', await visible(a.getByText('연결됨').first()));
    await a.getByTestId('access-panel').screenshot({ path: `${SHOTS}/sAccess-03-settings-panel.png` });

    // ── 인증 실패 시 YouTube 호출 0회 ──
    const before = await quotaUsed(a.request, CODE);
    const noCode = await a.request.get(`${BASE}/api/youtube/video?id=dQw4w9WgXcQ`);
    const wrongCode = await a.request.get(`${BASE}/api/youtube/video?id=dQw4w9WgXcQ`, { headers: { Authorization: 'Bearer nope-nope-1' } });
    const inQuery = await a.request.get(`${BASE}/api/youtube/video?id=dQw4w9WgXcQ&access_code=${CODE}`);
    const after = await quotaUsed(a.request, CODE);
    check('코드 없음 401 · 틀림 401 · URL 쿼리 코드는 인정 안 함 401', noCode.status() === 401 && wrongCode.status() === 401 && inQuery.status() === 401, `${noCode.status()}/${wrongCode.status()}/${inQuery.status()}`);
    check('인증 실패 요청에서 YouTube 호출 0회 (사용량 그대로)', before === 0 && after === 0, `${before} → ${after}`);
    const okCall = await a.request.get(`${BASE}/api/youtube/video?id=mocksolo001`, { headers: { Authorization: `Bearer ${CODE}` } });
    const afterOk = await quotaUsed(a.request, CODE);
    check('정상 코드: 영상 정보 응답 200 + YouTube(가짜) 호출로 사용량 증가', okCall.status() === 200 && afterOk > after, `HTTP ${okCall.status()} · ${after} → ${afterOk}`);
    const errBody = await wrongCode.text();
    check('오류 응답에 입력값·정답 없음', !errBody.includes('nope-nope-1') && !errBody.includes(CODE));

    // ── B0 백업에 접근 정보 없음 ──
    await a.goto(`${BASE}/settings#backup`);
    await a.getByTestId('backup-panel').waitFor();
    const [dl] = await Promise.all([a.waitForEvent('download'), a.getByTestId('export-backup').click()]);
    const backupPath = `${TMP}/${dl.suggestedFilename()}`;
    await dl.saveAs(backupPath);
    const text = readFileSync(backupPath, 'utf8');
    const banned = [CODE, 'mes:accessCode', 'accessCode', 'Authorization', 'Bearer', 'auth_'];
    const found = banned.filter((s) => text.includes(s));
    check('B0 백업 파일에 접근 코드·인증 헤더·토큰 없음', found.length === 0, found.join(',') || `${(text.length / 1024).toFixed(0)}KB 검사`);
    check('백업 파일은 그대로 유효 (형식·검증값)', JSON.parse(text).format === 'my-english-study-backup');

    // ── 다른 브라우저(기기 B): 다시 입력 필요, 복원해도 코드는 그대로 ──
    console.log('\n── 기기 B (휴대폰, 다른 브라우저) ──');
    const { context: ctxB, page: b } = await newPage(browser, devices['iPhone 13'], errors);
    await b.goto(BASE);
    check('다른 브라우저·기기: 다시 입력 화면', await visible(b.getByTestId('access-gate')));
    check('다른 브라우저에는 코드 없음', (await b.evaluate(() => localStorage.getItem('mes:accessCode'))) === null);
    check('휴대폰 폭: 입력 화면 가로 넘침 없음', await fits(b));
    await b.screenshot({ path: `${SHOTS}/sAccess-04-gate-phone.png` });
    await b.getByTestId('access-input').fill(CODE);
    await b.getByTestId('access-submit').click();
    await b.getByTestId('today-dialogue').waitFor({ timeout: 8000 });
    await b.goto(`${BASE}/settings#backup`);
    await b.getByTestId('backup-panel').waitFor();
    await b.getByRole('button', { name: '샘플 데이터 삭제' }).click();
    await b.getByRole('alertdialog').getByRole('button', { name: '샘플 삭제' }).click();
    await b.waitForTimeout(600);
    await b.getByTestId('restore-file').setInputFiles(backupPath);
    await b.getByTestId('restore-preview').waitFor();
    const [pre] = await Promise.all([b.waitForEvent('download'), b.getByTestId('restore-apply').click()]);
    await pre.saveAs(`${TMP}/${pre.suggestedFilename()}`);
    await b.getByRole('alertdialog').getByRole('button', { name: '복원하기' }).click();
    await b.getByTestId('restore-result').waitFor();
    check('B0 복원 정상 동작 (복원 결과 표시)', await b.getByTestId('restore-result').isVisible());
    check('복원 후에도 이 브라우저의 접근 코드는 그대로 (가져오거나 덮어쓰지 않음)', (await b.evaluate(() => localStorage.getItem('mes:accessCode'))) === CODE);
    const preText = readFileSync(`${TMP}/${pre.suggestedFilename()}`, 'utf8');
    check('복원 직전 자동 백업 파일에도 접근 코드 없음', !preText.includes(CODE) && !preText.includes('Bearer'));

    // ── 로그아웃 → 다시 입력 ──
    console.log('\n── 로그아웃 · 건너뛰기 ──');
    await a.goto(`${BASE}/settings#access`);
    await a.getByTestId('access-logout').click();
    await a.getByRole('alertdialog').getByRole('button', { name: '지우기' }).click();
    check('로그아웃: 곧바로 입력 화면', await visible(a.getByTestId('access-gate')));
    check('로그아웃: 코드 삭제됨', (await a.evaluate(() => localStorage.getItem('mes:accessCode'))) === null);
    await a.reload();
    check('로그아웃 후 새로고침해도 다시 입력 필요', await visible(a.getByTestId('access-gate')));
    check('다른 기기(B)는 로그아웃 영향 없음', (await b.evaluate(() => localStorage.getItem('mes:accessCode'))) === CODE);

    await a.getByTestId('access-skip').click();
    check('건너뛰기: 입력 화면 닫히고 앱 사용 가능 (지금 화면 = 설정)', (await visible(a.getByTestId('access-panel'), 8000)) && !(await a.getByTestId('access-gate').isVisible().catch(() => false)));
    await a.goto(BASE);
    check('건너뛰기: 학습 화면 사용 가능', await visible(a.getByTestId('today-dialogue'), 8000));
    await a.goto(`${BASE}/settings#access`);
    await a.getByTestId('access-panel').waitFor();
    await a.waitForTimeout(500);
    check('건너뛰기 후 설정: 저장 안 됨 표시 + 입력 버튼', /저장 안 됨/.test((await a.getByTestId('access-status').textContent()) ?? '') && (await a.getByTestId('access-edit').isVisible()));
    await a.getByTestId('access-edit').click();
    await a.getByTestId('access-panel').getByTestId('access-input').fill(CODE);
    await a.getByTestId('access-panel').getByTestId('access-submit').click();
    await a.waitForTimeout(600);
    check('설정에서 나중에 입력 → 저장됨', (await a.evaluate(() => localStorage.getItem('mes:accessCode'))) === CODE);

    // ── 화면 폭 ──
    for (const [name, vp] of [['iPad 세로', { width: 810, height: 1080 }], ['iPad 가로', { width: 1080, height: 810 }]]) {
      await a.setViewportSize(vp);
      await a.goto(`${BASE}/settings#access`);
      await a.getByTestId('access-panel').waitFor();
      check(`${name}: 설정 화면 가로 넘침 없음`, await fits(a));
    }

    // ── CSP·보안 헤더 유지 ──
    const res = await a.request.get(BASE);
    const h = res.headers();
    check('CSP·보안 헤더 유지', /script-src 'self'/.test(h['content-security-policy'] ?? '') && h['x-frame-options'] === 'DENY' && h['x-content-type-options'] === 'nosniff');
    check('CSP 위반·브라우저 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));

    // ── 반복 실패 잠금 (마지막에: 이 서버의 이 주소를 15분 잠금) ──
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await a.request.get(`${BASE}/api/youtube/auth`, { headers: { Authorization: `Bearer bad-${i}-zzzz` } })).status());
    const lockedRes = await a.request.get(`${BASE}/api/youtube/auth`, { headers: { Authorization: `Bearer ${CODE}` } });
    check('5번 틀리면 잠금: 맞는 코드도 429', statuses.every((s) => s === 401) && lockedRes.status() === 429, `${statuses.join(',')} → ${lockedRes.status()}`);
    await ctxA.close();
    await ctxB.close();
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
