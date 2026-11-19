/**
 * 자막 단계 실패 뒤 자막 직접 입력 E2E (Playwright, 새 임시 프로필, 가짜 YouTube·가짜 Gemini — 실제 Google 호출 없음)
 * 사용법: npm run build && node scripts/e2e-manual-transcript.mjs
 *
 * - AI 자막 생성이 실패하면 실패 카드에 Gemini 상세(상태·오류 코드·경과 시간)가 함께 보인다
 * - 자막을 직접 넣어 저장하면: 지난 자막 실패로 막히지 않고 '이 영상 자료 만들기' 버튼이 나온다
 * - 버튼을 누르기 전에는 (앱을 다시 열어도, '전체 시작' 상태여도) AI 요청이 나가지 않는다
 * - 버튼을 누르면 그때 다음 단계(문장·Chunk) 요청이 1번 나간다
 * - 기존 학습 데이터·DB 버전은 그대로
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
const PORT = 4207;
const BASE = `http://localhost:${PORT}`;

function startServer() {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'pipe',
    env: { ...process.env, YOUTUBE_API_KEY: '', YOUTUBE_API_MOCK: '1', AI_GEMINI_MOCK: '1', GEMINI_API_KEY: '', YOUTUBE_QUOTA_FILE: join(tmpdir(), `mes-e2e-manual-quota-${process.pid}.json`) },
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

const seed = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('my-english-study');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['videos', 'dialogues', 'dialogueProgress', 'reviewStates'], 'readwrite');
          const now = '2026-11-19T01:00:00.000Z';
          tx.objectStore('videos').add({ id: 'nf', createdAt: now, updatedAt: now, playlistId: null, youtubeVideoId: 'mockFail002', title: 'why you want to do everything (자막 실패 영상)', url: null, thumbnailUrl: null, durationSec: 964, orderIndex: 0, randomOrderKey: 0.1, status: 'in_progress', completedAt: null, sources: [{ kind: 'manual', addedAt: now }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
          // 기존 학습 기록 (그대로 남아야 함)
          tx.objectStore('dialogues').add({ id: 'dlg-user-1', createdAt: now, updatedAt: now, kind: 'original', videoId: null, sourceVideoIds: [], orderInVideo: 1, title: '기존 대화문', situation: '기존', lines: [], expressionIds: [], generatedBy: 'manual', isFavorite: true });
          tx.objectStore('dialogueProgress').add({ id: 'dlg-user-1', dialogueId: 'dlg-user-1', currentStep: 5, highestCompletedStep: 5, stepResults: [], memorized: true, memorizedAt: now, blankMastery: {}, updatedAt: now });
          tx.objectStore('reviewStates').add({ id: 'dialogue:dlg-user-1', createdAt: now, updatedAt: now, itemType: 'dialogue', itemId: 'dlg-user-1', intervalIndex: 2, reviewCount: 2, correctCount: 2, streak: 2, lastResult: 'easy', lastStudiedAt: now, nextReviewAt: '2026-11-22T01:00:00.000Z' });
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
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

const TRANSCRIPT = ['0:00 Hey guys, welcome back to my channel.', '0:05 I could really use a long vacation this year.', '0:10 Let me know what you think in the comments.'].join('\n');

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  const sends = [];
  try {
    const ctx = await browser.newContext({ ...devices['iPad (gen 7)'] });
    await ctx.route(/^https:\/\/(i\.ytimg\.com|www\.youtube(-nocookie)?\.com)\//, (r) => r.fulfill({ status: 200, body: '' }));
    ctx.on('response', async (r) => {
      if (!r.url().endsWith('/api/ai/extract')) return;
      const b = JSON.parse(r.request().postData() || '{}');
      sends.push({ task: b.task ?? 'extract', videoId: b.videoId, retry: !!b.retryFailed, status: r.status(), state: (await r.json().catch(() => ({}))).state });
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));

    await page.goto(BASE);
    await page.locator('main').first().waitFor();
    await page.waitForTimeout(600);
    await seed(page);
    const before = await dumpDb(page);

    // ── 1. AI 자막 생성 실패 (가짜 Gemini) ──
    await page.goto(`${BASE}/extraction`);
    await page.getByTestId('prep-start-all').click();
    const failedShown = await waitFor(async () => sends.some((s) => s.task === 'extract' && s.state === 'failed'), 120, 500);
    check('기존 영상 자료 만들기 시작 → AI 자막 생성이 실패 (가짜 Gemini)', failedShown, sends.map((s) => `${s.task}:${s.state}`).join(','));
    await page.goto(`${BASE}/videos/nf?tab=transcript`);
    await page.getByTestId('video-prep-error').waitFor();
    const errText = (await page.getByTestId('video-prep-error').innerText()).replace(/\s+/g, ' ');
    check('실패 카드에 Gemini 상세: 상태 · 오류 코드 · 생성 후 경과', /자막 단계 실패/.test(errText) && /HTTP 502/.test(errText) && /\[Gemini 상태 failed · 오류 INTERNAL\/13 · 생성 후 \d+초/.test(errText), errText.slice(0, 160));
    await page.screenshot({ path: `${SHOTS}/manual-01-failed.png`, fullPage: true });

    // ── 2. 자막 직접 입력 → 버튼 대기 (자동 요청 없음) ──
    const n0 = sends.length;
    await page.getByLabel('자막 붙여넣기').fill(TRANSCRIPT);
    await page.getByRole('button', { name: '자막 저장' }).click();
    await page.getByTestId('video-prep-enqueue').waitFor({ timeout: 10000 }).catch(() => {});
    check('자막 저장 뒤: 지난 자막 실패 표시가 사라짐', (await page.getByTestId('video-prep-error').count()) === 0);
    check('자막 저장 뒤: ‘이 영상 자료 만들기’ 버튼과 안내 (AI 요청 1회 표시)', (await page.getByTestId('video-prep-enqueue').count()) === 1 && /AI 요청 1회/.test(await page.getByTestId('video-prep-ready-hint').innerText()));
    await page.waitForTimeout(4000);
    check('버튼을 누르기 전에는 AI 요청 없음', sends.length === n0, sends.slice(n0).map((s) => s.task).join(','));
    await page.screenshot({ path: `${SHOTS}/manual-02-ready.png`, fullPage: true });

    // 앱을 다시 열어도('전체 시작' 상태) 자동으로 시작하지 않음
    await page.reload();
    await page.getByTestId('video-prep-enqueue').waitFor({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(4000);
    check('앱을 다시 열어도 자동 요청 없음 (전체 시작 상태여도)', sends.length === n0 && (await page.getByTestId('video-prep-enqueue').count()) === 1);
    await page.goto(`${BASE}/extraction`);
    await page.waitForTimeout(1500);
    const retryAll = page.getByTestId('prep-retry-all');
    if (await retryAll.count()) await retryAll.click();
    await page.waitForTimeout(3000);
    check('‘실패만 다시 시도’가 이 영상을 다시 보내지 않음 (실패 목록에서 빠짐)', sends.length === n0 && (await retryAll.count()) === 0, `${sends.length - n0}건`);

    // ── 3. 버튼을 누르면 그때 다음 단계 요청 ──
    await page.goto(`${BASE}/videos/nf?tab=transcript`);
    await page.getByTestId('video-prep-enqueue').click();
    await waitFor(async () => sends.slice(n0).some((s) => s.task === 'pack' && s.state && s.state !== 'pending'), 120, 500);
    const after3 = sends.slice(n0);
    check('버튼을 누르면 문장·Chunk 단계 요청 (자막 생성은 다시 하지 않음)', after3.length > 0 && after3.every((s) => s.task === 'pack') && !after3[0].retry, after3.map((s) => `${s.task}:${s.state}`).join(','));
    await page.getByTestId('video-prep-error').waitFor({ timeout: 15000 }).catch(() => {});
    const err2 = (await page.getByTestId('video-prep-error').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check('새 단계의 실패는 그대로 실패로 표시 (가짜 Gemini가 이 영상은 실패시킴)', /문장·Chunk/.test(err2) && /\[Gemini 상태 failed/.test(err2), err2.slice(0, 120));

    // ── 4. 보존 ──
    const after = await dumpDb(page);
    for (const t of ['dialogues', 'dialogueProgress', 'reviewStates', 'videos']) check(`기존 ${t} 그대로`, same(before.tables[t], after.tables[t]));
    const tr = after.tables.transcripts.find((x) => x.videoId === 'nf');
    check('직접 넣은 자막 저장됨', !!tr && tr.status === 'success' && tr.segments.length === 3);
    check('학습 DB 버전 30 그대로', before.version === 30 && after.version === 30, String(after.version));

    // ── 휴대폰 화면 ──
    const phone = await browser.newContext({ ...devices['iPhone 13'] });
    const p2 = await phone.newPage();
    await p2.goto(`${BASE}/videos/nf`);
    await p2.waitForTimeout(1000);
    check('휴대폰: 화면 가로 넘침 없음', await p2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await phone.close();

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
