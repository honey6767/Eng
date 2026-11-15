/**
 * B0 E2E 점검 (Playwright) — 백업 파일 받기 · 빈 기기 복원 · 병합 복원 · 잘못된 파일 거부
 * 사용법: npm run build && npm run e2e:stageB0
 *
 * - 기기 A: 학습 흔적(즐겨찾기·어려워요·복습 상태·학습 기록·진행)이 있는 상태에서 백업 파일 받기
 *   → 받는 동안·받은 뒤 IndexedDB가 값까지 그대로인지
 * - 기기 B(새 브라우저): 샘플 삭제(기존 기능) → 파일 복원 → 모든 테이블이 기기 A와 값까지 같은지
 *   (기기별 설정 initializedAt·schemaVersion 제외)
 * - 복원 직전 '현재 데이터 백업 파일'을 자동으로 받는지, 임시 안전 복사본이 생기는지
 * - 기기 A에 같은 파일 다시 복원 → 추가 0 · 충돌 0 · 데이터 그대로
 * - 수정된 파일 → 검증값 오류로 거부, 데이터 그대로
 * - 가로 넘침 없음, 브라우저 오류 없음. 외부 서비스는 호출하지 않는다.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const SHOTS = 'e2e-screenshots';
const TMP = 'e2e-screenshots/b0-files';
mkdirSync(TMP, { recursive: true });
const PORT = 4186;
const BASE = `http://localhost:${PORT}`;
const DEVICE_META = new Set(['initializedAt', 'schemaVersion']);

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

/** IndexedDB 전체 덤프 (앱 코드를 거치지 않고 직접, 키 순서) */
const dumpDb = (page, name = 'my-english-study') =>
  page.evaluate(
    (dbName) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const names = [...db.objectStoreNames].sort();
          const out = { version: db.version, tables: {} };
          if (names.length === 0) return resolve(out);
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
    name,
  );

/** 테스트용 학습 흔적 — 사용자가 남겼을 법한 데이터를 DB에 직접 추가 (앱 코드 미사용) */
const addUserTraces = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('my-english-study');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['expressions', 'dialogues', 'studyLogs'], 'readwrite');
          const ex = tx.objectStore('expressions');
          const dl = tx.objectStore('dialogues');
          ex.getAll().onsuccess = (e) => {
            const row = e.target.result[0];
            ex.put({ ...row, isFavorite: true, isMarkedDifficult: true });
            tx.objectStore('studyLogs').put({
              id: 'e2e-log', timestamp: '2026-11-15T01:00:00.000Z', date: '2026-11-15', activity: 'expression_review',
              itemType: 'expression', itemId: row.id, rating: 'hard', isReview: true,
            });
          };
          dl.getAll().onsuccess = (e) => {
            const row = e.target.result[e.target.result.length - 1];
            dl.put({ ...row, isFavorite: true });
          };
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );

const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const sortRows = (t, rows) => [...rows].sort((a, b) => String(t === 'appMeta' ? a.key : a.id).localeCompare(String(t === 'appMeta' ? b.key : b.id)));
const canon = (v) => (v && typeof v === 'object' ? (Array.isArray(v) ? v.map(canon) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

async function openSettings(page) {
  await page.goto(`${BASE}/settings#backup`);
  await page.getByTestId('backup-panel').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const device = devices['iPad (gen 7)'];
  const errors = [];
  const watch = (page) => {
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  };
  try {
    // ── 기기 A ──
    console.log('\n── 기기 A: 백업 파일 받기 ──');
    const ctxA = await browser.newContext({ ...device, acceptDownloads: true });
    await ctxA.route(/^https:\/\/(i\.ytimg\.com|www\.youtube(-nocookie)?\.com)\//, (r) => r.fulfill({ status: 200, body: '' }));
    const a = await ctxA.newPage();
    watch(a);
    await a.goto(BASE);
    await a.getByTestId('today-dialogue').waitFor();
    await addUserTraces(a);
    await openSettings(a);
    const beforeA = await dumpDb(a);
    check('기기 A: 백업 화면 표시 (실제 백업 / 임시 복사본 구분 문구)', (await a.getByText('실제 백업', { exact: true }).isVisible()) && (await a.getByText('실제 백업 아님').isVisible()));
    await a.screenshot({ path: `${SHOTS}/sB0-01-backup-panel.png` });
    await a.getByTestId('backup-panel').screenshot({ path: `${SHOTS}/sB0-01-backup-panel-full.png` });

    const [dl] = await Promise.all([a.waitForEvent('download'), a.getByTestId('export-backup').click()]);
    const backupPath = `${TMP}/${dl.suggestedFilename()}`;
    await dl.saveAs(backupPath);
    check('백업 파일 이름', /^my-english-study-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
    const file = JSON.parse(readFileSync(backupPath, 'utf8'));
    check('백업 파일 형식·검증값 포함', file.format === 'my-english-study-backup' && file.checksum?.algorithm === 'SHA-256' && file.checksum.value.length === 64);
    const tableNames = Object.keys(beforeA.tables).sort();
    check('백업 파일에 모든 테이블', same(Object.keys(file.tables).sort(), tableNames), tableNames.join(','));
    check('백업 파일 내용 = 기기 A DB (모든 테이블 값까지)', tableNames.every((t) => same(sortRows(t, file.tables[t]), sortRows(t, beforeA.tables[t]))));
    check('백업 받은 뒤 기기 A DB 그대로', same(await dumpDb(a), beforeA));
    await a.waitForTimeout(300);
    check('마지막 백업 시각 표시', /마지막으로 받은 백업/.test((await a.getByTestId('last-backup').textContent()) ?? ''));
    const userFavExpr = beforeA.tables.expressions.filter((e) => e.isFavorite).length;
    const userFavDlg = beforeA.tables.dialogues.filter((d) => d.isFavorite).length;

    // ── 기기 B (새 브라우저) ──
    console.log('\n── 기기 B: 새 기기에 복원 ──');
    const ctxB = await browser.newContext({ ...device, acceptDownloads: true });
    await ctxB.route(/^https:\/\/(i\.ytimg\.com|www\.youtube(-nocookie)?\.com)\//, (r) => r.fulfill({ status: 200, body: '' }));
    const b = await ctxB.newPage();
    watch(b);
    await openSettings(b);
    // 샘플만 있는 새 기기: 병합 미리보기에서 같은 샘플이 충돌로 보이는지 먼저 확인 (아무것도 쓰지 않음)
    const freshB = await dumpDb(b);
    await b.getByTestId('restore-file').setInputFiles(backupPath);
    await b.getByTestId('restore-preview').waitFor();
    const previewText = await b.getByTestId('restore-preview').innerText();
    check('샘플만 있는 새 기기: 병합 모드 + 충돌 목록 표시', /병합/.test(previewText) && (await b.getByTestId('conflict-list').isVisible()));
    await b.screenshot({ path: `${SHOTS}/sB0-02-merge-preview-with-samples.png`, fullPage: true });
    check('미리보기만으로는 DB 그대로', same(await dumpDb(b), freshB));
    await b.getByRole('button', { name: '취소' }).click();

    // 안내대로 샘플 삭제(기존 기능) 후 빈 기기 복원
    await b.getByRole('button', { name: '샘플 데이터 삭제' }).click();
    await b.getByRole('alertdialog').getByRole('button', { name: '샘플 삭제' }).click();
    await b.waitForTimeout(600);
    await b.getByTestId('restore-file').setInputFiles(backupPath);
    await b.getByTestId('restore-preview').waitFor();
    const emptyPreview = await b.getByTestId('restore-preview').innerText();
    check('샘플 삭제 후: 빈 기기 — 파일 그대로 복원 모드', /빈 기기/.test(emptyPreview));
    const beforeRestoreB = await dumpDb(b);
    const autoQueue = beforeRestoreB.tables.appMeta.find((m) => m.key === 'studyQueue');
    check('새 기기 학습 순서 = 자동으로 만든 빈 기본값', !!autoQueue && autoQueue.value.order.length === 0 && autoQueue.value.cycle === 1, JSON.stringify(autoQueue?.value ?? null).slice(0, 120));
    check('빈 기기 미리보기: 충돌 없음', !(await b.getByTestId('conflict-list').isVisible()));
    const replaceBox = b.getByTestId('replace-studyQueue');
    check('학습 순서: "바꿀 수 있는 설정"으로 변경 내용 표시, 기본은 바꾸지 않음(체크 해제)', (await b.getByTestId('replaceable-meta').isVisible()) && /빈 기본값.*→ 백업: 영상 \d+개/.test(await b.getByTestId('replaceable-meta').innerText()) && !(await replaceBox.isChecked()));
    await replaceBox.check();
    await b.screenshot({ path: `${SHOTS}/sB0-03-empty-preview.png`, fullPage: true });
    const [preDl] = await Promise.all([b.waitForEvent('download'), b.getByTestId('restore-apply').click()]);
    check('복원 직전 현재 데이터 백업 파일 자동 받기', /^my-english-study-before-restore-/.test(preDl.suggestedFilename()), preDl.suggestedFilename());
    await preDl.saveAs(`${TMP}/${preDl.suggestedFilename()}`);
    const dialogText = await b.getByRole('alertdialog').innerText();
    check('확인 창에 학습 순서 변경 내용 표시', /학습 순서: 백업 값으로 바꿉니다/.test(dialogText));
    await b.getByRole('alertdialog').screenshot({ path: `${SHOTS}/sB0-03b-confirm.png` });
    await b.getByRole('alertdialog').getByRole('button', { name: '복원하기' }).click();
    await b.getByTestId('restore-result').waitFor();
    await b.waitForTimeout(500);
    const afterB = await dumpDb(b);
    const diffs = tableNames.filter((t) => t !== 'appMeta' && !same(sortRows(t, afterB.tables[t]), sortRows(t, beforeA.tables[t])));
    check('기기 B = 기기 A (앱 설정을 뺀 11개 테이블 값까지)', diffs.length === 0, diffs.join(',') || '차이 없음');
    const metaB = Object.fromEntries(afterB.tables.appMeta.map((m) => [m.key, m.value]));
    const metaA = beforeA.tables.appMeta.filter((m) => !DEVICE_META.has(m.key));
    check('앱 설정: 학습 순서 포함 백업 값 복원 (기기별 설정 2개는 이 기기 값 유지)', metaA.every((m) => same(metaB[m.key], m.value)) && metaB.initializedAt === beforeRestoreB.tables.appMeta.find((m) => m.key === 'initializedAt')?.value, Object.keys(metaB).join(','));
    check(
      '즐겨찾기·어려워요·학습 기록 그대로',
      afterB.tables.expressions.filter((e) => e.isFavorite).length === userFavExpr &&
        afterB.tables.dialogues.filter((d) => d.isFavorite).length === userFavDlg &&
        afterB.tables.expressions.some((e) => e.isMarkedDifficult) &&
        afterB.tables.studyLogs.some((l) => l.id === 'e2e-log'),
      `☆ 표현 ${userFavExpr} · ★ 대화문 ${userFavDlg}`,
    );
    const snap = await dumpDb(b, 'my-english-study-snapshots');
    check('임시 안전 복사본 생성 (별도 저장소, 복원 직전)', snap.tables.snapshots?.length === 1 && snap.tables.snapshots[0].reason === 'before_restore');
    await b.reload();
    await b.getByTestId('backup-panel').waitFor();
    await b.waitForTimeout(400);
    check('임시 복사본 목록에 표시', await b.getByTestId('snapshot-list').isVisible());
    await b.screenshot({ path: `${SHOTS}/sB0-04-after-restore.png`, fullPage: true });
    check('복원 후 홈 정상 표시', await (async () => { await b.goto(BASE); return b.getByTestId('today-dialogue').waitFor({ timeout: 6000 }).then(() => true, () => false); })());

    // ── 기기 A: 같은 파일 다시 복원 (병합) ──
    console.log('\n── 기기 A: 같은 파일 병합 복원 · 잘못된 파일 ──');
    await openSettings(a);
    const beforeMerge = await dumpDb(a);
    await a.getByTestId('restore-file').setInputFiles(backupPath);
    await a.getByTestId('restore-preview').waitFor();
    const mergeText = await a.getByTestId('restore-preview').innerText();
    check('같은 파일 병합: 추가 0 · 충돌 0 · 복원 버튼 비활성', /새로 추가할 항목이 없어요/.test(mergeText) && !(await a.getByTestId('conflict-list').isVisible()) && (await a.getByTestId('restore-apply').isDisabled()));
    check('기기 A DB 그대로', same(await dumpDb(a), beforeMerge));

    // 수정된 파일
    const tampered = JSON.parse(readFileSync(backupPath, 'utf8'));
    tampered.tables.expressions[0].meaningKo = '몰래 바꿈';
    const tamperedPath = `${TMP}/tampered.json`;
    writeFileSync(tamperedPath, JSON.stringify(tampered));
    await a.getByTestId('restore-file').setInputFiles(tamperedPath);
    await a.getByTestId('restore-errors').waitFor();
    check('수정된 파일: 검증값 오류로 거부', /검증값/.test(await a.getByTestId('restore-errors').innerText()));
    writeFileSync(`${TMP}/not-json.json`, '{oops');
    await a.getByTestId('restore-file').setInputFiles(`${TMP}/not-json.json`);
    await a.getByTestId('restore-errors').waitFor();
    check('JSON 아닌 파일: 거부', /JSON/.test(await a.getByTestId('restore-errors').innerText()));
    await a.screenshot({ path: `${SHOTS}/sB0-05-rejected.png`, fullPage: true });
    check('거부 후 기기 A DB 그대로', same(await dumpDb(a), beforeMerge));

    // 화면 폭
    for (const [name, vp] of [['iPad 세로', { width: 810, height: 1080 }], ['iPad 가로', { width: 1080, height: 810 }], ['폰', { width: 390, height: 844 }]]) {
      await a.setViewportSize(vp);
      await openSettings(a);
      check(`${name}: 가로 넘침 없음`, await fits(a));
    }
    await a.setViewportSize({ width: 390, height: 844 });
    await openSettings(a);
    await a.getByTestId('backup-panel').screenshot({ path: `${SHOTS}/sB0-06-phone-panel.png` });

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
