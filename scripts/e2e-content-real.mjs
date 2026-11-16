/**
 * 실제 Gemini로 원문 문장·Chunk 1회 + 통합 대화문 1회 검증 (텍스트만 보냄, 영상은 보내지 않음)
 * 사용법: npm run build && node scripts/e2e-content-real.mjs <Day 11 자막 JSON 경로> <결과 저장 폴더>
 *
 * - 새 임시 프로필(사용자 기기 데이터와 무관). Day 11 실제 자막으로 문장·Chunk를 만든다 (실제 요청 1회)
 * - Day 12·13은 테스트용으로 넣은 Chunk(이미 배운 것으로 표시) — 여러 Day 조합 대화문을 실제로 만든다 (실제 요청 1회)
 * - 키는 서버 쪽(프록시)에만 있고 브라우저·로그·결과 파일에 나오지 않는다
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const [, , transcriptPath, outDir] = process.argv;
mkdirSync(outDir, { recursive: true });
const day11 = JSON.parse(readFileSync(transcriptPath, 'utf8')).transcript;
const PORT = 4197;
const BASE = `http://localhost:${PORT}`;

function startServer() {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'pipe',
    env: { ...process.env, YOUTUBE_API_KEY: '', YOUTUBE_API_MOCK: '', AI_GEMINI_MOCK: '', GEMINI_API_KEY: 'proxy-injected', NODE_USE_ENV_PROXY: '1' },
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

const dump = (page, table) =>
  page.evaluate(
    (t) =>
      new Promise((resolve) => {
        const r = indexedDB.open('my-english-study');
        r.onsuccess = () => {
          const db = r.result;
          const q = db.transaction(t).objectStore(t).getAll();
          q.onsuccess = () => {
            db.close();
            resolve(q.result);
          };
        };
      }),
    table,
  );

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  const calls = [];
  try {
    const ctx = await browser.newContext({ ...devices['iPad (gen 7)'] });
    await ctx.route(/^https:\/\/(i\.ytimg\.com|www\.youtube(-nocookie)?\.com)\//, (r) => r.fulfill({ status: 200, body: '' }));
    ctx.on('response', async (r) => {
      if (!r.url().endsWith('/api/ai/extract')) return;
      calls.push({ task: JSON.parse(r.request().postData() || '{}').task, key: r.request().headers()['idempotency-key'], status: r.status(), state: (await r.json().catch(() => ({}))).state });
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
    await page.goto(BASE);
    await page.locator('main').first().waitFor();
    await page.waitForTimeout(600);
    await page.evaluate(
      (lines) =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open('my-english-study');
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(['videos', 'transcripts', 'keySentences', 'expressions', 'learningItems'], 'readwrite');
            const now = new Date().toISOString();
            const v = (id, yt, title, status, startedAt) => ({ id, createdAt: now, updatedAt: now, playlistId: null, youtubeVideoId: yt, title, url: null, thumbnailUrl: null, durationSec: 295, orderIndex: 0, randomOrderKey: 0, status, completedAt: null, startedAt, sources: [{ kind: 'manual', addedAt: now }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
            tx.objectStore('videos').add(v('r11', 'eNODHkrNuDA', '[Day 11] 필요해 I need 말고', 'in_progress', '2026-11-16T08:00:00.000Z'));
            tx.objectStore('videos').add(v('t12', 'bbbbbbbbbbb', '[Day 12] 테스트', 'completed', '2026-11-14T08:00:00.000Z'));
            tx.objectStore('videos').add(v('t13', 'ccccccccccc', '[Day 13] 테스트', 'completed', '2026-11-15T08:00:00.000Z'));
            tx.objectStore('transcripts').add({ id: 'tr-r11', createdAt: now, updatedAt: now, videoId: 'r11', source: 'ai_transcription', status: 'success', rawText: '', segments: lines.map((s) => ({ startSec: s.start, endSec: s.end, text: s.text })), format: 'timestamped' });
            // 테스트용: Day 12·13에서 이미 배운 Chunk
            const fx = [
              ['t12', 12, 'ex-t12', 'sounds like a plan', '좋은 생각이야', 'Sounds like a plan.'],
              ['t13', 13, 'ex-t13', 'get back to', '~로 돌아가다, 다시 연락하다', "I'll get back to you on that."],
            ];
            for (const [vid, day, ex, text, ko, sent] of fx) {
              tx.objectStore('keySentences').add({ id: `ks-${vid}`, createdAt: now, updatedAt: now, videoId: vid, order: 1, english: sent, korean: ko, expressionIds: [ex], situation: '', timestampSec: null, status: 'learning', correctCount: 0, wrongCount: 0, origin: 'ai_extracted', aiNumber: 1, selected: true });
              tx.objectStore('expressions').add({ id: ex, createdAt: now, updatedAt: now, normalizedKey: text, text, meaningKo: ko, sourceRefs: [{ videoId: vid }], isFavorite: false, isMarkedDifficult: false, origin: 'ai_extracted' });
              tx.objectStore('learningItems').add({ id: `li-${vid}`, createdAt: now, updatedAt: now, expressionId: ex, videoId: vid, sourceType: 'day', dayNumber: day, kind: 'chunk', dialogueId: null, sourceText: sent, timestampSec: null, onScreen: false, origin: 'ai_extracted', status: 'confirmed', extractionDraftId: null, legacyKeySentenceId: null, sentenceId: `ks-${vid}`, selected: true });
            }
            tx.oncomplete = () => {
              db.close();
              resolve(true);
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
      day11,
    );

    // ① 원문 문장·Chunk (실제 1회)
    await page.goto(`${BASE}/videos/r11?tab=sentences`);
    await page.getByTestId('content-start').click();
    let phase = null;
    for (let i = 0; i < 200 && !['succeeded', 'failed', 'already'].includes(phase); i++) {
      await page.waitForTimeout(1500);
      phase = await page.getByTestId('content-status').getAttribute('data-phase');
    }
    const st = await page.getByTestId('content-status').innerText();
    check('실제 Gemini: Day 11 원문 문장·Chunk 저장', phase === 'succeeded', st.replace(/\n/g, ' / '));
    const ks = (await dump(page, 'keySentences')).filter((s) => s.videoId === 'r11').sort((a, b) => a.order - b.order);
    const items = (await dump(page, 'learningItems')).filter((i) => i.videoId === 'r11');
    const exprs = Object.fromEntries((await dump(page, 'expressions')).map((e) => [e.id, e]));
    check('번호별 원문 문장 저장', ks.length > 0 && ks.every((s) => s.aiNumber > 0), ks.map((s) => `${s.aiNumber}. ${s.english}`).join(' | '));
    check('문장 속 Chunk 저장 (문장과 연결)', items.length > 0 && items.every((i) => ks.some((s) => s.id === i.sentenceId)), items.map((i) => exprs[i.expressionId]?.text).join(', '));
    await page.screenshot({ path: `${outDir}/real-01-content.png`, fullPage: true });
    // 화면에서 Day 11 Chunk 두 개를 '암기할 Chunk'로 고름
    const toggles = page.getByTestId('select-chunk');
    for (let i = 0; i < Math.min(2, await toggles.count()); i++) await toggles.nth(i).click();
    await page.waitForTimeout(500);

    // ② 통합 대화문 (실제 1회)
    await page.goto(`${BASE}/dialogues/combine`);
    await page.getByTestId('combine-page').waitFor();
    const summary = await page.getByTestId('combine-summary').innerText();
    check('기본 추천 Day 11·12·13, 학습함·고름인 Chunk 미리 체크', /Day\/영상 3곳/.test(summary), summary);
    await page.getByTestId('combine-generate').click();
    let url = page.url();
    for (let i = 0; i < 200 && !/\/dialogues\/dlg-ai-/.test(url); i++) {
      await page.waitForTimeout(1500);
      url = page.url();
      const err = page.getByTestId('combine-error');
      if (await err.count()) break;
    }
    const ok = /\/dialogues\/dlg-ai-/.test(url);
    check('실제 Gemini: 통합 대화문 생성·저장 후 상세로 이동', ok, ok ? '' : await page.getByTestId('combine-status').innerText().catch(() => ''));
    if (ok) {
      await page.getByTestId('chunk-usages').waitFor();
      await page.screenshot({ path: `${outDir}/real-02-dialogue.png`, fullPage: true });
      const d = (await dump(page, 'dialogues')).find((x) => x.id.startsWith('dlg-ai-'));
      check('사용 Chunk id·출처 Day 기록', d.chunkUsages.length >= 2 && d.sourceDays.length >= 2, `Day ${d.sourceDays.join(', ')} · Chunk ${d.chunkUsages.map((u) => `${u.usedAs}(Day ${u.dayNumber})`).join(', ')}`);
      check('모든 줄에 한국어 번역, Chunk별 의미·뉘앙스', d.lines.every((l) => l.korean) && d.chunkUsages.every((u) => u.meaningInContext && u.nuance));
      writeFileSync(`${outDir}/real-dialogue.json`, JSON.stringify(d, null, 2));
    }
    writeFileSync(`${outDir}/real-content.json`, JSON.stringify({ sentences: ks.map((s) => ({ number: s.aiNumber, english: s.english, korean: s.korean, timestampSec: s.timestampSec })), chunks: items.map((i) => ({ text: exprs[i.expressionId]?.text, meaningKo: exprs[i.expressionId]?.meaningKo, sentence: i.sourceText, ...i.chunk })) }, null, 2));
    const keys = (t) => new Set(calls.filter((c) => c.task === t).map((c) => c.key)).size;
    check('실제 생성 요청: 문장·Chunk 식별자 1개 + 대화문 식별자 1개', keys('content') === 1 && keys('dialogue') === 1, `요청 ${calls.length}번(결과 조회 포함)`);
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
