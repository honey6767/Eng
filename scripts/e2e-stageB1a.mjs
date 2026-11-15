/**
 * B1-a E2E 점검 (Playwright, 실제 Chromium · 브라우저마다 새 임시 프로필)
 * 사용법: npm run build && npm run e2e:stageB1a
 *
 * 운영 앱이나 사용자 데이터는 건드리지 않는다. localhost 미리보기 서버와 새 브라우저 프로필에서만 실행한다.
 *
 * - 기기 A: 지금 배포본(v2)이 만든 것과 같은 모양의 IndexedDB(버전 20)를 테스트 데이터로 직접 만든 뒤 앱을 연다
 *   → 업데이트 안내 → '백업 파일 받고 업데이트' → v2 백업 파일 내려받기 → 임시 안전 복사본 → v3(30)
 *   → 기존 12개 테이블을 업데이트 전과 레코드 단위로 비교, 새 테이블 7개 확인, 다시 열면 안내 없음
 * - 기기 B: 새 기기 → 안내 없이 바로 v3, 업그레이드 기록 없음. 기기 A의 v2 백업 파일을 복원 미리보기 → 거부 없이 통과
 * - 기기 C: '백업 없이 업데이트' → 확인 창 → 성공
 * - 기기 D: 업그레이드 중 오류(같은 키가 미리 있음) → 실패 화면, DB는 v2(20)·데이터 그대로, 현재 데이터 파일 받기
 * - 기기 E: 다른 탭이 DB를 붙잡고 있으면 '다른 탭을 닫아 주세요' → 닫으면 이어서 완료
 * - 화면 폭(iPad 세로·가로·폰) 가로 넘침 없음. 외부 서비스는 호출하지 않는다.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const SHOTS = 'e2e-screenshots';
const TMP = 'e2e-screenshots/b1a-files';
mkdirSync(TMP, { recursive: true });
const PORT = 4187;
const BASE = `http://localhost:${PORT}`;
const V2_TABLES = ['playlists', 'videos', 'transcripts', 'expressionNotes', 'keySentences', 'dialogues', 'dialogueCompositions', 'expressions', 'reviewStates', 'dialogueProgress', 'studyLogs', 'appMeta'];
const V3_NEW = ['learningItems', 'dayAssignments', 'studySessions', 'dialogueDrafts', 'extractionJobs', 'extractionDrafts', 'aiRequests'];

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
const sortRows = (t, rows) => [...rows].sort((a, b) => String(t === 'appMeta' ? a.key : a.id).localeCompare(String(t === 'appMeta' ? b.key : b.id)));
const canon = (v) => (v && typeof v === 'object' ? (Array.isArray(v) ? v.map(canon) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/** 지금 배포본(Dexie v2 스키마)과 같은 저장소·인덱스로 버전 20 DB를 직접 만든다 (앱 코드 미사용) */
const createV2Db = (page, opts = {}) =>
  page.evaluate(
    ({ withLogKey }) =>
      new Promise((resolve, reject) => {
        const schema = {
          playlists: 'id, youtubePlaylistId',
          videos: 'id, playlistId, youtubeVideoId, status, orderIndex, randomOrderKey',
          transcripts: 'id, videoId, status',
          expressionNotes: 'id, videoId, expressionId',
          keySentences: 'id, videoId, [videoId+order], status',
          dialogues: 'id, kind, videoId, *sourceVideoIds',
          dialogueCompositions: 'id, &videoId',
          expressions: 'id, &normalizedKey',
          reviewStates: 'id, [itemType+itemId], itemType, nextReviewAt, weakness',
          dialogueProgress: 'id, &dialogueId',
          studyLogs: 'id, date, timestamp, activity, [itemType+itemId]',
          appMeta: 'key',
        };
        const T0 = Date.parse('2026-10-01T09:00:00.000Z');
        const at = (i) => new Date(T0 + i * 3600000).toISOString();
        const req = indexedDB.open('my-english-study', 20);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const [name, spec] of Object.entries(schema)) {
            const [pk, ...idx] = spec.split(',').map((s) => s.trim());
            const store = db.createObjectStore(name, { keyPath: pk });
            for (const raw of idx) {
              const unique = raw.startsWith('&');
              const multiEntry = raw.startsWith('*');
              const nm = raw.replace(/^[&*]/, '');
              const keyPath = nm.startsWith('[') ? nm.slice(1, -1).split('+') : nm;
              store.createIndex(nm, keyPath, { unique, multiEntry });
            }
          }
          const s = (n) => req.transaction.objectStore(n);
          s('playlists').add({ id: 'pl-1', createdAt: at(0), updatedAt: at(0), youtubePlaylistId: 'PLtestFixture0000001', title: '100일 챌린지 (테스트)', description: null, channelTitle: '테스트', thumbnailUrl: null, itemCount: 103, lastSyncedAt: at(0), metadataSource: 'youtube_api', lastSync: null });
          for (let i = 0; i < 103; i++) {
            const title = i < 100 ? `[Day ${i + 1}] 테스트 영상 ${i + 1}` : i === 100 ? '[Day 7] 같은 Day 번호 영상' : `긴 강의 ${i}`;
            s('videos').add({ id: `v-${String(i + 1).padStart(3, '0')}`, createdAt: at(i), updatedAt: at(i + 1), playlistId: 'pl-1', youtubeVideoId: `yt${String(i).padStart(9, '0')}`, title, url: null, thumbnailUrl: null, durationSec: i === 101 ? 32400 : 260, orderIndex: i, randomOrderKey: ((i * 37) % 103) / 103, status: i < 20 ? 'completed' : 'new', completedAt: i < 20 ? at(i + 2) : null, sources: [{ kind: 'playlist', playlistId: 'pl-1', position: i, addedAt: at(i) }], channelTitle: '테스트', captionCheck: null, metadataSource: 'youtube_api' });
          }
          for (let i = 0; i < 30; i++) s('transcripts').add({ id: `tr-${i + 1}`, createdAt: at(i), updatedAt: at(i + 3), videoId: `v-${String(i + 1).padStart(3, '0')}`, source: i % 3 ? 'manual_paste' : 'youtube', status: i % 10 === 9 ? 'failed' : 'success', format: i % 2 ? 'srt' : null, rawText: `line ${i}`, segments: [{ start: 1, end: 3, text: `line ${i}` }] });
          for (let i = 0; i < 40; i++) s('expressions').add({ id: `ex-${i + 1}`, createdAt: at(i), updatedAt: at(i + 5), normalizedKey: `could use ${i + 1}`, text: `could use ${i + 1}`, meaningKo: `뜻 ${i + 1}`, sourceRefs: [{ videoId: `v-${String((i % 25) + 1).padStart(3, '0')}`, dialogueId: null, sentenceId: null }], isFavorite: i % 6 === 0, isMarkedDifficult: i % 8 === 0 });
          for (let k = 0; k < 50; k++) s('keySentences').add({ id: `ks-${k + 1}`, createdAt: at(k), updatedAt: at(k + 2), videoId: `v-${String(Math.floor(k / 2) + 1).padStart(3, '0')}`, order: (k % 2) + 1, english: `I could use some help ${k + 1}.`, korean: `도움 ${k + 1}`, expressionIds: k === 3 ? [] : [`ex-${(k % 40) + 1}`], situation: '상황', timestampSec: 10 + k, status: 'learning', correctCount: k % 3, wrongCount: k % 2 });
          for (let i = 0; i < 15; i++) s('reviewStates').add({ id: `expression:ex-${i + 1}`, itemType: 'expression', itemId: `ex-${i + 1}`, correctCount: i, wrongCount: i % 3, lastResult: 'easy', lastStudiedAt: at(50 + i), nextReviewAt: at(80 + i), weakness: (i * 7) % 100, streak: 0, intervalIndex: 1, reviewCount: i + 1, lastQuizzedAt: null });
          for (let i = 0; i < 60; i++) s('studyLogs').add({ id: `log-${i + 1}`, timestamp: at(60 + i), date: at(60 + i).slice(0, 10), activity: 'expression_review', itemType: 'expression', itemId: `ex-${(i % 40) + 1}`, rating: 'easy', isReview: true });
          s('appMeta').add({ key: 'initializedAt', value: at(0) });
          s('appMeta').add({ key: 'schemaVersion', value: 2 });
          s('appMeta').add({ key: 'sampleSeededAt', value: at(0) });
          if (withLogKey) s('appMeta').add({ key: 'migrationLog', value: 'pre-existing' });
        };
        req.onsuccess = () => {
          req.result.close();
          resolve(true);
        };
        req.onerror = () => reject(req.error);
      }),
    { withLogKey: !!opts.withLogKey },
  );

/** IndexedDB 직접 덤프 (앱 코드를 거치지 않음) */
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
          if (names.length === 0) {
            db.close();
            return resolve(out);
          }
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

/** 앱 페이지가 아닌 같은 출처의 정적 파일 — 앱이 DB를 열기 전에 테스트 DB를 만들기 위해 */
const blankPage = async (ctx) => {
  const p = await ctx.newPage();
  await p.goto(`${BASE}/manifest.webmanifest`);
  return p;
};

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const device = devices['iPad (gen 7)'];
  const errors = [];
  const watch = (p, allow = []) => {
    p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    p.on('console', (m) => {
      if (m.type() === 'error' && !allow.some((a) => a.test(m.text()))) errors.push(`console: ${m.text()}`);
    });
  };
  const report = { existingTables: [], newTables: [], appMetaChanges: [] };
  try {
    // ── 기기 A ──
    console.log('── 기기 A: v2 DB → 백업 파일 받고 업데이트 ──');
    const ctxA = await browser.newContext({ ...device, acceptDownloads: true });
    const prepA = await blankPage(ctxA);
    await createV2Db(prepA);
    const before = await dumpDb(prepA);
    await prepA.close();
    check('준비: 테스트 v2 DB(버전 20, 테이블 12개)', before.version === 20 && Object.keys(before.tables).length === 12, `영상 ${before.tables.videos.length}개`);

    const a = await ctxA.newPage();
    watch(a);
    await a.goto(BASE);
    await a.getByTestId('db-upgrade').waitFor();
    await a.evaluate(() => document.fonts.ready);
    check('v2 DB가 있으면 앱을 열기 전에 업데이트 안내', await a.getByTestId('upgrade-with-backup').isVisible());
    check('안내를 보는 동안 DB는 아직 v2(20)', (await dumpDb(a)).version === 20);
    await a.screenshot({ path: `${SHOTS}/sB1a-01-prompt.png`, fullPage: true });

    const [dl] = await Promise.all([a.waitForEvent('download'), a.getByTestId('upgrade-with-backup').click()]);
    const dlPath = `${TMP}/${dl.suggestedFilename()}`;
    await dl.saveAs(dlPath);
    const v2File = JSON.parse(readFileSync(dlPath, 'utf8'));
    check(
      '업데이트 전에 v2 백업 파일 내려받기 (테이블 12개, 개수 일치)',
      v2File.schemaVersion === 2 && Object.keys(v2File.tables).length === 12 && V2_TABLES.every((t) => v2File.counts[t] === before.tables[t].length),
      dl.suggestedFilename(),
    );
    check('백업 파일 레코드 = 업데이트 전 DB', V2_TABLES.every((t) => same(sortRows(t, v2File.tables[t]), sortRows(t, before.tables[t]))));

    await a.getByTestId('db-upgrade').waitFor({ state: 'detached', timeout: 20000 });
    await a.locator('main').first().waitFor();
    await a.waitForTimeout(800);
    const after = await dumpDb(a);
    check('업데이트 후 DB 버전 30, 테이블 19개', after.version === 30 && Object.keys(after.tables).length === 19);
    for (const t of V2_TABLES.filter((x) => x !== 'appMeta')) {
      const ok = same(sortRows(t, after.tables[t]), sortRows(t, before.tables[t]));
      report.existingTables.push({ table: t, before: before.tables[t].length, after: after.tables[t].length, identical: ok });
      check(`기존 ${t}: 레코드 단위로 같음`, ok, `${before.tables[t].length} → ${after.tables[t].length}`);
    }
    // appMeta: 업그레이드가 더한 migrationLog, 앱 시작 때마다 하는 기존 동작(schemaVersion 값 갱신 등)을 따로 기록
    const metaBefore = new Map(before.tables.appMeta.map((m) => [m.key, m.value]));
    const metaAfter = new Map(after.tables.appMeta.map((m) => [m.key, m.value]));
    for (const k of new Set([...metaBefore.keys(), ...metaAfter.keys()])) {
      if (!same(metaBefore.get(k), metaAfter.get(k))) report.appMetaChanges.push({ key: k, before: metaBefore.has(k) ? metaBefore.get(k) : '(없음)', after: k === 'migrationLog' ? '(업그레이드 기록)' : metaAfter.has(k) ? metaAfter.get(k) : '(없음)' });
    }
    const removedMeta = [...metaBefore.keys()].filter((k) => !metaAfter.has(k));
    check('appMeta: 기존 키가 하나도 사라지지 않음', removedMeta.length === 0, removedMeta.join(','));
    check('appMeta: 기존 키 중 값이 바뀐 것은 schemaVersion(2→3, 앱 시작 시 기존 동작)뿐', report.appMetaChanges.filter((c) => metaBefore.has(c.key)).every((c) => c.key === 'schemaVersion' && c.after === 3), JSON.stringify(report.appMetaChanges.filter((c) => metaBefore.has(c.key))).slice(0, 200));
    const log = metaAfter.get('migrationLog');
    for (const t of V3_NEW) {
      report.newTables.push({ table: t, count: after.tables[t].length, logged: log?.created?.[t] });
    }
    check('새 테이블 개수 = migrationLog', !!log && V3_NEW.every((t) => after.tables[t].length === log.created[t]), V3_NEW.map((t) => `${t}:${after.tables[t].length}`).join(' '));
    check('Day 제안 101개(Day 1~100 + 같은 Day 7), Day 없는 영상은 제안 없음', after.tables.dayAssignments.length === 101 && !after.tables.dayAssignments.some((d) => d.videoId === 'v-102' || d.videoId === 'v-103'));
    check('학습 대상 49개(표현 없는 핵심 문장 1개 제외), 경고 기록', after.tables.learningItems.length === 49 && log.warnings.some((w) => w.code === 'key_sentence_without_expression'));
    check('기존 자막의 출처·상태·형식 그대로', same(sortRows('transcripts', after.tables.transcripts).map((t) => [t.source, t.status, t.format ?? null]), sortRows('transcripts', before.tables.transcripts).map((t) => [t.source, t.status, t.format ?? null])));
    const snaps = await dumpDb(a, 'my-english-study-snapshots');
    const snap = (snaps.tables.snapshots ?? []).find((s) => s.reason === 'before_upgrade_v3');
    check('임시 안전 복사본(before_upgrade_v3) 저장, 개수 = 업데이트 전', !!snap && snap.schemaVersion === 2 && V2_TABLES.every((t) => snap.counts[t] === before.tables[t].length));
    await a.screenshot({ path: `${SHOTS}/sB1a-02-after-upgrade-home.png`, fullPage: true });

    await a.reload();
    await a.locator('main').first().waitFor();
    await a.waitForTimeout(500);
    check('다시 열면 안내 없이 바로 열림', !(await a.getByTestId('db-upgrade').isVisible().catch(() => false)));

    // ── 기기 B: 새 기기 ──
    console.log('\n── 기기 B: 새 기기 ──');
    const ctxB = await browser.newContext({ ...device, acceptDownloads: true });
    const b = await ctxB.newPage();
    watch(b);
    await b.goto(BASE);
    await b.locator('main').first().waitFor();
    await b.waitForTimeout(800);
    const freshB = await dumpDb(b);
    check('새 기기: 안내 없이 바로 v3(30), 테이블 19개', freshB.version === 30 && Object.keys(freshB.tables).length === 19 && !(await b.getByTestId('db-upgrade').isVisible().catch(() => false)));
    check('새 기기: 업그레이드 기록 없음', !freshB.tables.appMeta.some((m) => m.key === 'migrationLog'));
    await b.goto(`${BASE}/settings#backup`);
    await b.getByTestId('backup-panel').waitFor();
    await b.getByTestId('restore-file').setInputFiles(dlPath);
    await b.getByTestId('restore-preview').waitFor();
    check('기존 v2 백업 파일: v3 앱에서 거부 없이 복원 미리보기', !(await b.getByTestId('restore-errors').isVisible().catch(() => false)));
    await b.screenshot({ path: `${SHOTS}/sB1a-03-v2-file-preview.png`, fullPage: true });
    check('미리보기만으로는 DB 그대로', same(await dumpDb(b), freshB));
    await b.getByRole('button', { name: '취소' }).click();

    // ── 기기 C: 백업 없이 ──
    console.log('\n── 기기 C: 백업 없이 업데이트 ──');
    const ctxC = await browser.newContext({ ...device });
    const prepC = await blankPage(ctxC);
    await createV2Db(prepC);
    const beforeC = await dumpDb(prepC);
    await prepC.close();
    const c = await ctxC.newPage();
    watch(c);
    await c.goto(BASE);
    await c.getByTestId('db-upgrade').waitFor();
    c.once('dialog', (d) => d.accept());
    await c.getByTestId('upgrade-without-backup').click();
    await c.getByTestId('db-upgrade').waitFor({ state: 'detached', timeout: 20000 });
    await c.waitForTimeout(800);
    const afterC = await dumpDb(c);
    check('확인 후 업데이트 완료, 기존 데이터 테이블 그대로', afterC.version === 30 && V2_TABLES.filter((t) => t !== 'appMeta').every((t) => same(sortRows(t, afterC.tables[t]), sortRows(t, beforeC.tables[t]))));

    // ── 기기 D: 실패 ──
    console.log('\n── 기기 D: 업그레이드 중 오류 ──');
    const ctxD = await browser.newContext({ ...device, acceptDownloads: true });
    const prepD = await blankPage(ctxD);
    await createV2Db(prepD, { withLogKey: true });
    const beforeD = await dumpDb(prepD);
    await prepD.close();
    const d = await ctxD.newPage();
    watch(d, [/ConstraintError|업그레이드|Upgrade|Failed to load resource/i]);
    await d.goto(BASE);
    await d.getByTestId('db-upgrade').waitFor();
    d.once('dialog', (x) => x.accept());
    await d.getByTestId('upgrade-without-backup').click();
    await d.getByTestId('upgrade-failed').waitFor({ timeout: 20000 });
    await d.screenshot({ path: `${SHOTS}/sB1a-04-failed.png`, fullPage: true });
    const afterD = await dumpDb(d);
    check('실패 화면 표시, DB는 v2(20) 그대로', afterD.version === 20 && Object.keys(afterD.tables).length === 12);
    check('실패해도 기존 12개 테이블 레코드 그대로', V2_TABLES.every((t) => same(sortRows(t, afterD.tables[t]), sortRows(t, beforeD.tables[t]))));
    const [dlD] = await Promise.all([d.waitForEvent('download'), d.getByTestId('upgrade-download-current').click()]);
    const curFile = JSON.parse(readFileSync(await dlD.path(), 'utf8'));
    check('실패 화면에서 현재 데이터를 파일로 받기 (v2, 12개 테이블)', curFile.schemaVersion === 2 && Object.keys(curFile.tables).length === 12);

    // ── 기기 E: 다른 탭이 막을 때 ──
    console.log('\n── 기기 E: 다른 탭이 DB를 붙잡고 있을 때 ──');
    const ctxE = await browser.newContext({ ...device });
    const holder = await blankPage(ctxE);
    await createV2Db(holder);
    // 버전 변경 요청을 무시하는 오래된 연결 (닫히지 않음)
    await holder.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('my-english-study');
      r.onsuccess = () => {
        window.__held = r.result;
        res(true);
      };
    }));
    const e = await ctxE.newPage();
    watch(e);
    await e.goto(BASE);
    await e.getByTestId('db-upgrade').waitFor();
    e.once('dialog', (x) => x.accept());
    await e.getByTestId('upgrade-without-backup').click();
    await e.getByTestId('upgrade-blocked').waitFor({ timeout: 15000 });
    check("다른 탭이 막으면 '다른 탭을 닫아 주세요' 안내", true);
    await e.screenshot({ path: `${SHOTS}/sB1a-05-blocked.png`, fullPage: true });
    await holder.evaluate(() => window.__held.close());
    await e.getByTestId('db-upgrade').waitFor({ state: 'detached', timeout: 20000 });
    check('다른 탭을 닫으면 이어서 완료', (await dumpDb(e)).version === 30);

    // 화면 폭
    const ctxW = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const prepW = await blankPage(ctxW);
    await createV2Db(prepW);
    await prepW.close();
    const w = await ctxW.newPage();
    await w.goto(BASE);
    await w.getByTestId('db-upgrade').waitFor();
    for (const [name, vp] of [['폰', { width: 390, height: 844 }], ['iPad 세로', { width: 810, height: 1080 }], ['iPad 가로', { width: 1080, height: 810 }]]) {
      await w.setViewportSize(vp);
      check(`업데이트 안내 ${name}: 가로 넘침 없음`, await fits(w));
    }
    await w.setViewportSize({ width: 390, height: 844 });
    await w.screenshot({ path: `${SHOTS}/sB1a-06-phone-prompt.png`, fullPage: true });

    check('브라우저 오류 없음 (실패 시험의 의도된 오류 제외)', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    writeFileSync(`${TMP}/e2e-comparison.json`, JSON.stringify(report, null, 2));
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
