import { describe, expect, it } from 'vitest';
import type { StudyDatabase } from '@/db/database';
import { createContentStore } from '@/repositories/contentStore';
import { createExtractionStore } from '@/repositories/extractionStore';
import { createTestRepos } from '@/test/helpers';
import type { AiClient, AiTransportResult } from '@/services/integrations/aiClient';
import { handleAiExtract, type AiCaps } from '../../../server/ai/extractHandler';
import { memoryLedgerStore } from '../../../server/ai/ledger';
import { createMockGemini } from '../../../server/ai/mockGemini';
import { createPrepController } from './prepController';
import { buildBlankPlan } from './packService';

const T = '2026-11-16T12:00:00.000Z';
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

/** 서버 하나(장부 + 가짜 Gemini)를 여러 기기가 같이 쓴다 */
function server(caps: AiCaps = { dailyVideoSec: 6 * 3600, dailyRequests: 20, maxVideoSec: 1800 }, clock = () => Date.parse(T)) {
  const gemini = createMockGemini();
  const ledger = memoryLedgerStore();
  const sent: { key: string; task: string; retryFailed?: boolean }[] = [];
  const client: AiClient = {
    async extract(key, body): Promise<AiTransportResult> {
      sent.push({ key, task: body.task ?? 'extract', retryFailed: body.retryFailed });
      const r = await handleAiExtract({ idempotencyKey: key, body }, { store: ledger, gemini, caps, now: clock });
      return { kind: 'response', httpStatus: r.status, body: r.body };
    },
  };
  return { client, gemini, sent };
}

function device(db: StudyDatabase, client: AiClient, now = () => new Date(T)) {
  return createPrepController({
    store: createContentStore(db), extraction: createExtractionStore(db), client, now, newId: uuid,
    sleep: async () => {}, pollMs: 1, extractPollMs: 1, withLock: async (fn) => (await fn(), true),
  });
}

async function seedVideo(db: StudyDatabase, id: string, yt: string, title: string, opts: { transcript?: string[]; status?: 'new' | 'in_progress'; order?: number } = {}) {
  await db.videos.add({ id, createdAt: T, updatedAt: T, playlistId: null, youtubeVideoId: yt, title, url: null, thumbnailUrl: null, durationSec: 300, orderIndex: opts.order ?? 0, randomOrderKey: 0.1, status: opts.status ?? 'new', completedAt: null, sources: [{ kind: 'manual', addedAt: T }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
  if (opts.transcript) await db.transcripts.add({ id: `tr-${id}`, createdAt: T, updatedAt: T, videoId: id, source: 'manual_paste', status: 'success', rawText: opts.transcript.join('\n'), segments: opts.transcript.map((text, i) => ({ startSec: i * 10, endSec: i * 10 + 9, text })), format: 'timestamped' });
}

const DAY11 = ['Welcome to Day 11.', '1. I could seriously use a cup of coffee right now.', '2. We could use some help.', '3. You look tired. You could use some rest.', '4. I could really use a nap.', 'See you!'];

describe('학습 자료 자동 생성 대기열', () => {
  it('새 영상 등록 → 자동 대기열 → 자막(AI) → 문장·Chunk·공통 Chunk·Day 대화문·빈칸 자료 저장', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'v1', 'eNODHkrNuDA', '[Day 11] 필요해');
    const { client, gemini } = server();
    const pc = device(db, client);
    await pc.enqueue(['v1']);
    await pc.start();
    expect(gemini.createCalls).toEqual(['eNODHkrNuDA', 'pack:eNODHkrNuDA']);
    const d = (await db.dialogues.where('videoId').equals('v1').toArray())[0];
    expect(d).toMatchObject({ kind: 'original', generatedBy: 'ai', sourceDays: [11] });
    expect(d.lines.every((l) => l.korean)).toBe(true);
    expect(Object.keys(d.blankPlan!.lines)).toHaveLength(d.lines.length);
    expect(await db.learningItems.where('kind').equals('core').count()).toBe(1);
    expect(pc.getSnapshot().summary).toMatchObject({ ready: 1, queued: 0 });
  });

  it('공통 Chunk could … use: could seriously use · could really use도 같은 Chunk로 연결, 대화 속 여러 번 표시, 원문 출처 연결', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'v1', 'eNODHkrNuDA', '[Day 11] 필요해', { transcript: DAY11 });
    const { client } = server();
    const pc = device(db, client);
    await pc.enqueue(['v1']);
    await pc.start();
    const core = (await db.learningItems.where('kind').equals('core').toArray())[0];
    expect(core.chunk?.parts).toEqual(['could', 'use']);
    expect(core.occurrences!.map((o) => o.surface)).toEqual(['could seriously use', 'could use', 'could use', 'could really use']);
    const d = (await db.dialogues.where('videoId').equals('v1').toArray())[0];
    const marked = d.lines.flatMap((l) => l.segments).filter((s) => s.kind === 'key' && s.learningItemId === core.id).map((s) => s.text.toLowerCase());
    expect(marked.filter((t) => t === 'could').length).toBeGreaterThanOrEqual(4);
    expect(d.chunkUsages![0]).toMatchObject({ text: 'could … use', learningItemId: core.id });
    const ks = await db.keySentences.where('videoId').equals('v1').toArray();
    expect(d.lines.filter((l) => l.sourceSentenceId).every((l) => ks.some((s) => s.id === l.sourceSentenceId))).toBe(true);
    expect(d.lines.filter((l) => l.sourceSentenceId)).toHaveLength(4);
    // 빈칸 자료: 핵심 Chunk 단어는 1순위
    const first = d.lines.find((l) => /seriously/.test(l.segments.map((s) => s.text).join(' ')))!;
    expect(d.blankPlan!.lines[first.id].filter((r) => r === 1)).toHaveLength(2); // could, use (seriously는 아님)
  });

  it('누락분만: 문장이 이미 있으면 daypack만 (기존 문장·Chunk는 그대로), 대화문까지 있으면 요청 없음', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'v1', 'eNODHkrNuDA', '[Day 11] 필요해', { transcript: DAY11 });
    await db.keySentences.add({ id: 'ks-old-1', createdAt: T, updatedAt: T, videoId: 'v1', order: 1, english: 'I could seriously use a cup of coffee right now.', korean: '기존', expressionIds: [], situation: '', timestampSec: 10, status: 'learning', correctCount: 2, wrongCount: 0, origin: 'ai_extracted', aiNumber: 1, selected: true });
    await db.keySentences.add({ id: 'ks-old-2', createdAt: T, updatedAt: T, videoId: 'v1', order: 2, english: 'We could use some help.', korean: '기존2', expressionIds: [], situation: '', timestampSec: 20, status: 'not_started', correctCount: 0, wrongCount: 0, origin: 'ai_extracted', aiNumber: 2 });
    const before = await db.keySentences.toArray();
    const { client, gemini, sent } = server();
    const pc = device(db, client);
    await pc.enqueue(['v1']);
    await pc.start();
    expect(gemini.createCalls).toEqual(['daypack:eNODHkrNuDA']);
    expect(sent.find((s) => s.task === 'daypack')).toBeTruthy();
    expect(await db.keySentences.toArray()).toEqual(before); // 원문 문장 그대로, 새로 만들지 않음
    const d = (await db.dialogues.where('videoId').equals('v1').toArray())[0];
    expect(d.lines.filter((l) => l.sourceSentenceId).map((l) => l.sourceSentenceId)).toEqual(['ks-old-1', 'ks-old-2']);
    await pc.enqueue(['v1']);
    await pc.start();
    expect(gemini.createCalls).toHaveLength(1);
  });

  it('기존 영상은 수동 시작 전에는 처리하지 않고, 시작하면 Day 번호 순으로 차례로', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'd12', 'bbbbbbbbbbb', '[Day 12] b', { transcript: ['1. That sounds like a plan.'], order: 0 });
    await seedVideo(db, 'd2', 'ccccccccccc', '[Day 2] a', { transcript: ['1. I could use a break.'], order: 1 });
    await seedVideo(db, 'g1', 'ddddddddddd', 'Small talk', { transcript: ['It was no big deal.'], order: 2 });
    const { client, gemini } = server();
    const pc = device(db, client);
    await pc.resume();
    expect(gemini.createCalls).toHaveLength(0);
    expect(pc.getSnapshot().summary).toMatchObject({ notQueued: 3 });
    await pc.startAll();
    await pc.start();
    expect(gemini.createCalls).toEqual(['pack:ccccccccccc', 'pack:bbbbbbbbbbb', 'pack:ddddddddddd']);
    expect(pc.getSnapshot().summary).toMatchObject({ ready: 3 });
  });

  it('하루 상한에 닿으면 멈추고, 초기화 시각 뒤 다시 열면 이어서', async () => {
    const { db } = createTestRepos();
    for (let i = 1; i <= 3; i++) await seedVideo(db, `d${i}`, `vid0000000${i}`, `[Day ${i}] x`, { transcript: [`1. I could use a break ${i}.`] });
    let t = Date.parse(T);
    const { client, gemini } = server({ dailyVideoSec: 6 * 3600, dailyRequests: 2, maxVideoSec: 1800 }, () => t);
    const pc = device(db, client, () => new Date(t));
    await pc.startAll();
    await pc.start();
    expect(gemini.createCalls).toHaveLength(2);
    const snap = pc.getSnapshot();
    expect(snap.status).toMatchObject({ kind: 'paused', code: 'daily_cap' });
    expect(snap.summary).toMatchObject({ ready: 2, queued: 1, failed: 0 });
    await pc.resume(); // 같은 날 다시 열어도 멈춤 유지
    expect(gemini.createCalls).toHaveLength(2);
    t = Date.parse((snap.status as { until: string }).until) + 60_000;
    const pc2 = device(db, client, () => new Date(t)); // 다음 날 앱을 다시 엶
    await pc2.resume();
    await pc2.start();
    expect(gemini.createCalls).toHaveLength(3);
    expect(pc2.getSnapshot().summary).toMatchObject({ ready: 3 });
  });

  it('실패한 영상만 실패로 남고 나머지는 계속, 실패만 다시 시도 (첫 요청에만 retryFailed)', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'bad', 'mockFail001', '[Day 1] bad', { transcript: ['1. I could use a break.'] });
    await seedVideo(db, 'ok', 'okokokokoko', '[Day 2] ok', { transcript: ['1. I could use a break.'] });
    const { client, gemini, sent } = server();
    const pc = device(db, client);
    await pc.startAll();
    await pc.start();
    expect(pc.getSnapshot().summary).toMatchObject({ ready: 1, failed: 1 });
    const fail = pc.getSnapshot().rows.find((r) => r.video.id === 'bad')!;
    expect(fail.failure).toMatchObject({ stage: 'pack', error: { code: 'gemini_failed', httpStatus: 502 } });
    // 결과를 모르는 실패(consumed)는 그냥 다시 열어도 재생성하지 않음
    await pc.resume();
    expect(gemini.createCalls.filter((c) => c.startsWith('pack:mockFail'))).toHaveLength(1);
    await pc.retryFailed();
    await pc.start();
    expect(gemini.createCalls.filter((c) => c.startsWith('pack:mockFail'))).toHaveLength(2);
    const packSends = sent.filter((s) => s.task === 'pack' && s.key !== sent.find((x) => x.task === 'pack')!.key);
    expect(packSends.filter((s) => s.retryFailed).length).toBe(1);
  });

  it('여러 기기: 다른 기기가 같은 영상을 처리해도 Gemini 생성은 1번 (서버 보관 결과 재사용), 학습 기록은 기기별', async () => {
    const A = createTestRepos().db;
    const B = createTestRepos().db;
    for (const db of [A, B]) await seedVideo(db, 'v1', 'eNODHkrNuDA', '[Day 11] 필요해', { transcript: DAY11 });
    const { client, gemini } = server();
    const pa = device(A, client);
    const pb = device(B, client);
    await Promise.all([pa.enqueue(['v1']), pb.enqueue(['v1'])]);
    await Promise.all([pa.start(), pb.start()]);
    expect(gemini.createCalls).toEqual(['pack:eNODHkrNuDA']);
    expect(await A.dialogues.count()).toBe(1);
    expect(await B.dialogues.count()).toBe(1);
    // 선택 표시는 기기별 (공유하지 않음)
    const ka = (await A.keySentences.toArray())[0];
    await createContentStore(A).setSentenceSelected(ka.id, true);
    expect((await B.keySentences.toArray()).some((s) => s.selected)).toBe(false);
  });

  it('앱이 닫혀 중단돼도 같은 요청 식별자로 이어서 확인 (새로 생성하지 않음)', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'v1', 'eNODHkrNuDA', '[Day 11] 필요해', { transcript: DAY11 });
    const { client, gemini, sent } = server();
    // 첫 기기 세션: 요청을 보낸 직후 앱이 닫힘 (조회 전에 멈춤)
    const ac = new AbortController();
    const pc = createPrepController({
      store: createContentStore(db), extraction: createExtractionStore(db), client, now: () => new Date(T), newId: uuid, pollMs: 1, extractPollMs: 1,
      sleep: async () => ac.abort(), withLock: async (fn) => (await fn(), true),
    });
    await pc.enqueue(['v1']);
    await pc.start();
    const firstKey = sent[0].key;
    expect(gemini.createCalls).toHaveLength(1);
    // 다시 열기
    const pc2 = device(db, client);
    await pc2.resume();
    await pc2.start();
    expect(gemini.createCalls).toHaveLength(1);
    expect(new Set(sent.map((s) => s.key))).toEqual(new Set([firstKey]));
    expect(await db.dialogues.count()).toBe(1);
  });

  it('빈칸 자료: Chunk=1, 주요 단어=2, 나머지=3', () => {
    const plan = buildBlankPlan([{ id: 'l1', order: 1, speaker: 'A', korean: '', segments: [{ kind: 'connector', text: 'I' }, { kind: 'key', text: 'could', learningItemId: 'c' }, { kind: 'connector', text: 'really' }, { kind: 'key', text: 'use', learningItemId: 'c' }, { kind: 'connector', text: 'a coffee.' }] }]);
    expect(plan.lines.l1).toEqual([3, 1, 3, 1, 3, 2]);
  });
});

import { blankIndexes } from './blanks';
describe('빈칸 단계', () => {
  const ranks = [3, 1, 3, 1, 3, 2, 2, 2, 3, 3];
  it('2단계 Chunk 전부, 3단계 주요 단어까지 비율만큼, 4단계 대부분, 5단계 전부, 같은 줄은 항상 같은 자리', () => {
    expect([...blankIndexes(ranks, 'l', 1, 30)]).toEqual([]);
    expect([...blankIndexes(ranks, 'l', 2, 30)].sort()).toEqual([1, 3]);
    const s3 = blankIndexes(ranks, 'l', 3, 30);
    expect(s3.size).toBe(3);
    expect([...s3].every((i) => ranks[i] <= 2)).toBe(true);
    expect(blankIndexes(ranks, 'l', 3, 100).size).toBe(5); // 주요 단어 안에서만
    expect(blankIndexes(ranks, 'l', 4, 70).size).toBe(7);
    expect(blankIndexes(ranks, 'l', 5, 0).size).toBe(10);
    expect([...blankIndexes(ranks, 'l', 4, 70)]).toEqual([...blankIndexes(ranks, 'l', 4, 70)]);
  });
});
