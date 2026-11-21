import { describe, expect, it } from 'vitest';
import type { StudyDatabase } from '@/db/database';
import { createContentStore } from '@/repositories/contentStore';
import { createExtractionStore } from '@/repositories/extractionStore';
import { createTestRepos } from '@/test/helpers';
import type { AiClient, AiTransportResult } from '@/services/integrations/aiClient';
import type { AiDayPackRequest, AiTaskRequest } from '@/types/aiApi';
import type { KeySentence } from '@/types/models';
import { DEFAULT_AI_CAPS, handleAiExtract, isDayManualOnly, type AiCaps } from '../../../server/ai/extractHandler';
import { memoryLedgerStore } from '../../../server/ai/ledger';
import { createMockGemini } from '../../../server/ai/mockGemini';
import { createPrepController } from './prepController';
import { addKeySentence, getRemovalBlocker } from '@/services/keySentenceService';

/**
 * 2단계 — Day 1~100 영상
 * - 자동 준비(등록·전체 시작·앱 재실행)로는 AI 요청을 보내지 않는다
 * - 'Day 자료 만들기'를 눌렀을 때만, 사용자가 입력하거나 자막에서 고른 문장만 보낸다 (AI 문장·자막·힌트 없음)
 * - 기존 자료·문장은 고치거나 지우지 않는다
 */

const T = '2026-11-16T12:00:00.000Z';
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function server(caps: AiCaps = { ...DEFAULT_AI_CAPS, minGapMs: 0 }, clock = () => Date.parse(T)) {
  const gemini = createMockGemini();
  const ledger = memoryLedgerStore();
  const sent: { key: string; body: AiTaskRequest & { origin?: string; retryFailed?: boolean } }[] = [];
  let before: ((body: AiTaskRequest) => Promise<void>) | null = null;
  const client: AiClient = {
    async extract(key, body): Promise<AiTransportResult> {
      sent.push({ key, body: body as never });
      if (before) await before(body);
      const r = await handleAiExtract({ idempotencyKey: key, body }, { store: ledger, gemini, caps, now: clock });
      return { kind: 'response', httpStatus: r.status, body: r.body };
    },
  };
  return { client, gemini, sent, ledger, onSend: (fn: (body: AiTaskRequest) => Promise<void>) => (before = fn) };
}

function device(db: StudyDatabase, client: AiClient, now = () => new Date(T)) {
  return createPrepController({
    store: createContentStore(db), extraction: createExtractionStore(db), client, now, newId: uuid,
    sleep: async () => {}, pollMs: 1, extractPollMs: 1, withLock: async (fn) => (await fn(), true),
  });
}

async function seedVideo(db: StudyDatabase, id: string, yt: string, title: string, opts: { transcript?: string[]; order?: number } = {}) {
  await db.videos.add({ id, createdAt: T, updatedAt: T, playlistId: null, youtubeVideoId: yt, title, url: null, thumbnailUrl: null, durationSec: 300, orderIndex: opts.order ?? 0, randomOrderKey: 0.1, status: 'new', completedAt: null, sources: [{ kind: 'manual', addedAt: T }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
  if (opts.transcript) await db.transcripts.add({ id: `tr-${id}`, createdAt: T, updatedAt: T, videoId: id, source: 'manual_paste', status: 'success', rawText: opts.transcript.join('\n'), segments: opts.transcript.map((text, i) => ({ startSec: i * 10, endSec: i * 10 + 9, text })), format: 'timestamped' });
}

async function addSentence(db: StudyDatabase, id: string, videoId: string, order: number, english: string, origin: KeySentence['origin'], extra: Partial<KeySentence> = {}) {
  const s: KeySentence = { id, createdAt: T, updatedAt: T, videoId, order, english, korean: `${english}의 뜻`, expressionIds: [], situation: '', timestampSec: null, status: 'not_started', correctCount: 0, wrongCount: 0, origin, ...extra };
  await db.keySentences.add(s);
  return s;
}

const TRANSCRIPT = ['Welcome to Day 7.', 'Today we learn could use.', '1. I could use a break.', '2. You could use some rest.'];

/** Day 7: 자막 + 예전 AI 추출 문장 2개 + 사용자 문장 3개(직접 입력 2, 자막에서 고름 1) + 자막 분석 힌트 */
async function seedDay7(db: StudyDatabase, yt = 'daySeven007') {
  await seedVideo(db, 'd7', yt, '[Day 7] could use', { transcript: TRANSCRIPT });
  const ai = [await addSentence(db, 'ai1', 'd7', 101, 'I could use a break.', 'ai_extracted', { aiNumber: 1 }), await addSentence(db, 'ai2', 'd7', 102, 'You could use some rest.', 'ai_extracted', { aiNumber: 2 })];
  const mine = [
    await addSentence(db, 'u2', 'd7', 2, 'We could really use some help here.', 'manual'),
    await addSentence(db, 'u1', 'd7', 1, 'I could use a cup of coffee.', 'transcript'),
    await addSentence(db, 'u3', 'd7', 3, 'That sounds like a plan.', 'manual'),
  ];
  await db.expressions.add({ id: 'ex-hint', createdAt: T, updatedAt: T, normalizedKey: 'could use', text: 'could use', meaningKo: '힌트', sourceRefs: [], isFavorite: false, isMarkedDifficult: false });
  await db.learningItems.add({ id: 'li-hint', createdAt: T, updatedAt: T, expressionId: 'ex-hint', videoId: 'd7', sourceType: 'day', dayNumber: 7, kind: 'key', dialogueId: null, sourceText: null, timestampSec: null, onScreen: false, origin: 'ai_extracted', status: 'confirmed', extractionDraftId: null, legacyKeySentenceId: null } as never);
  return { ai, mine };
}

describe('Day 1~100: 자동 준비에서 빠진다', () => {
  it('등록·전체 시작·앱 재실행 모두 Day 영상은 요청하지 않고, 일반 영상(Day 101 포함)만 자동 준비', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'd3', 'dayThree003', '[Day 3] a', { transcript: ['1. I could use a break.'] });
    await seedVideo(db, 'd5', 'dayFive0005', '[Day 5] no transcript');
    await seedVideo(db, 'g1', 'general0001', '[Day 101] general', { transcript: ['1. I could use a break.'] });
    await seedVideo(db, 'g2', 'general0002', 'Small talk', { transcript: ['1. That sounds like a plan.'] });
    const { client, gemini } = server();
    const pc = device(db, client);
    await pc.enqueue(['d3', 'd5', 'g1']); // 새로 등록
    await pc.startAll(); // 기존 영상 자료 만들기 시작
    await pc.start();
    await device(db, client).resume(); // 앱 재실행
    await pc.start();
    expect(gemini.createCalls.sort()).toEqual(['pack:general0001', 'pack:general0002']);
    const rows = pc.getSnapshot().rows;
    expect(rows.find((r) => r.video.id === 'd3')).toMatchObject({ series: 'day', dayNumber: 3, stage: 'dayuser', status: 'not_queued', daySentences: 0 });
    expect(rows.find((r) => r.video.id === 'g1')).toMatchObject({ series: 'general', status: 'ready' });
    // 집계: 자동 준비는 일반 영상만, Day는 따로
    expect(pc.getSnapshot().summary).toMatchObject({ total: 2, ready: 2, day: { total: 2, done: 0, noSentences: 2, canMake: 0, queued: 0, failed: 0 } });
    // Day 영상은 자막 작업도 만들지 않는다
    expect(await db.extractionJobs.count()).toBe(0);
  });

  it('예전 대기열 항목·실패 기록은 지우지 않고 건너뛴다 (Day 행에는 예전 방식 실패를 보여 주지 않음)', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'd8', 'dayEight008', '[Day 8] old queue', { transcript: ['1. I could use a break.'] });
    const store = createContentStore(db);
    const oldFailure = { status: 'failed' as const, stage: 'pack' as const, error: { code: 'gemini_failed', message: '예전 실패', httpStatus: 502 }, attempts: 1, updatedAt: T };
    await store.updatePrep((s) => ({ ...s, queue: ['d8'], retry: ['d8'], videos: { d8: oldFailure } }));
    const { client, gemini } = server();
    const pc = device(db, client);
    await pc.resume();
    await pc.start();
    await pc.retryFailed(); // '실패만 다시 시도'(전체)에도 Day는 들어가지 않음
    await pc.start();
    expect(gemini.createCalls).toEqual([]);
    const st = await store.getPrep();
    expect(st.queue).toEqual(['d8']);
    expect(st.videos.d8).toEqual(oldFailure);
    expect(pc.getSnapshot().rows.find((r) => r.video.id === 'd8')).toMatchObject({ status: 'not_queued', failure: null });
  });

  it('학습 시작·자막 다시 시도 경로(enqueue/retryFailed)로 Day 영상을 넣어도 요청하지 않음', async () => {
    const { db } = createTestRepos();
    await seedDay7(db);
    const { client, gemini } = server();
    const pc = device(db, client);
    await pc.enqueue(['d7'], { manual: true });
    await pc.retryFailed(['d7']);
    await pc.start();
    expect(gemini.createCalls).toEqual([]);
    expect((await createContentStore(db).getPrep()).queue).toEqual([]);
  });

  it('제목은 일반이어도 Day 정리에서 확정한 번호가 1~100이면 Day / 제안만 된 번호는 무시', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'c1', 'confirmed01', 'No number title', { transcript: ['1. I could use a break.'] });
    await seedVideo(db, 's1', 'suggested01', 'Another title', { transcript: ['1. I could use a break.'] });
    await db.dayAssignments.add({ id: 'da1', createdAt: T, updatedAt: T, videoId: 'c1', dayNumber: 20, status: 'confirmed', source: 'user' } as never);
    await db.dayAssignments.add({ id: 'da2', createdAt: T, updatedAt: T, videoId: 's1', dayNumber: 21, status: 'suggested', source: 'title' } as never);
    const { client, gemini } = server();
    const pc = device(db, client);
    await pc.startAll();
    await pc.start();
    expect(gemini.createCalls).toEqual(['pack:suggested01']);
    expect(pc.getSnapshot().rows.find((r) => r.video.id === 'c1')).toMatchObject({ series: 'day', dayNumber: 20 });
  });
});

describe('Day 자료 만들기 (사용자 문장만)', () => {
  it('요청: 사용자 문장만 사용자 순서대로 1번부터, 원문 그대로 — AI 문장·자막·힌트 없음, 사용자 요청 표시', async () => {
    const { db } = createTestRepos();
    await seedDay7(db);
    const { client, gemini, sent } = server();
    const pc = device(db, client);
    expect(await pc.makeDay('d7')).toBe(true);
    await pc.start();
    expect(gemini.createCalls).toEqual(['daypack:daySeven007']);
    const req = sent.filter((s) => s.body.task === 'daypack');
    expect(new Set(req.map((s) => s.key)).size).toBe(1);
    const body = req[0].body as AiDayPackRequest & { origin?: string };
    expect(body.origin).toBe('user');
    expect(body).toMatchObject({ seriesKind: 'day', dayNumber: 7 });
    expect(body.sentences.map((s) => [s.number, s.text])).toEqual([
      [1, 'I could use a cup of coffee.'],
      [2, 'We could really use some help here.'],
      [3, 'That sounds like a plan.'],
    ]);
    expect(body.sentences.every((s) => s.chunks.length === 0)).toBe(true);
    expect('transcript' in body).toBe(false);
    expect('taughtHints' in body).toBe(false);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('You could use some rest.');
    expect(raw).not.toContain('Welcome to Day 7');
  });

  it('저장: 대화·Chunk는 사용자 문장에만 연결, 원문·AI 문장·기존 표현은 그대로, 이미 있으면 다시 만들지 않음', async () => {
    const { db } = createTestRepos();
    const { ai, mine } = await seedDay7(db);
    const hintBefore = await db.expressions.get('ex-hint');
    const { client, gemini } = server();
    const pc = device(db, client);
    await pc.makeDay('d7');
    await pc.start();
    const d = (await db.dialogues.where('videoId').equals('d7').toArray()).find((x) => x.generatedBy === 'ai')!;
    expect(d).toMatchObject({ kind: 'original', sourceDays: [7] });
    const sources = d.lines.map((l) => l.sourceSentenceId).filter(Boolean);
    expect(sources.length).toBe(3);
    expect(sources.every((id) => ['u1', 'u2', 'u3'].includes(id!))).toBe(true);
    const items = await db.learningItems.where('videoId').equals('d7').toArray();
    const core = items.filter((i) => i.kind === 'core');
    expect(core).toHaveLength(1);
    expect(core[0].occurrences!.map((o) => o.sentenceId).sort()).toEqual(['u1', 'u2']);
    const links = items.filter((i) => i.id !== 'li-hint').flatMap((i) => [i.sentenceId, ...(i.occurrences ?? []).map((o) => o.sentenceId)]).filter(Boolean);
    expect(links.some((id) => id === 'ai1' || id === 'ai2')).toBe(false);
    // 원문 보존: 문장은 새로 만들지 않고, 기존 문장(AI·사용자)은 그대로
    const after = await db.keySentences.where('videoId').equals('d7').toArray();
    expect(after).toHaveLength(5);
    for (const s of [...ai, ...mine]) expect(await db.keySentences.get(s.id)).toEqual(s);
    expect(await db.expressions.get('ex-hint')).toEqual(hintBefore);
    expect(pc.getSnapshot().rows.find((r) => r.video.id === 'd7')).toMatchObject({ status: 'ready', stage: 'done' });
    expect(pc.getSnapshot().summary?.day).toMatchObject({ done: 1 });
    // 다시 눌러도 요청하지 않음 (중복 생성 없음)
    expect(await pc.makeDay('d7')).toBe(false);
    await pc.start();
    expect(gemini.createCalls).toHaveLength(1);
    expect(await db.dialogues.where('videoId').equals('d7').count()).toBe(1);
  });

  it('다른 기기에서 같은 문장으로 눌러도 Gemini 생성은 1번 (서버 보관 결과 재사용)', async () => {
    const A = createTestRepos().db;
    const B = createTestRepos().db;
    await seedDay7(A);
    await seedDay7(B);
    const { client, gemini } = server();
    const a = device(A, client);
    const b = device(B, client);
    await a.makeDay('d7');
    await a.start();
    await b.makeDay('d7');
    await b.start();
    expect(gemini.createCalls).toEqual(['daypack:daySeven007']);
    expect(await B.dialogues.count()).toBe(1);
  });

  it('예전 방식으로 이미 만든 Day 자료는 그대로 (완료로 보고, 다시 만들거나 덮어쓰지 않음)', async () => {
    const { db } = createTestRepos();
    await seedDay7(db);
    const old = { id: 'dlg-day-oldreq', createdAt: T, updatedAt: T, kind: 'original' as const, videoId: 'd7', sourceVideoIds: [], orderInVideo: 1, title: '예전 Day 자료', situation: '', lines: [], expressionIds: [], generatedBy: 'ai' as const, isFavorite: true };
    await db.dialogues.add(old);
    const { client, gemini } = server();
    const pc = device(db, client);
    await pc.refresh();
    expect(pc.getSnapshot().rows.find((r) => r.video.id === 'd7')).toMatchObject({ status: 'ready' });
    expect(await pc.makeDay('d7')).toBe(false);
    await pc.start();
    expect(gemini.createCalls).toEqual([]);
    expect(await db.dialogues.get('dlg-day-oldreq')).toEqual(old);
  });

  it('문장이 없거나 20개를 넘거나 500자를 넘으면 요청하지 않고 이유를 남김', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'e1', 'emptyDay001', '[Day 1] empty');
    await seedVideo(db, 'm1', 'manyDay0002', '[Day 2] many');
    await seedVideo(db, 'l1', 'longDay0003', '[Day 3] long');
    for (let i = 1; i <= 21; i++) await addSentence(db, `m${i}`, 'm1', i, `Sentence number ${i}.`, 'manual');
    await addSentence(db, 'long', 'l1', 1, `${'word '.repeat(110)}end.`, 'manual');
    await addSentence(db, 'aiOnly', 'e1', 1, 'AI sentence only.', 'ai_extracted', { aiNumber: 1 });
    const { client, gemini } = server();
    const pc = device(db, client);
    for (const id of ['e1', 'm1', 'l1']) {
      await pc.makeDay(id);
      await pc.start();
    }
    expect(gemini.createCalls).toEqual([]);
    const rows = pc.getSnapshot().rows;
    expect(rows.find((r) => r.video.id === 'e1')?.failure?.error).toMatchObject({ code: 'day_sentences' });
    expect(rows.find((r) => r.video.id === 'e1')?.failure?.error.message).toContain('1개 이상');
    expect(rows.find((r) => r.video.id === 'm1')?.failure?.error.message).toContain('20개');
    expect(rows.find((r) => r.video.id === 'l1')?.failure?.error.message).toContain('500자');
    expect(rows.find((r) => r.video.id === 'l1')?.failure?.error.message).toContain('1번');
    expect(pc.getSnapshot().status).toMatchObject({ kind: 'done' }); // 대기열을 멈추지 않음
  });

  it('보낸 뒤 문장이 바뀌면 결과를 저장하지 않음 (잘못된 연결 방지) → 다시 누르면 새 문장으로 새 요청', async () => {
    const { db } = createTestRepos();
    await seedDay7(db);
    const { client, gemini, onSend } = server();
    let once = false;
    onSend(async (body) => {
      if (body.task === 'daypack' && !once) {
        once = true;
        await addSentence(db, 'u0', 'd7', 0, 'Let me figure it out.', 'manual'); // 1번 자리에 새 문장
      }
    });
    const pc = device(db, client);
    await pc.makeDay('d7');
    await pc.start();
    expect(await db.dialogues.where('videoId').equals('d7').count()).toBe(0);
    const row = pc.getSnapshot().rows.find((r) => r.video.id === 'd7')!;
    expect(row).toMatchObject({ status: 'failed', failure: { stage: 'dayuser', error: { code: 'sentences_changed' } } });
    await pc.makeDay('d7');
    await pc.start();
    expect(gemini.createCalls).toEqual(['daypack:daySeven007', 'daypack:daySeven007']);
    const d = (await db.dialogues.where('videoId').equals('d7').toArray())[0];
    expect(d.lines.some((l) => l.sourceSentenceId === 'u0')).toBe(true);
  });

  it('Gemini 처리 실패: 그 Day만 실패 + 자동 재시도 없음 → 다시 누르면 새로 요청(retryFailed는 첫 요청에만)', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'f1', 'mockFail0d7', '[Day 9] fail');
    await addSentence(db, 'x1', 'f1', 1, 'I could use a break.', 'manual');
    const { client, gemini, sent } = server();
    const pc = device(db, client);
    await pc.makeDay('f1');
    await pc.start();
    expect(pc.getSnapshot().rows.find((r) => r.video.id === 'f1')).toMatchObject({ status: 'failed', failure: { stage: 'dayuser', error: { code: 'gemini_failed' } } });
    await device(db, client).resume();
    expect(gemini.createCalls).toHaveLength(1);
    await pc.continueQueue();
    await pc.makeDay('f1');
    await pc.start();
    expect(gemini.createCalls).toHaveLength(2);
    const daypacks = sent.filter((s) => s.body.task === 'daypack');
    expect(daypacks.filter((s) => s.body.retryFailed).length).toBe(1);
  });

  it('하루 상한: Gemini를 부르지 않고 멈춤, 실패로 남기지 않음 / Google 한도 초과: 보류 후 초기화 뒤 이어서', async () => {
    const { db } = createTestRepos();
    await seedDay7(db);
    let t = Date.parse(T);
    const { client, gemini, ledger } = server({ ...DEFAULT_AI_CAPS, minGapMs: 0, dailyRequests: 1 }, () => t);
    ledger.putUsage({ pacificDate: '2026-11-16', requests: 1, videoSec: 0 });
    const pc = device(db, client, () => new Date(t));
    await pc.makeDay('d7');
    await pc.start();
    expect(gemini.createCalls).toEqual([]);
    expect(pc.getSnapshot().status).toMatchObject({ kind: 'paused', code: 'daily_cap' });
    expect(pc.getSnapshot().rows.find((r) => r.video.id === 'd7')?.status).toBe('queued');
    t += 26 * 3_600_000;
    const pc2 = device(db, client, () => new Date(t));
    await pc2.resume();
    await pc2.start();
    expect(gemini.createCalls).toEqual(['daypack:daySeven007']);
    expect(pc2.getSnapshot().rows.find((r) => r.video.id === 'd7')?.status).toBe('ready');

    // Google 한도 초과 (작업이 RESOURCE_EXHAUSTED로 끝남) → 보류, 실패로 두지 않음
    const db2 = createTestRepos().db;
    await seedVideo(db2, 'q', 'mockExhausD', '[Day 4] quota');
    await addSentence(db2, 'q1', 'q', 1, 'I could use a break.', 'manual');
    const s2 = server();
    const pq = device(db2, s2.client);
    await pq.makeDay('q');
    await pq.start();
    expect(pq.getSnapshot().status).toMatchObject({ kind: 'paused', code: 'gemini_quota' });
    expect(pq.getSnapshot().rows.find((r) => r.video.id === 'q')?.status).toBe('queued');
    expect((await createContentStore(db2).getPrep()).held).toEqual({ q: 1 });
  });
});

describe('핵심 문장 입력 (Day 영상: 최대 20개)', () => {
  it('Day: 사용자 문장끼리만 세고(예전 AI 문장 제외) 20개까지, 500자 초과는 저장 안 함 / 일반: 기존 5개 규칙 그대로', async () => {
    const { db, repos } = createTestRepos();
    await seedVideo(db, 'd', 'dayVideo001', '[Day 10] x');
    for (let i = 1; i <= 6; i++) await addSentence(db, `ai${i}`, 'd', 100 + i, `AI sentence ${i}.`, 'ai_extracted', { aiNumber: i });
    // AI 문장과 같은 문장도 사용자 문장으로 넣을 수 있음 (Day 재료는 사용자 문장만)
    await addKeySentence(repos, 'd', { english: 'AI sentence 1.', origin: 'transcript' }, { day: true });
    await expect(addKeySentence(repos, 'd', { english: 'AI sentence 1.', origin: 'manual' }, { day: true })).rejects.toMatchObject({ code: 'duplicate' });
    for (let i = 2; i <= 20; i++) await addKeySentence(repos, 'd', { english: `My sentence ${i}.`, origin: 'manual' }, { day: true });
    await expect(addKeySentence(repos, 'd', { english: 'One more.', origin: 'manual' }, { day: true })).rejects.toMatchObject({ code: 'limit' });
    const mine = (await db.keySentences.where('videoId').equals('d').toArray()).filter((s) => s.origin !== 'ai_extracted');
    expect(mine).toHaveLength(20);
    expect(new Set(mine.map((s) => s.order)).size).toBe(20);
    await seedVideo(db, 'd2', 'dayVideo002', '[Day 11] y');
    await expect(addKeySentence(repos, 'd2', { english: `${'a'.repeat(501)}`, origin: 'manual' }, { day: true })).rejects.toMatchObject({ code: 'limit' });
    // 일반 영상은 예전 규칙 그대로 (5개)
    await seedVideo(db, 'g', 'generalVid1', 'General');
    for (let i = 1; i <= 5; i++) await addKeySentence(repos, 'g', { english: `General ${i}.`, origin: 'manual' });
    await expect(addKeySentence(repos, 'g', { english: 'General 6.', origin: 'manual' })).rejects.toMatchObject({ code: 'limit' });
  });

  it('선정 취소 보호는 Day 자료가 실제로 참조하는 문장만 (대화 원문 출처·Chunk 연결) — 연결 안 된 문장·일반 영상은 예전 규칙', async () => {
    const { db, repos } = createTestRepos();
    await seedDay7(db);
    const s = (await db.keySentences.get('u3'))!;
    expect(await getRemovalBlocker(repos, s, { day: true })).toBeNull();
    const { client } = server();
    const pc = device(db, client);
    await pc.makeDay('d7');
    await pc.start();
    // 대화 줄의 원문 출처로 쓰인 문장
    expect(await getRemovalBlocker(repos, s, { day: true })).toContain('원문 출처');
    // Chunk 활용 사례로 연결된 문장 (화면이 넘겨주는 연결 목록)
    const items = await db.learningItems.where('videoId').equals('d7').toArray();
    const linked = new Set(items.flatMap((i) => [i.sentenceId, ...(i.occurrences ?? []).map((o) => o.sentenceId)]).filter((x): x is string => !!x));
    expect(linked.has('u1')).toBe(true);
    await db.dialogues.toCollection().modify((d) => { d.lines = d.lines.map((l) => (l.sourceSentenceId === 'u1' ? { ...l, sourceSentenceId: undefined } : l)); });
    expect(await getRemovalBlocker(repos, (await db.keySentences.get('u1'))!, { day: true, linkedIds: linked })).toContain('Chunk');
    // 자료를 만든 뒤 더한, 어디에도 연결되지 않은 문장은 취소할 수 있다
    await addSentence(db, 'u9', 'd7', 9, 'Added after material.', 'manual');
    expect(await getRemovalBlocker(repos, (await db.keySentences.get('u9'))!, { day: true, linkedIds: linked })).toBeNull();
    // 일반 영상 규칙(옵션 없음)은 예전 그대로 — 원문 출처 연결로는 막지 않음
    expect(await getRemovalBlocker(repos, s)).toBeNull();
  });
  it('학습 기록이 있는 500자 초과 문장: 선정 취소도 막혀 그 Day 자료는 만들 수 없지만(이유 표시), 학습 기록·문장은 그대로', async () => {
    const { db, repos } = createTestRepos();
    await seedVideo(db, 'x', 'longLearned', '[Day 15] 긴 문장');
    const long = await addSentence(db, 'xl', 'x', 1, `Long ${'word '.repeat(110)}end.`, 'manual', { status: 'learning', correctCount: 3, wrongCount: 1 });
    await addSentence(db, 'xs', 'x', 2, 'Short one.', 'manual');
    await db.reviewStates.add({ id: 'sentence:xl', createdAt: T, updatedAt: T, itemType: 'sentence', itemId: 'xl' } as never);
    const { client, gemini } = server();
    const pc = device(db, client);
    await pc.makeDay('x');
    await pc.start();
    expect(gemini.createCalls).toEqual([]);
    expect(pc.getSnapshot().rows.find((r) => r.video.id === 'x')?.failure?.error.message).toMatch(/1번 “Long word.*\d+자/);
    expect(await getRemovalBlocker(repos, long, { day: true })).toContain('학습 기록');
    expect(await db.keySentences.get('xl')).toEqual(long);
    expect(await db.reviewStates.get('sentence:xl')).toBeTruthy();
  });
});

describe('서버: Day 1~100 자료는 사용자 요청만 (예전 앱 보호)', () => {
  const body = (task: 'pack' | 'daypack' | 'content', dayNumber: number | null, extra: Record<string, unknown> = {}) => {
    const base = { videoId: 'srvDay00007', title: 't', seriesKind: dayNumber ? 'day' : 'general', dayNumber, promptVersion: 'p' };
    if (task === 'daypack') return { ...base, task, sentences: [{ number: 1, text: 'I could use a break.', meaningKo: '', chunks: [] }], ...extra };
    return { ...base, task, transcript: 'I could use a break. You could use some rest.', ...extra };
  };

  it('isDayManualOnly: pack·daypack·content 중 Day 1~100만', () => {
    expect(isDayManualOnly(body('pack', 7) as never)).toBe(true);
    expect(isDayManualOnly(body('daypack', 100) as never)).toBe(true);
    expect(isDayManualOnly(body('content', 1) as never)).toBe(true);
    expect(isDayManualOnly(body('pack', 101) as never)).toBe(false);
    expect(isDayManualOnly(body('pack', null) as never)).toBe(false);
    expect(isDayManualOnly({ task: 'extract', videoId: 'srvDay00007', durationSec: 60 } as never)).toBe(false);
  });

  it('자동·표시 없는 요청은 409 day_manual_only (Gemini·기록·사용량 없음), 사용자 요청과 Day 101·일반은 통과', async () => {
    const gemini = createMockGemini();
    const store = memoryLedgerStore();
    const deps = { store, gemini, caps: { ...DEFAULT_AI_CAPS, minGapMs: 0 }, now: () => Date.parse(T) };
    for (const b of [body('pack', 7), body('daypack', 7, { origin: 'auto' }), body('content', 100), body('daypack', 7, { origin: 'User' }), body('daypack', 7, { origin: 'user', auto: true })]) {
      const r = await handleAiExtract({ idempotencyKey: uuid(), body: b }, deps);
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ ok: false, code: 'day_manual_only', consumed: false });
    }
    expect(gemini.createCalls).toEqual([]);
    expect(store.getUsage('2026-11-16')).toMatchObject({ requests: 0 });
    // 사용자 요청은 그대로 진행
    const ok = await handleAiExtract({ idempotencyKey: uuid(), body: body('daypack', 7, { origin: 'user' }) }, deps);
    expect(ok.status).toBe(202);
    // Day 101 이상·일반 영상은 자동 요청도 기존대로
    await handleAiExtract({ idempotencyKey: uuid(), body: { ...body('pack', 101), videoId: 'srvDay00101' } }, deps);
    await handleAiExtract({ idempotencyKey: uuid(), body: { ...body('pack', null), videoId: 'srvGeneral1' } }, deps);
    expect(gemini.createCalls).toEqual(['daypack:srvDay00007', 'pack:srvDay00101', 'pack:srvGeneral1']);
  });

  it('제한: 자막 추출(extract)은 Day 여부를 알 수 없어 자동 몫(하루 6회) 안에서 통과', async () => {
    const gemini = createMockGemini();
    const deps = { store: memoryLedgerStore(), gemini, caps: { ...DEFAULT_AI_CAPS, minGapMs: 0 }, now: () => Date.parse(T) };
    const r = await handleAiExtract({ idempotencyKey: uuid(), body: { videoId: 'srvDay00007', durationSec: 120, promptVersion: 'e1' } }, deps);
    expect(r.status).toBe(202);
    expect(gemini.createCalls).toEqual(['srvDay00007']);
  });
});
