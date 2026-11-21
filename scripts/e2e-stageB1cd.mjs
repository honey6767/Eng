/**
 * B1-c·B1-d E2E 점검 (Playwright, 실제 Chromium · 새 임시 프로필) — 가짜 Gemini(AI_GEMINI_MOCK=1), 실제 Google 호출 없음
 * 사용법: npm run build && npm run e2e:stageB1cd
 *
 * - 테스트 영상: 보통(자동 적용) · 전사 부족(확인 필요) · AI 실패(다시 추출) · 길이 초과 구간(경고 후 자동 적용) · 자막 있음 · 긴 영상
 *   + 사용자가 이미 만든 같은 표현 'could use'(즐겨찾기·어려워요)
 * - '학습 시작' 한 번 → 자동 추출 → 품질이 괜찮은 결과는 자동으로 학습 자료(AI 자막·표현·학습 대상)
 * - AI 자막 관리: 확인 필요 검토 → 표현 일부 빼고 적용 / 실패한 영상 모두 다시 추출(사용자가 누를 때만 새 요청)
 * - Day 정리: 제안 모두 확정 → 번호 없는 영상 직접 입력 → 학습 대상이 Day로
 * - 기존 레코드는 하나도 바뀌지 않고 자막·표현만 추가 ('학습 시작'이 원래 바꾸는 값 제외)
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const SHOTS = 'e2e-screenshots';
mkdirSync(SHOTS, { recursive: true });
const PORT = 4189;
const BASE = `http://localhost:${PORT}`;

function startServer() {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'pipe',
    env: { ...process.env, YOUTUBE_API_KEY: '', YOUTUBE_API_MOCK: '', AI_GEMINI_MOCK: '1', GEMINI_API_KEY: '', AI_DAILY_AUTO_CAP: '50', AI_DAILY_REQUEST_CAP: '50' },
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
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const dumpDb = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('my-english-study');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const names = [...db.objectStoreNames];
          const out = { tables: {} };
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
          const tx = db.transaction(['videos', 'transcripts', 'expressions'], 'readwrite');
          const now = '2026-11-15T09:00:00.000Z';
          const v = (id, yt, title, dur, i) => ({ id, createdAt: now, updatedAt: now, playlistId: null, youtubeVideoId: yt, title, url: null, thumbnailUrl: null, durationSec: dur, orderIndex: i, randomOrderKey: i / 10, status: 'new', completedAt: null, sources: [{ kind: 'manual', addedAt: now }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
          const vs = tx.objectStore('videos');
          vs.add(v('cd-ok', 'aaaaaaaaaaa', '[Day 111] 보통 영상', 295, 0));
          vs.add(v('cd-low', 'mockLow0001', '[Day 112] 전사 부족', 300, 1));
          vs.add(v('cd-fail', 'mockFail001', '[Day 113] AI 실패', 240, 2));
          vs.add(v('cd-over', 'mockOver001', '보너스 영상', 200, 3));
          vs.add(v('cd-has', 'hhhhhhhhhhh', '[Day 115] 자막 있음', 260, 4));
          vs.add(v('cd-long', 'lllllllllll', '긴 강의', 32400, 5));
          tx.objectStore('transcripts').add({ id: 'cd-tr-has', createdAt: now, updatedAt: now, videoId: 'cd-has', source: 'manual_paste', status: 'success', rawText: 'hello', segments: [], format: 'plain' });
          tx.objectStore('expressions').add({ id: 'cd-ex-mine', createdAt: now, updatedAt: now, normalizedKey: 'could use', text: 'could use', meaningKo: '내가 적은 뜻', sourceRefs: [], isFavorite: true, isMarkedDifficult: true });
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );

async function waitFor(page, pred, label, tries = 90) {
  for (let i = 0; i < tries; i++) {
    const d = await dumpDb(page);
    if (pred(d)) return d;
    await page.waitForTimeout(2000);
  }
  console.log(`(시간 초과: ${label})`);
  return dumpDb(page);
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({ ...devices['iPad (gen 7)'] });
    await ctx.route(/^https:\/\/(i\.ytimg\.com|www\.youtube(-nocookie)?\.com)\//, (r) => r.fulfill({ status: 200, body: '' }));
    const reqs = [];
    ctx.on('request', (r) => r.url().endsWith('/api/ai/extract') && reqs.push({ key: r.headers()['idempotency-key'], video: JSON.parse(r.postData() || '{}').videoId, task: JSON.parse(r.postData() || '{}').task ?? 'extract' }));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));

    await page.goto(BASE);
    await page.locator('main').first().waitFor();
    await page.waitForTimeout(600);
    await seed(page);
    const before = await dumpDb(page);

    // ── 1. '기존 영상 자료 만들기 시작' 한 번으로 자동 추출·자동 적용 ──
    await page.goto(`${BASE}/extraction`);
    await page.getByTestId('prep-start-all').click();
    // Gemini 처리 실패(cd-fail)가 나면 대기열이 멈춘다 → '이어서 만들기'를 눌러 나머지 진행
    const done1 = (d) => d.tables.extractionJobs.filter((j) => ['succeeded', 'failed_permanent'].includes(j.status)).length === 4 && d.tables.extractionJobs.some((j) => j.videoId === 'cd-long');
    let continued = 0;
    for (let i = 0; i < 120; i++) {
      if (done1(await dumpDb(page))) break;
      if (await page.getByTestId('prep-continue').count()) {
        continued++;
        await page.getByTestId('prep-continue').click();
      }
      await page.waitForTimeout(2000);
    }
    check('Gemini 처리 실패 → 대기열 멈춤 → 이어서 만들기로 나머지 진행', continued >= 1, `이어서 만들기 ${continued}번`);
    const after1 = await waitFor(page, done1, '1차 추출');
    const jobs = Object.fromEntries(after1.tables.extractionJobs.map((j) => [j.videoId, j]));
    check('시작 한 번으로 4개 영상 자동 처리 (자막 있는 영상·긴 영상 제외)', ['cd-ok', 'cd-low', 'cd-over'].every((v) => jobs[v]?.status === 'succeeded') && jobs['cd-fail']?.status === 'failed_permanent' && !jobs['cd-has'] && jobs['cd-long']?.status === 'skipped');
    const drafts = Object.fromEntries(after1.tables.extractionDrafts.map((d) => [d.videoId, d]));
    check('품질이 괜찮은 결과는 자동으로 학습 자료(사용자 확인 없음)', drafts['cd-ok']?.status === 'approved' && drafts['cd-over']?.status === 'approved');
    check('전사가 부족한 결과는 자동 적용하지 않고 확인 필요', drafts['cd-low']?.status === 'pending_review');
    const tr = Object.fromEntries(after1.tables.transcripts.map((t) => [t.videoId, t]));
    check('AI 자막 추가: 보통 = 사람이 확인하지 않음, 경고 있음 = 확인 권장', tr['cd-ok']?.source === 'ai_transcription' && tr['cd-ok']?.verification === 'ai_unverified' && tr['cd-over']?.verification === 'needs_review' && !tr['cd-low']);
    check('AI 자막에는 영상 길이를 넘는 구간이 없음', tr['cd-over'].segments.every((s) => s.endSec <= 205));
    check('기존 자막은 그대로', same(tr['cd-has'], before.tables.transcripts.find((t) => t.id === 'cd-tr-has')));
    const mine = after1.tables.expressions.find((e) => e.id === 'cd-ex-mine');
    check('같은 표현은 내 표현에 연결만 하고 고치지 않음 (즐겨찾기·뜻 그대로)', same(mine, before.tables.expressions.find((e) => e.id === 'cd-ex-mine')) && after1.tables.learningItems.some((l) => l.expressionId === 'cd-ex-mine' && l.videoId === 'cd-ok'));
    check('학습 대상(핵심 표현·영상 속 Chunk) 기록', after1.tables.learningItems.filter((l) => l.origin === 'ai_extracted').length >= 4);

    // ── 2. AI 자막 관리: 확인 필요 검토 ──
    await page.goto(`${BASE}/extraction`);
    await page.getByTestId('extraction-page').waitFor();
    await page.evaluate(() => document.fonts.ready);
    check('AI 자막 관리: 확인 필요 1개 · 실패 1개 표시', /확인 필요 1개/.test(await page.getByTestId('needs-review').innerText()) && /추출하지 못한 영상 1개/.test(await page.getByTestId('failed-list').innerText()));
    await page.screenshot({ path: `${SHOTS}/sB1cd-01-extraction.png`, fullPage: true });
    await page.getByText('검토하기').click();
    await page.getByTestId('draft-review').waitFor();
    await page.screenshot({ path: `${SHOTS}/sB1cd-02-draft-review.png`, fullPage: true });
    await page.getByLabel(/a cup of coffee/).uncheck();
    await page.getByTestId('draft-apply').click();
    await page.getByTestId('extraction-page').waitFor();
    await page.waitForTimeout(500);
    const after2 = await dumpDb(page);
    const low = after2.tables.extractionDrafts.find((d) => d.videoId === 'cd-low');
    check('확인 필요 초안: Chunk를 빼고 적용 → 일부 적용, 확인 권장 표시', low?.status === 'partially_approved' && after2.tables.transcripts.some((t) => t.videoId === 'cd-low' && t.verification === 'needs_review') && !after2.tables.learningItems.some((l) => l.videoId === 'cd-low' && l.kind === 'intro_chunk'));

    // ── 3. 실패한 영상 모두 다시 추출 (사용자가 누를 때만) ──
    const failKeysBefore = new Set(reqs.filter((r) => r.video === 'mockFail001' && r.task === 'extract').map((r) => r.key));
    await page.getByTestId('retry-all').click();
    const after3 = await waitFor(page, (d) => {
      const j = d.tables.extractionJobs.find((x) => x.videoId === 'cd-fail');
      return j && j.status === 'failed_permanent' && j.attempts >= 2;
    }, '다시 추출');
    const failKeys = new Set(reqs.filter((r) => r.video === 'mockFail001' && r.task === 'extract').map((r) => r.key));
    check('실패 영상 다시 추출: 새 식별자 1개로 한 번 더 요청 (자동 재요청은 없었음)', failKeysBefore.size === 1 && failKeys.size === 2, `식별자 ${failKeysBefore.size} → ${failKeys.size}`);
    check('다른 영상은 다시 요청하지 않음', new Set(reqs.filter((r) => r.video === 'aaaaaaaaaaa' && r.task === 'extract').map((r) => r.key)).size === 1);
    void after3;

    // ── 4. Day 정리 ──
    await page.goto(`${BASE}/days`);
    await page.getByTestId('days-page').waitFor();
    await page.screenshot({ path: `${SHOTS}/sB1cd-03-days.png`, fullPage: true });
    await page.getByTestId('day-confirm-all').click();
    await page.waitForTimeout(600);
    await page.getByLabel('보너스 영상 Day 번호').fill('14');
    await page.getByTestId('day-row-cd-over').getByRole('button', { name: '저장' }).click();
    await page.waitForTimeout(600);
    const after4 = await dumpDb(page);
    const days = Object.fromEntries(after4.tables.dayAssignments.map((d) => [d.videoId, d]));
    check('제안 모두 확정 + 번호 없는 영상 직접 입력', ['cd-ok', 'cd-low', 'cd-fail', 'cd-has'].every((v) => days[v]?.status === 'confirmed') && days['cd-over']?.dayNumber === 14 && days['cd-over']?.status === 'confirmed');
    check('확정하면 그 영상의 학습 대상이 Day로', after4.tables.learningItems.filter((l) => l.videoId === 'cd-ok').every((l) => l.sourceType === 'day' && l.dayNumber === 111));

    // ── 5. 기존 데이터 보존 ──
    const pk = (t, r) => String(t === 'appMeta' ? r.key : r.id);
    const allowed = { videos: ['status', 'updatedAt', 'startedAt'], appMeta: null };
    let changed = [];
    for (const t of ['playlists', 'videos', 'transcripts', 'expressionNotes', 'keySentences', 'dialogues', 'dialogueCompositions', 'expressions', 'reviewStates', 'dialogueProgress', 'studyLogs', 'appMeta']) {
      const a = new Map(after4.tables[t].map((r) => [pk(t, r), r]));
      for (const r of before.tables[t]) {
        const x = a.get(pk(t, r));
        if (!x) changed.push(`${t}:${pk(t, r)} 사라짐`);
        else if (!same(x, r)) {
          if (t === 'appMeta' && ['studyQueue'].includes(r.key)) continue; // 학습 시작이 원래 바꾸는 학습 순서
          if (t === 'videos') {
            const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !allowed.videos.includes(k)));
            if (same(strip(x), strip(r))) continue;
          }
          changed.push(`${t}:${pk(t, r)}`);
        }
      }
    }
    check('기존 레코드는 하나도 바뀌거나 사라지지 않음 (학습 시작이 원래 바꾸는 값 제외)', changed.length === 0, changed.slice(0, 5).join(', '));
    const addedT = after4.tables.transcripts.length - before.tables.transcripts.length;
    check('추가된 것은 AI 자막·표현·새 테이블 기록뿐', addedT === 3 && after4.tables.transcripts.filter((t) => t.source === 'ai_transcription').length === 3);

    // 화면 폭
    for (const path of ['/extraction', '/days']) {
      for (const vp of [{ width: 390, height: 844 }, { width: 810, height: 1080 }]) {
        await page.setViewportSize(vp);
        await page.goto(`${BASE}${path}`);
        await page.waitForTimeout(400);
        check(`${path} ${vp.width}px: 가로 넘침 없음`, await fits(page));
      }
    }
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
