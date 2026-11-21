/**
 * Gemini 한도·간격 관리 E2E (Playwright, 새 임시 프로필, 가짜 YouTube·가짜 Gemini — 실제 Google 호출 없음)
 * 사용법: npm run build && node scripts/e2e-limits.mjs
 *
 * 운영과 같은 상한(하루 16회, 자동 준비 6회)으로 확인한다. 요청 간격은 가짜 Gemini의 처리 시간(약 20초)보다 길게 25초로 둔다(운영 15초) — 간격 대기가 실제로 일어나게.
 * - 자동 준비는 실제 요청 6회까지 → 자동 영상만 멈춤, 사용량 표시
 * - 자동 몫을 다 쓴 영상은 '지금 만들기'(사용자 작업)로 바로 진행
 * - 생성 요청 사이 간격을 지킴 (그동안은 Gemini를 부르지 않고 기다림)
 * - 작업이 한도 초과(RESOURCE_EXHAUSTED)로 끝나면: 보류 + 그날 모든 요청 차단(Gemini 호출 없음)
 * - 기존 학습 데이터·DB 버전 그대로
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
const PORT = 4208;
const BASE = `http://localhost:${PORT}`;
const GAP_SEC = 25;

function startServer() {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'pipe',
    env: { ...process.env, YOUTUBE_API_KEY: '', YOUTUBE_API_MOCK: '1', AI_GEMINI_MOCK: '1', GEMINI_API_KEY: '', AI_MIN_GAP_SEC: String(GAP_SEC), YOUTUBE_QUOTA_FILE: join(tmpdir(), `mes-e2e-limits-quota-${process.pid}.json`) },
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

// 일반 영상 Day 101~108 (Day 1~100 밖 — 2단계부터 Day 1~100은 자동 준비 대상이 아님): 자막 있음. Day 109: 가짜 Gemini가 한도 초과로 끝내는 영상
const VIDEOS = [...Array.from({ length: 8 }, (_, i) => ({ id: `d${i + 1}`, yt: `limitVid00${i + 1}`, title: `[Day ${101 + i}] 한도 시험 ${i + 1}` })), { id: 'q9', yt: 'mockExhaus1', title: '[Day 109] 한도 초과 영상' }];

const seed = (page, videos) =>
  page.evaluate(
    (videos) =>
      new Promise((resolve, reject) => {
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
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
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
      const j = await r.json().catch(() => ({}));
      sends.push({ at: Date.now(), task: b.task ?? 'extract', videoId: b.videoId, key: r.request().headers()['idempotency-key'], origin: b.origin ?? null, status: r.status(), state: j.state, code: j.code, interactionId: j.interactionId ?? null, retryAfterSec: j.retryAfterSec });
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));

    await page.goto(BASE);
    await page.locator('main').first().waitFor();
    await page.waitForTimeout(600);
    await seed(page, VIDEOS);
    const before = await dumpDb(page);

    // ── 1. 자동 준비: 실제 요청 6회까지 ──
    await page.goto(`${BASE}/extraction`);
    await page.getByTestId('prep-start-all').click();
    const autoPaused = await waitFor(async () => /auto_cap/.test((await page.getByTestId('prep-paused').innerText().catch(() => '')) || ''), 600, 500);
    const created = sends.filter((s) => s.state === 'pending' && s.interactionId);
    const createdIds = [...new Set(created.map((s) => s.videoId))];
    check('자동 준비는 실제 Gemini 요청 6회까지 (Day 1~6), 그다음 자동 영상만 멈춤', autoPaused && createdIds.join(',') === 'limitVid001,limitVid002,limitVid003,limitVid004,limitVid005,limitVid006', createdIds.join(','));
    check('자동 준비 요청에는 자동 표시(origin: auto)', created.every((s) => s.origin === 'auto'), [...new Set(created.map((s) => s.origin))].join(','));
    const firstCreateAt = createdIds.map((v) => sends.find((s) => s.videoId === v && s.state === 'pending' && s.interactionId).at);
    const gaps = firstCreateAt.slice(1).map((t, i) => t - firstCreateAt[i]);
    check(`생성 요청 사이 간격 지킴 (설정 ${GAP_SEC}초)`, gaps.every((g) => g >= GAP_SEC * 1000 - 500), gaps.map((g) => `${(g / 1000).toFixed(1)}초`).join(', '));
    check('간격을 기다리는 동안은 Gemini를 부르지 않고 잠시 뒤로 응답', sends.some((s) => s.state === 'pending' && s.interactionId === null && s.retryAfterSec > 0));
    await page.reload();
    await page.getByTestId('prep-usage').waitFor({ timeout: 15000 }).catch(() => {});
    const usage1 = (await page.getByTestId('prep-usage').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check('사용량 표시: 전체 6/16 · 자동 준비 6/6 · 초기화 시각', /요청 6\/16회/.test(usage1) && /자동 준비 6\/6회/.test(usage1) && /초기화/.test(usage1), usage1);
    await page.screenshot({ path: `${SHOTS}/limits-01-auto-cap.png`, fullPage: true });

    // ── 2. 사용자가 누른 작업은 계속 ──
    await page.goto(`${BASE}/videos/d7`);
    await page.getByTestId('video-prep-auto-wait').waitFor({ timeout: 15000 }).catch(() => {});
    check('자동 몫을 다 쓴 영상: 기다림 안내 + ‘지금 만들기’ 버튼', (await page.getByTestId('video-prep-now').count()) === 1 && /자동 준비 몫/.test(await page.getByTestId('video-prep-auto-wait').innerText().catch(() => '')));
    const nD7 = sends.length;
    const d7auto = sends.filter((s) => s.videoId === 'limitVid007');
    check('자동 몫을 넘은 자동 요청은 Gemini 호출 없이 auto_cap (HTTP 429)', d7auto.length > 0 && d7auto.every((s) => s.code === 'auto_cap' && s.status === 429 && !s.interactionId), d7auto.map((s) => `${s.status}:${s.code}`).join(','));
    await page.getByTestId('video-prep-now').click();
    const d7done = await waitFor(async () => (await page.getByTestId('video-prep').count()) === 0 || /자료 준비됨/.test(await page.getByTestId('video-prep').innerText().catch(() => '')), 120, 500);
    const d7 = sends.slice(nD7).filter((s) => s.videoId === 'limitVid007');
    check('‘지금 만들기’(사용자 작업)는 자동 몫과 상관없이 진행', d7done && d7.some((s) => s.state === 'succeeded') && d7.every((s) => s.origin === 'user'), d7.map((s) => `${s.state}:${s.origin}`).join(','));
    check('자동 영상(Day 8)은 그대로 대기 (보내지 않음)', !sends.some((s) => s.videoId === 'limitVid008'));

    // ── 3. 작업이 한도 초과로 끝남 → 보류 + 모든 요청 차단 ──
    await page.goto(`${BASE}/videos/q9`);
    await page.getByTestId('video-prep-now').click();
    const quotaSeen = await waitFor(async () => sends.some((s) => s.videoId === 'mockExhaus1' && s.code === 'gemini_quota'), 120, 500);
    check('작업이 RESOURCE_EXHAUSTED로 끝나면 gemini_quota (HTTP 429)', quotaSeen && sends.some((s) => s.videoId === 'mockExhaus1' && s.status === 429));
    await page.goto(`${BASE}/extraction`);
    await page.getByTestId('prep-paused').waitFor({ timeout: 15000 }).catch(() => {});
    const paused = (await page.getByTestId('prep-paused').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const usage2 = (await page.getByTestId('prep-usage').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check('대기열 멈춤(초기화 시각까지) + 사용량 16/16 (남은 0회)', /gemini_quota/.test(paused) && /요청 16\/16회/.test(usage2) && /남은 0회/.test(usage2), `${paused.slice(0, 80)} | ${usage2}`);
    const counts = await page.getByTestId('prep-counts').innerText();
    check('한도 초과 영상은 보류(실패로 표시하지 않음)', /실패 0/.test(counts), counts);
    // 차단 중에는 다른 작업을 눌러도 초기화 시각까지 요청 자체를 보내지 않음
    const n0 = sends.length;
    await page.goto(`${BASE}/videos/d8`);
    await page.getByTestId('video-prep-now').click();
    await page.waitForTimeout(8000);
    check('차단 중 다른 작업을 눌러도 요청을 보내지 않음 (초기화 시각까지)', sends.slice(n0).length === 0, `${sends.slice(n0).length}건`);
    // 다른 기기·다른 경로로 보내도 서버가 Gemini 호출 없이 daily_cap
    const direct = await page.evaluate(async () => {
      const r = await fetch('/api/ai/extract', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ videoId: 'otherDevice', durationSec: 60, promptVersion: 'v1' }) });
      return { status: r.status, body: await r.json() };
    });
    check('다른 기기에서 보내도 서버가 Gemini 호출 없이 daily_cap', direct.status === 429 && direct.body.code === 'daily_cap', `${direct.status}:${direct.body.code}`);
    await page.screenshot({ path: `${SHOTS}/limits-02-quota.png`, fullPage: true });

    // ── 4. 보존 ──
    const after = await dumpDb(page);
    for (const t of ['dialogueProgress', 'reviewStates', 'transcripts', 'videos']) check(`기존 ${t} 그대로`, same(before.tables[t], after.tables[t]));
    check('기존 대화문 그대로 (새 자료만 추가)', same(before.tables.dialogues.find((d) => d.id === 'dlg-user-1'), after.tables.dialogues.find((d) => d.id === 'dlg-user-1')) && after.tables.dialogues.length >= before.tables.dialogues.length);
    check('학습 DB 버전 30 그대로', before.version === 30 && after.version === 30, String(after.version));

    const phone = await browser.newContext({ ...devices['iPhone 13'] });
    const p2 = await phone.newPage();
    await p2.goto(`${BASE}/extraction`);
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
