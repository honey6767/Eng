/**
 * 구버전 앱(기본 d6fbd36) + 새 서버(Worker와 같은 코드) 조합 E2E — 자동 처리 상한 우회 차단 확인
 * (Playwright, 새 임시 프로필, 가짜 YouTube·가짜 Gemini — 실제 Google 호출 없음)
 * 사용법: node scripts/e2e-oldapp.mjs   (OLD_APP_COMMIT로 다른 커밋 지정 가능)
 *
 * 구버전 앱은 요청 유형 표시(origin)를 보내지 않는다 → 새 서버는 모두 자동 작업으로 센다.
 * - 운영과 같은 상한(하루 16회, 자동 6회)과 요청 간격(15초)으로 실행
 * - 구버전 앱의 버튼·대기열·다시 시도 요청 모두 자동 6회 안으로 묶임 (Gemini 생성 6번)
 * - 잘못된·누락된 표시로 보내도 우회 불가, 정확한 사용자 표시만 사용자 작업
 * - 15초 간격, Google 한도 초과 시 전체 차단은 구버전 앱에도 그대로
 * - 구버전 앱의 Gemini 처리 실패 동작 (그 영상만 실패, 다음 영상으로 계속, 실패 영상 자동 재요청 없음)
 * - 기존 학습 데이터·DB 버전 그대로
 */
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const SHOTS = 'e2e-screenshots';
mkdirSync(SHOTS, { recursive: true });
const PORT = 4209;
const BASE = `http://localhost:${PORT}`;
const OLD_COMMIT = process.env.OLD_APP_COMMIT || 'd6fbd36';
const GAP_SEC = 15;
const REPO = resolve('.');

/** 구버전 앱을 임시 작업 폴더에 빌드 (현재 작업 폴더·브랜치는 건드리지 않음) */
function buildOldApp() {
  const work = mkdtempSync(join(tmpdir(), 'mes-oldapp-'));
  const src = join(work, 'src');
  execFileSync('git', ['worktree', 'add', '--detach', src, OLD_COMMIT], { cwd: REPO, stdio: 'pipe' });
  if (!existsSync(join(src, 'node_modules'))) symlinkSync(join(REPO, 'node_modules'), join(src, 'node_modules'));
  const out = join(work, 'dist');
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', out, '--emptyOutDir'], { cwd: src, stdio: 'pipe', env: { ...process.env, VITE_API_BASE_URL: '' } });
  return { work, src, out };
}

function startServer(outDir) {
  // 현재 코드의 서버(가짜 Gemini)로 구버전 앱 파일을 제공
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort', '--outDir', outDir], {
    stdio: 'pipe',
    env: { ...process.env, YOUTUBE_API_KEY: '', YOUTUBE_API_MOCK: '1', AI_GEMINI_MOCK: '1', GEMINI_API_KEY: '', AI_MIN_GAP_SEC: String(GAP_SEC), YOUTUBE_QUOTA_FILE: join(tmpdir(), `mes-e2e-oldapp-quota-${process.pid}.json`) },
  });
  return new Promise((resolveP, reject) => {
    const t = setTimeout(() => reject(new Error('preview server timeout')), 20000);
    server.stdout.on('data', (d) => {
      if (String(d).includes(String(PORT))) {
        clearTimeout(t);
        resolveP(server);
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
      new Promise((res, rej) => {
        const req = indexedDB.open('my-english-study');
        req.onerror = () => rej(req.error);
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
                res(out);
              }
            };
          }
        };
      }),
  );

// Day 1~9 (자막 있음, 자료 1회씩). Day 3은 가짜 Gemini가 처리 실패로 끝내는 영상
const VIDEOS = Array.from({ length: 9 }, (_, i) => ({ id: `d${i + 1}`, yt: i === 2 ? 'mockFail001' : `oldAppVid0${i + 1}`, title: `[Day ${i + 1}] 구버전 시험 ${i + 1}` }));

const seed = (page, videos) =>
  page.evaluate(
    (videos) =>
      new Promise((res, rej) => {
        const req = indexedDB.open('my-english-study');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['videos', 'transcripts', 'dialogues', 'dialogueProgress', 'reviewStates'], 'readwrite');
          const now = '2026-11-19T01:00:00.000Z';
          videos.forEach((v, i) => {
            tx.objectStore('videos').add({ id: v.id, createdAt: now, updatedAt: now, playlistId: null, youtubeVideoId: v.yt, title: v.title, url: null, thumbnailUrl: null, durationSec: 300, orderIndex: i, randomOrderKey: i / 10, status: 'new', completedAt: null, sources: [{ kind: 'manual', addedAt: now }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
            const lines = [`1. I could use a break ${i + 1}.`];
            tx.objectStore('transcripts').add({ id: `tr-${v.id}`, createdAt: now, updatedAt: now, videoId: v.id, source: 'manual_paste', status: 'success', rawText: lines.join('\n'), segments: lines.map((text, j) => ({ startSec: j * 10, endSec: j * 10 + 9, text })), format: 'timestamped' });
          });
          tx.objectStore('dialogues').add({ id: 'dlg-user-1', createdAt: now, updatedAt: now, kind: 'original', videoId: null, sourceVideoIds: [], orderInVideo: 1, title: '기존 대화문', situation: '기존', lines: [], expressionIds: [], generatedBy: 'manual', isFavorite: true });
          tx.objectStore('dialogueProgress').add({ id: 'dlg-user-1', dialogueId: 'dlg-user-1', currentStep: 5, highestCompletedStep: 5, stepResults: [], memorized: true, memorizedAt: now, blankMastery: {}, updatedAt: now });
          tx.objectStore('reviewStates').add({ id: 'dialogue:dlg-user-1', createdAt: now, updatedAt: now, itemType: 'dialogue', itemId: 'dlg-user-1', intervalIndex: 2, reviewCount: 2, correctCount: 2, streak: 2, lastResult: 'easy', lastStudiedAt: now, nextReviewAt: '2026-11-22T01:00:00.000Z' });
          tx.oncomplete = () => {
            db.close();
            res(true);
          };
          tx.onerror = () => rej(tx.error);
        };
      }),
    videos,
  );

async function waitFor(fn, tries = 120, ms = 500) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, ms));
  }
  return false;
}

/** 앱 밖에서 서버로 직접 보내기 (다른 기기·조작된 클라이언트 흉내) — 끝날 때까지 같은 식별자로 조회 */
const direct = (page, body, poll = false) =>
  page.evaluate(
    async ({ body, poll }) => {
      const key = crypto.randomUUID();
      const send = async () => {
        const r = await fetch('/api/ai/extract', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json() };
      };
      let r = await send();
      // 요청 간격 대기(interactionId 없음)는 생성이 아님 — 기다렸다 같은 식별자로 다시
      for (let i = 0; i < 10 && r.body.state === 'pending' && !r.body.interactionId; i++) {
        await new Promise((x) => setTimeout(x, (r.body.retryAfterSec ?? 5) * 1000 + 300));
        r = await send();
      }
      const created = r.body.state === 'pending' && !!r.body.interactionId;
      for (let i = 0; poll && i < 60 && r.body.state === 'pending'; i++) {
        await new Promise((x) => setTimeout(x, 1000));
        r = await send();
      }
      return { ...r, created };
    },
    { body, poll },
  );

async function main() {
  console.log(`구버전 앱 빌드: ${OLD_COMMIT} …`);
  const old = buildOldApp();
  const server = await startServer(old.out);
  const browser = await chromium.launch();
  const errors = [];
  const sends = [];
  try {
    const ctx = await browser.newContext({ ...devices['iPad (gen 7)'] });
    await ctx.route(/^https:\/\/(i\.ytimg\.com|www\.youtube(-nocookie)?\.com)\//, (r) => r.fulfill({ status: 200, body: '' }));
    ctx.on('response', async (r) => {
      if (!r.url().endsWith('/api/ai/extract')) return;
      const b = JSON.parse(r.request().postData() || '{}');
      const j = await r.json().catch(() => ({}));
      sends.push({ at: Date.now(), task: b.task ?? 'extract', videoId: b.videoId, hasOrigin: 'origin' in b || 'auto' in b, retry: !!b.retryFailed, status: r.status(), state: j.state, code: j.code, interactionId: j.interactionId ?? null, retryAfterSec: j.retryAfterSec });
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));

    await page.goto(BASE);
    await page.locator('main').first().waitFor();
    await page.waitForTimeout(600);
    await seed(page, VIDEOS);
    const before = await dumpDb(page);
    const appSends = () => sends.filter((s) => s.videoId !== 'manual-direct');
    const createdIds = () => [...new Set(sends.filter((s) => s.state === 'pending' && s.interactionId).map((s) => s.videoId))];

    // ── 1. 구버전 앱의 '이 영상 자료 만들기' 버튼 (사용자 작업이지만 표시가 없음 → 자동으로 셈) ──
    for (const id of ['d1', 'd2']) {
      await page.goto(`${BASE}/videos/${id}`);
      await page.getByTestId('video-prep-enqueue').click();
      await waitFor(async () => sends.some((s) => s.videoId === `oldAppVid0${id.slice(1)}` && s.state === 'succeeded'), 120, 500);
    }
    check('구버전 앱 버튼 요청 2건 처리 (표시 없이 보냄)', createdIds().length === 2 && appSends().every((s) => !s.hasOrigin), createdIds().join(','));

    // ── 2. 구버전 앱 '기존 영상 자료 만들기 시작' ──
    await page.goto(`${BASE}/extraction`);
    await page.getByTestId('prep-start-all').click();
    // 자동 몫을 다 써서 Day 7~9가 auto_cap을 받을 때까지 (구버전 앱은 그 영상을 실패로 두고 다음으로 넘어감)
    const settled = await waitFor(async () => ['oldAppVid07', 'oldAppVid08', 'oldAppVid09'].every((v) => sends.some((s) => s.videoId === v && s.code)), 600, 500);
    await waitFor(async () => /대기 0/.test((await page.getByTestId('prep-counts').innerText().catch(() => '')) || ''), 60, 500);
    await page.waitForTimeout(2000);
    const created = createdIds();
    check('구버전 앱의 모든 요청은 자동으로 세어 Gemini 생성은 하루 자동 몫 6번까지', settled && created.length === 6 && created.join(',') === 'oldAppVid01,oldAppVid02,mockFail001,oldAppVid04,oldAppVid05,oldAppVid06', created.join(','));
    const blocked = sends.filter((s) => ['oldAppVid07', 'oldAppVid08', 'oldAppVid09'].includes(s.videoId));
    check('7번째부터는 Gemini 호출 없이 auto_cap (HTTP 429)', blocked.length >= 3 && blocked.every((s) => s.code === 'auto_cap' && s.status === 429 && !s.interactionId), blocked.map((s) => `${s.videoId}:${s.status}:${s.code}`).join(','));
    check('구버전 앱은 끝까지 표시를 보내지 않음', appSends().every((s) => !s.hasOrigin));
    // 15초 간격 (구버전 앱에도 서버가 적용)
    const firstAt = created.map((v) => sends.find((s) => s.videoId === v && s.state === 'pending' && s.interactionId).at);
    const gaps = firstAt.slice(1).map((t, i) => t - firstAt[i]);
    check(`구버전 앱에도 생성 요청 간격 ${GAP_SEC}초 적용`, gaps.every((g) => g >= GAP_SEC * 1000 - 500), gaps.map((g) => `${(g / 1000).toFixed(1)}초`).join(', '));
    check('간격을 기다리는 동안은 Gemini를 부르지 않고 잠시 뒤로', sends.some((s) => s.state === 'pending' && s.interactionId === null && s.retryAfterSec > 0));
    // 구버전 앱의 Gemini 처리 실패 동작
    const failSends = sends.filter((s) => s.videoId === 'mockFail001');
    const afterFail = sends.findIndex((s) => s.videoId === 'oldAppVid04');
    check('구버전 앱: 처리 실패(Day 3)는 그 영상만 실패, 다음 영상으로 계속 (멈추지 않음)', failSends.some((s) => s.code === 'gemini_failed') && afterFail > sends.findIndex((s) => s.videoId === 'mockFail001' && s.code === 'gemini_failed'));
    check('구버전 앱: 실패한 영상을 자동으로 다시 생성하지 않음', new Set(sends.filter((s) => s.videoId === 'mockFail001' && s.interactionId).map((s) => s.interactionId)).size === 1, `Gemini 작업 ${new Set(sends.filter((s) => s.videoId === 'mockFail001' && s.interactionId).map((s) => s.interactionId)).size}개`);
    const counts = await page.getByTestId('prep-counts').innerText();
    check('구버전 앱 화면: auto_cap 영상은 실패로 표시됨 (구버전은 이 코드를 모름)', /실패 4/.test(counts), counts);
    await page.screenshot({ path: `${SHOTS}/oldapp-01.png`, fullPage: true });

    // ── 3. 구버전 앱 '실패만 다시 시도' — 표시 없음 → 자동 몫 → 막힘 ──
    const n0 = sends.length;
    if (await page.getByTestId('prep-retry-all').count()) await page.getByTestId('prep-retry-all').click();
    await waitFor(async () => sends.slice(n0).length >= 4, 120, 500);
    await page.waitForTimeout(3000);
    const retried = sends.slice(n0);
    check('구버전 앱 다시 시도도 자동 몫으로 막힘 (Gemini 생성 없음)', retried.length > 0 && retried.every((s) => !s.interactionId && (s.code === 'auto_cap' || s.state === 'pending')) && createdIds().length === 6, retried.map((s) => `${s.videoId}:${s.code ?? s.state}`).join(','));

    // ── 4. 조작·누락된 표시로 직접 보내기 ──
    const tricks = [
      ['표시 없음', {}],
      ['대문자 USER', { origin: 'USER' }],
      ['공백 포함', { origin: 'user ' }],
      ['true', { origin: true }],
      ['배열', { origin: ['user'] }],
      ['user + auto:true', { origin: 'user', auto: true }],
      ['auto:false만', { auto: false }],
    ];
    const trickOut = [];
    for (const [i, [label, extra]] of tricks.entries()) {
      const r = await direct(page, { videoId: `trickVid0${i}x`.slice(0, 11), durationSec: 60, promptVersion: 'v1', ...extra });
      trickOut.push(`${label}:${r.status}:${r.body.code ?? r.body.state}`);
      if (!(r.status === 429 && r.body.code === 'auto_cap' && !r.created)) trickOut.push('← 우회!');
    }
    check('누락·잘못된·서로 맞지 않는 표시는 모두 자동으로 → 우회 불가', !trickOut.includes('← 우회!'), trickOut.join(' / '));
    const okUser = await direct(page, { videoId: 'userDirect1', durationSec: 60, promptVersion: 'v1', origin: 'user' });
    check('정확한 사용자 표시(origin: user)만 사용자 작업으로 통과', okUser.created, `${okUser.status}:${okUser.body.state}`);

    // ── 5. Google 한도 초과 → 모든 요청 차단 (구버전 앱 포함) ──
    await page.waitForTimeout(GAP_SEC * 1000);
    const q = await direct(page, { videoId: 'mockExhaus1', durationSec: 60, promptVersion: 'v1', origin: 'user' }, true);
    check('작업이 한도 초과로 끝나면 gemini_quota (HTTP 429)', q.status === 429 && q.body.code === 'gemini_quota', `${q.status}:${q.body.code}`);
    const afterQuotaUser = await direct(page, { videoId: 'userDirect2', durationSec: 60, promptVersion: 'v1', origin: 'user' });
    const afterQuotaOld = await direct(page, { videoId: 'oldDirect01', durationSec: 60, promptVersion: 'v1' });
    check('차단 뒤: 사용자 표시가 있어도·구버전 요청도 Gemini 호출 없이 daily_cap', afterQuotaUser.body.code === 'daily_cap' && afterQuotaOld.body.code === 'daily_cap' && !afterQuotaUser.created && !afterQuotaOld.created, `${afterQuotaUser.body.code} / ${afterQuotaOld.body.code}`);
    const usage = await page.evaluate(async () => (await fetch('/api/ai/usage', { method: 'POST' })).json());
    check('사용량: 전체 16/16 · 자동 6/6', usage.requests === 16 && usage.dailyRequests === 16 && usage.auto?.used === 6 && usage.auto?.cap === 6, JSON.stringify({ r: usage.requests, d: usage.dailyRequests, a: usage.auto }));

    // ── 6. 보존 ──
    const after = await dumpDb(page);
    for (const t of ['dialogueProgress', 'reviewStates', 'transcripts', 'videos']) check(`기존 ${t} 그대로`, same(before.tables[t], after.tables[t]));
    check('기존 대화문 그대로 (새 자료만 추가)', same(before.tables.dialogues.find((d) => d.id === 'dlg-user-1'), after.tables.dialogues.find((d) => d.id === 'dlg-user-1')));
    check('학습 DB 버전 30 그대로', before.version === 30 && after.version === 30, String(after.version));
    check('브라우저 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.kill();
    try {
      execFileSync('git', ['worktree', 'remove', '--force', old.src], { cwd: REPO, stdio: 'pipe' });
    } catch {
      /* 임시 폴더 정리 실패는 무시 */
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 통과`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
