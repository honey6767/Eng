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

  it('빈칸 자료: 핵심 Chunk=1, 추가 표현=2, 주요 단어=3, 나머지=4 (예전 형식은 1·2·3)', () => {
    const line = { id: 'l1', order: 1, speaker: 'A' as const, korean: '', segments: [{ kind: 'connector' as const, text: 'I' }, { kind: 'key' as const, text: 'could', learningItemId: 'c' }, { kind: 'connector' as const, text: 'really' }, { kind: 'key' as const, text: 'use', learningItemId: 'c' }, { kind: 'connector' as const, text: 'a' }, { kind: 'key' as const, text: 'big coffee', learningItemId: 'x' }] };
    expect(buildBlankPlan([line], new Set(['c']))).toEqual({ version: 2, lines: { l1: [4, 1, 4, 1, 4, 2, 2] } });
    expect(buildBlankPlan([line]).lines.l1).toEqual([3, 1, 3, 1, 3, 1, 1]);
  });
});

import { blankIndexes, normalizedRanks } from './blanks';
describe('빈칸 단계', () => {
  // version 2: 1 핵심 Chunk · 2 추가 덩어리 표현 · 3 주요 단어 · 4 나머지
  const ranks = [4, 1, 4, 1, 2, 3, 3, 3, 4, 4];
  it('2단계 핵심 Chunk만, 3단계 추가 표현 → 주요 단어까지 비율만큼, 4단계 대부분, 5단계 전부, 같은 줄은 항상 같은 자리', () => {
    expect([...blankIndexes(ranks, 'l', 1, 30)]).toEqual([]);
    expect([...blankIndexes(ranks, 'l', 2, 30)].sort()).toEqual([1, 3]);
    const s3 = blankIndexes(ranks, 'l', 3, 30);
    expect([...s3].sort()).toEqual([1, 3, 4]); // 추가 표현이 주요 단어보다 먼저
    expect(blankIndexes(ranks, 'l', 3, 100).size).toBe(6); // 나머지 단어는 3단계에서 가리지 않음
    expect(blankIndexes(ranks, 'l', 4, 70).size).toBe(7);
    expect(blankIndexes(ranks, 'l', 5, 0).size).toBe(10);
    expect([...blankIndexes(ranks, 'l', 4, 70)]).toEqual([...blankIndexes(ranks, 'l', 4, 70)]);
  });
  it('예전(version 1) 빈칸 자료도 같은 기준으로 읽음', () => {
    expect(normalizedRanks({ version: 1, lines: { l: [3, 1, 2] } }, 'l')).toEqual([4, 1, 3]);
    expect(normalizedRanks({ version: 2, lines: { l: [4, 1, 2] } }, 'l')).toEqual([4, 1, 2]);
  });
});

import { classifyChunks, commonPattern, rolesByItem } from './chunkRoles';
import { matchParts } from '@/utils/chunkMatch';
import { buildDayPackRequest, validateDayPack, validatePack } from './packService';
import { buildDayPackPrompt, buildPackPrompt } from '../../../server/ai/tasks';

describe('핵심 Chunk(강사가 가르친 표현)와 추가 덩어리 표현(AI가 찾은 표현) 분리', () => {
  const sentences = [
    { number: 1, text: 'I could seriously use a cup of coffee right now.' },
    { number: 2, text: "I didn't get much sleep last night. I could really use a nap." },
  ];
  const core = { text: 'could use', parts: ['could', 'use'], meaningKo: '~이 있으면 좋겠다', nuance: 'need보다 부드럽게', usage: '', comparison: '', examples: [], sentenceNumbers: [1, 2], taughtEvidence: '오늘 배울 표현은 could use예요' };
  const dialogue = { title: 't', situation: 's', lines: [{ speaker: 'A', en: 'I could really use a nap.', ko: '낮잠 자고 싶다.', sourceSentenceNumber: 2, chunkTexts: ['could use'] }, { speaker: 'B', en: 'You need to get much sleep.', ko: '잠을 푹 자야 해.', sourceSentenceNumber: 0, chunkTexts: ['get much sleep'] }], chunkNotes: [] };

  it('pack: 핵심 Chunk의 활용형(could seriously use 등)은 추가 표현에서 빠지고, 강의 설명이 핵심 Chunk에 남는다', () => {
    const v = validatePack(JSON.stringify({
      sentences: [
        { number: 1, text: sentences[0].text, meaningKo: '', timestampSec: 1, chunks: [{ text: 'could seriously use', parts: ['could', 'seriously', 'use'] }, { text: 'a cup of coffee' }] },
        { number: 2, text: sentences[1].text, meaningKo: '', timestampSec: 2, chunks: [{ text: 'get much sleep' }, { text: 'could really use a nap' }] },
      ],
      coreChunks: [core], dialogue, notes: '',
    }), 300);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.content!.sentences.flatMap((s) => s.chunks.map((c) => c.text))).toEqual(['a cup of coffee', 'get much sleep']);
    expect(v.pack.core[0].taught).toBe('오늘 배울 표현은 could use예요');
  });

  it('daypack: 추가 표현은 원문 문장에 연결하고, 활용형은 거부', () => {
    const v = validateDayPack(JSON.stringify({ coreChunks: [core], extraChunks: [{ sentenceNumber: 2, text: 'get much sleep' }, { sentenceNumber: 1, text: 'could seriously use' }, { sentenceNumber: 1, text: 'not in sentence' }], dialogue, notes: '' }), sentences);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.pack.extras.map((x) => [x.sentenceNumber, x.chunk.text])).toEqual([[2, 'get much sleep']]);
  });

  it('저장: 새 추가 표현은 chunkRole=extra, 대화문에서 kind=extra·빈칸 2순위, 핵심 Chunk는 kind=core·1순위', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'v1', 'eNODHkrNuDA', '[Day 11] 필요해', { transcript: ['Today\'s expression is could use.', ...sentences.map((s) => `${s.number}. ${s.text}`)] });
    const { client } = server();
    await device(db, client).enqueue(['v1']);
    await device(db, client).start();
    const items = await db.learningItems.where('videoId').equals('v1').toArray();
    const extras = items.filter((i) => i.kind === 'chunk');
    expect(extras.length).toBeGreaterThan(0);
    expect(extras.every((i) => i.chunkRole === 'extra')).toBe(true);
    const exprs = new Map((await db.expressions.toArray()).map((e) => [e.id, e.text]));
    expect(extras.some((i) => /could/.test(exprs.get(i.expressionId) ?? ''))).toBe(false); // 활용형은 추가 표현이 아님
    const coreItem = items.find((i) => i.kind === 'core')!;
    expect(coreItem.chunk?.taught).toMatch(/expression is could use/);
    const d = (await db.dialogues.where('videoId').equals('v1').toArray())[0];
    expect(d.blankPlan?.version).toBe(2);
    expect(d.chunkUsages!.find((u) => u.learningItemId === coreItem.id)?.kind).toBe('core');
  });

  it('예전 기준 자료: 저장은 그대로 두고 보여 줄 때만 활용형은 핵심 Chunk 아래, 나머지는 추가 표현', () => {
    const e = (id: string, text: string) => ({ id, text, normalizedKey: text, meaningKo: '', sourceRefs: [], isFavorite: false, isMarkedDifficult: false, createdAt: T, updatedAt: T });
    const li = (id: string, kind: 'core' | 'chunk', expressionId: string, extra: Partial<import('@/types/models').LearningItem> = {}) =>
      ({ id, kind, expressionId, videoId: 'v', sourceType: 'day', dayNumber: 11, dialogueId: null, sourceText: null, timestampSec: null, onScreen: false, origin: 'ai_extracted', status: 'confirmed', extractionDraftId: null, legacyKeySentenceId: null, createdAt: T, updatedAt: T, ...extra }) as import('@/types/models').LearningItem;
    const exprById = new Map([e('e1', 'could use'), e('e2', 'could seriously use'), e('e3', 'a cup of coffee'), e('e4', 'could use some advice on')].map((x) => [x.id, x as import('@/types/models').Expression]));
    const items = [li('c', 'core', 'e1', { chunk: { meaningInSentence: '', nuance: '', usage: '', comparison: '', examples: [], parts: ['could', 'use'] } }), li('a', 'chunk', 'e2'), li('b', 'chunk', 'e3'), li('d', 'chunk', 'e4')];
    const before = JSON.stringify(items);
    const v = classifyChunks(items, exprById);
    expect(v.variantsByCore.get('c')!.map((i) => i.id)).toEqual(['a', 'd']);
    expect(v.extras.map((i) => i.id)).toEqual(['b']);
    expect(JSON.stringify(items)).toBe(before);
    // 핵심 Chunk도, 공통 부분도 없는 예전 자료는 분류하지 않음
    expect(classifyChunks([li('b', 'chunk', 'e3')], exprById).unclassified).toHaveLength(1);
  });

  it('요청·프롬프트: daypack은 강의 자막과 자막 추출 때 찾은 핵심 표현을 근거로, 예전 Chunk 목록은 보내지 않음', () => {
    const video = { id: 'v', youtubeVideoId: 'eNODHkrNuDA', title: '[Day 11] x' } as never;
    const ks = sentences.map((s) => ({ id: `k${s.number}`, english: s.text, korean: '', order: s.number, aiNumber: s.number, origin: 'ai_extracted' })) as never;
    const items = [{ kind: 'key', expressionId: 'e1' }, { kind: 'chunk', sentenceId: 'k1', expressionId: 'e2' }] as never;
    const req = buildDayPackRequest(video, undefined, ks, items, new Map([['e1', { text: 'could use' }], ['e2', { text: 'could seriously use' }]]) as never, { status: 'success', segments: [{ startSec: 0, endSec: 1, text: '오늘 배울 표현은 could use' }], rawText: '' } as never);
    expect(req.taughtHints).toEqual(['could use']);
    expect(req.transcript).toContain('오늘 배울 표현');
    expect(req.sentences.every((s) => s.chunks.length === 0)).toBe(true);
    const dp = buildDayPackPrompt(req);
    expect(dp).toContain('강사가 영상에서 직접 소개하고 설명한');
    expect(dp).toContain('could seriously use 같은 활용형은 별도 항목으로 만들지 않습니다');
    expect(dp).toContain('추가 덩어리 표현');
    const pp = buildPackPrompt({ task: 'pack', videoId: 'eNODHkrNuDA', title: 'x', seriesKind: 'day', dayNumber: 11, transcript: 'a'.repeat(30), promptVersion: 'p2' });
    expect(pp).toContain('"추가 덩어리 표현"만 적습니다');
  });
});

describe('Day 11 실제 저장 형태: 핵심 Chunk 기록 없이 활용형 Chunk만 있는 경우 (화면에서만 추론)', () => {
  // 운영 앱에서 실제 Gemini로 만든 Day 11 자료와 같은 형태 (원문 문장 5개 · Chunk 9개 · 핵심 Chunk 기록 없음)
  const SENT = ['I could seriously use a cup of coffee right now.', 'We could use some help from chatGPT.', 'You look super tired. You could use some rest.', 'I could use some advice on which car to buy.', "I didn't get much sleep last night. I could really use a nap."];
  const CHUNKS: [string, number][] = [['look super tired', 3], ['could use some advice on', 4], ['which car to buy', 4], ['could seriously use', 1], ['a cup of coffee', 1], ["didn't get much sleep", 5], ['could really use a nap', 5], ['could use some rest', 3], ['could use some help from', 2]];
  const exprs = new Map<string, import('@/types/models').Expression>();
  const ex = (id: string, text: string, meaningKo = '') => {
    exprs.set(id, { id, text, normalizedKey: text, meaningKo, sourceRefs: [], isFavorite: false, isMarkedDifficult: false, createdAt: T, updatedAt: T } as never);
  };
  const li = (id: string, kind: 'chunk' | 'key', expressionId: string, extra: Partial<import('@/types/models').LearningItem> = {}) =>
    ({ id, kind, expressionId, videoId: 'd11', sourceType: 'day', dayNumber: 11, dialogueId: null, sourceText: null, timestampSec: null, onScreen: false, origin: 'ai_extracted', status: 'confirmed', extractionDraftId: null, legacyKeySentenceId: null, createdAt: T, updatedAt: T, ...extra }) as import('@/types/models').LearningItem;
  const chunkItems = CHUNKS.map(([t, n], i) => {
    ex(`c${i}`, t);
    return li(`li-c${i}`, 'chunk', `c${i}`, { sentenceId: `ks-${n}`, selected: t === 'could seriously use' });
  });
  ex('k1', 'could use', '~가 필요하다, ~했으면 좋겠다');
  const keyItem = li('li-key', 'key', 'k1', { sourceText: "Today's expression is could use." });
  const variantTexts = ['could use some advice on', 'could seriously use', 'could really use a nap', 'could use some rest', 'could use some help from'];
  const extraTexts = ['look super tired', 'which car to buy', 'a cup of coffee', "didn't get much sleep"];
  const textsOf = (l: import('@/types/models').LearningItem[]) => l.map((i) => exprs.get(i.expressionId)!.text);

  it('자막 추출 때 찾은 강사 표현(could use)이 있으면: 그것을 핵심 Chunk로, 활용형 5개는 그 아래, 나머지 4개는 추가 표현', () => {
    const items = [...chunkItems, keyItem];
    const before = JSON.stringify(items);
    const v = classifyChunks(items, exprs);
    expect(v.cores).toHaveLength(0); // 저장된 핵심 Chunk 기록은 여전히 없음
    expect(v.inferred.map((p) => [p.basis, p.text, p.parts, p.taught])).toEqual([['key', 'could use', ['could', 'use'], "Today's expression is could use."]]);
    expect(textsOf(v.variantsByCore.get(v.inferred[0].id)!).sort()).toEqual([...variantTexts].sort());
    expect(textsOf(v.extras).sort()).toEqual([...extraTexts].sort());
    expect(v.unclassified).toHaveLength(0);
    expect(JSON.stringify(items)).toBe(before); // 저장 데이터 그대로
  });

  it('강사 표현 기록도 없으면: 여러 Chunk의 공통 부분 could use를 핵심 Chunk로 추정', () => {
    const v = classifyChunks(chunkItems, exprs);
    expect(v.inferred.map((p) => [p.basis, p.text])).toEqual([['common', 'could use']]);
    expect(textsOf(v.variantsByCore.get(v.inferred[0].id)!).sort()).toEqual([...variantTexts].sort());
    expect(textsOf(v.extras).sort()).toEqual([...extraTexts].sort());
  });

  it('원문 5문장 중 could use가 들어간 문장이 모두 활용 사례 (could seriously use · could really use 포함)', () => {
    const [p] = classifyChunks(chunkItems, exprs).inferred;
    expect(SENT.filter((s) => matchParts(s, p.parts)).length).toBe(5);
    expect(matchParts(SENT[0], p.parts)!.surface).toBe('could seriously use');
  });

  it('우연히 겹친 단어로는 추정하지 않음', () => {
    expect(commonPattern(['a cup of coffee', 'which car to buy', 'look super tired'])).toBeNull();
    expect(commonPattern(['make a decision', 'make up my mind', 'take a break', 'get some rest', 'have a look'])).toBeNull();
  });

  it('통합 대화문 후보: 강사 표현 기록이 있으면 활용형은 그 기록에 포함(고름 표시도 넘김), 나머지는 추가 · AI', () => {
    const roles = rolesByItem([...chunkItems, keyItem], exprs);
    const role = (t: string) => roles.get(chunkItems[CHUNKS.findIndex(([x]) => x === t)].id)!;
    expect(role('could seriously use').variantOf?.item?.id).toBe('li-key');
    expect(role("didn't get much sleep").role).toBe('extra');
    // 강사 표현 기록이 없으면 활용형은 '핵심 could use 활용' 후보로 남음
    const roles2 = rolesByItem(chunkItems, exprs);
    const r2 = roles2.get(chunkItems[3].id)!;
    expect([r2.role, r2.variantOf?.basis, r2.variantOf?.item]).toEqual(['core', 'common', null]);
  });
});

describe('추가 덩어리 표현 기본형 규칙 (look super tired → look tired)', () => {
  it('정도만 강조하는 말만 빼고, 뜻이 바뀌는 말은 그대로', async () => {
    const { deriveBase, isSafeBase } = await import('@/utils/chunkBase');
    expect(deriveBase('look super tired')).toEqual({ base: 'look tired', parts: ['look', 'tired'], dropped: ['super'] });
    expect(deriveBase('look really happy')?.base).toBe('look happy');
    expect(deriveBase('look so familiar')?.base).toBe('look familiar');
    expect(deriveBase("didn't get much sleep")).toBeNull(); // much는 덩어리의 일부
    expect(deriveBase('look too tired')).toBeNull(); // too는 뜻이 바뀜
    expect(deriveBase('which car to buy')).toBeNull();
    expect(isSafeBase("don't look tired", 'look tired')).toBe(false); // 부정은 빼지 않음
    expect(isSafeBase('look super tired', 'look tired')).toBe(true);
  });

  it('이전 형식(p3) AI 결과: 기본형(text)·원문 형태(surface)·pattern·swaps를 그대로 읽음, parts를 안 나눠도 원문에서 찾음', () => {
    const sentences = [{ number: 3, text: 'You look super tired. You could use some rest.' }];
    const core = { text: 'could use', parts: ['could', 'use'], meaningKo: '', nuance: '', usage: '', comparison: '', examples: [], sentenceNumbers: [3], taughtEvidence: '' };
    const dialogue = { title: 't', situation: 's', lines: [{ speaker: 'A', en: 'You look tired.', ko: '피곤해 보여.', sourceSentenceNumber: 0, chunkTexts: [] }, { speaker: 'B', en: 'I could use some rest.', ko: '좀 쉬고 싶어.', sourceSentenceNumber: 0, chunkTexts: [] }], chunkNotes: [] };
    const v = validateDayPack(JSON.stringify({ coreChunks: [core], extraChunks: [{ sentenceNumber: 3, text: 'look tired', parts: ['look tired'], surface: 'look super tired', pattern: 'look + 형용사', swaps: ['look happy', 'look familiar', 'look busy', 'look tired'], meaningKo: '피곤해 보이다' }], dialogue, notes: '' }), sentences);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.pack.extras[0].chunk).toMatchObject({ text: 'look tired', parts: ['look', 'tired'], surface: 'look super tired', pattern: 'look + 형용사', swaps: ['look happy', 'look familiar', 'look busy'] });
  });

  it('AI가 뜻이 바뀌게 줄이면(too 제거) 원문 형태 그대로 둠', () => {
    const v = validateDayPack(JSON.stringify({ coreChunks: [], extraChunks: [{ sentenceNumber: 1, text: 'look tired', parts: ['look', 'tired'], surface: 'look too tired', pattern: '', swaps: [] }], dialogue: { title: 't', situation: 's', lines: [{ speaker: 'A', en: 'a', ko: 'a', sourceSentenceNumber: 0, chunkTexts: [] }, { speaker: 'B', en: 'b', ko: 'b', sourceSentenceNumber: 0, chunkTexts: [] }], chunkNotes: [] }, notes: '' }), [{ number: 1, text: "You don't look too tired." }]);
    expect(v.ok && v.pack.extras.map((x) => x.chunk.text)).toEqual(['look too tired']);
  });

  it('예전 Day 11 자료(look super tired 그대로 저장): 화면에서만 기본형 look tired · look + 형용사, 저장값은 그대로', async () => {
    const { extraViewOf } = await import('./chunkRoles');
    const e = { id: 'e', text: 'look super tired', normalizedKey: 'look super tired', meaningKo: '', sourceRefs: [], isFavorite: false, isMarkedDifficult: false, createdAt: T, updatedAt: T } as never;
    const item = { id: 'li', kind: 'chunk', expressionId: 'e', videoId: 'd11', chunk: { meaningInSentence: '', nuance: '', usage: '', comparison: '', examples: [], surface: 'look super tired' } } as never;
    const before = JSON.stringify(item);
    const v = extraViewOf(item, e);
    expect(v).toMatchObject({ base: 'look tired', parts: ['look', 'tired'], surface: 'look super tired', dropped: ['super'], source: 'app', patternSource: 'app' });
    expect(v.pattern?.pattern).toBe('look + 형용사');
    expect(v.pattern?.examples.map((x) => [x.en, x.ko])).toEqual([['look happy', '행복해 보이다'], ['look familiar', '낯익어 보이다'], ['look busy', '바빠 보이다']]);
    expect(JSON.stringify(item)).toBe(before);
    const sleep = extraViewOf({ ...(item as object), chunk: undefined } as never, { ...(e as object), text: "didn't get much sleep" } as never);
    expect([sleep.base, sleep.source]).toEqual(["didn't get much sleep", 'none']);
  });

  it('요청 형식: p3/dp3, 프롬프트에 기본형 규칙과 무조건 줄이지 않기 규칙', () => {
    const pp = buildPackPrompt({ task: 'pack', videoId: 'eNODHkrNuDA', title: 'x', seriesKind: 'day', dayNumber: 11, transcript: 'a'.repeat(30), promptVersion: 'p3' });
    expect(pp).toContain('look super tired → look tired');
    expect(pp).toContain('무조건 짧게 줄이지 않습니다');
    expect(pp).toContain('pattern');
  });
});

describe('교체 패턴 (which + 명사 + to buy) — 기본 Chunk와 구분, 검사 통과한 것만', () => {
  const ex = (en: string, ko: string, note = '') => ({ en, ko, note });

  it('패턴 검사: 정해진 자리 이름만, 고정 부분은 기본 Chunk에 같은 순서로, 예시는 패턴에 맞고 뜻이 있어야 함', async () => {
    const { checkPattern, parsePattern } = await import('@/utils/chunkPattern');
    expect(parsePattern('which + 명사 + to buy')?.map((t) => t.slot)).toEqual([false, true, false]);
    expect(parsePattern('which + 물건 + to buy')).toBeNull(); // '물건'은 정해진 자리 이름이 아님 → 패턴 거부
    expect(checkPattern('which car to buy', 'which + 물건 + to buy', '', [ex('which phone to buy', '어떤 폰을 살지')])).toBeNull();
    expect(parsePattern('명사 + 형용사')).toBeNull(); // 고정 부분 없음
    expect(parsePattern('look + 명사 + 형용사')).toBeNull(); // 자리끼리 붙음
    expect(checkPattern('which car to buy', 'which + 명사 + to get', '', [ex('which phone to get', '어떤 폰을 살지')])).toBeNull(); // 고정 부분이 기본 Chunk에 없음
    const ok = checkPattern('which car to buy', 'which + 명사 + to buy', '명사 자리: 사려는 물건', [
      ex('which car to buy', '어떤 차를 살지'), // 기본 Chunk와 같음 → 제외
      ex('which phone to buy', '어떤 폰을 살지'),
      ex('which to buy phone', '어색함'), // 패턴에 안 맞음 → 제외
      ex('which laptop to buy', ''), // 뜻 없음 → 제외
      ex('which laptop to buy', '어떤 노트북을 살지'),
      ex('which one to buy', '어떤 것을 살지'),
      ex('which tablet to buy', '어떤 태블릿을 살지'), // 3개 넘음 → 제외
    ]);
    expect(ok?.pattern).toBe('which + 명사 + to buy');
    expect(ok?.examples.map((x) => x.en)).toEqual(['which phone to buy', 'which laptop to buy', 'which one to buy']);
    expect(checkPattern('which car to buy', 'which + 명사 + to buy', '', [ex('which car to buy', '어떤 차를 살지')])).toBeNull(); // 남는 예시가 없으면 패턴도 없음
  });

  it('예전 Day 11 4개 표현: 화면에서만 기본 Chunk·교체 패턴·활용 예시(뜻·뜻 차이)', async () => {
    const { templatePattern } = await import('@/utils/chunkPattern');
    const which = templatePattern('which car to buy')!;
    expect([which.pattern, which.slotNote]).toEqual(['which + 명사 + to buy', '명사 자리: 사려는 물건']);
    expect(which.examples.map((x) => `${x.en} — ${x.ko}`)).toEqual(['which phone to buy — 어떤 폰을 살지', 'which laptop to buy — 어떤 노트북을 살지', 'which one to buy — 어떤 것을 살지']);
    const sleep = templatePattern("didn't get much sleep")!;
    expect(sleep.pattern).toBe("didn't get much + 불가산명사");
    expect(sleep.examples.map((x) => x.en)).toEqual(["didn't get much rest", "didn't get much exercise"]);
    expect(sleep.examples.every((x) => x.ko && x.note)).toBe(true); // 뜻이 달라지므로 뜻 차이 표시
    const cup = templatePattern('a cup of coffee')!;
    expect([cup.pattern, cup.examples.map((x) => `${x.en} — ${x.ko}`)]).toEqual(['a cup of + 명사', ['a cup of tea — 차 한 잔', 'a cup of hot chocolate — 핫초코 한 잔']]);
    expect(cup.slotNote).toContain('음료');
    expect(templatePattern('look tired')?.pattern).toBe('look + 형용사');
    // 틀에 없는 표현은 패턴 없음 (지어내지 않음)
    expect(templatePattern('could use some help')).toBeNull();
    expect(templatePattern('look after')).toBeNull();
    expect(templatePattern("didn't get much homework")).toBeNull();
    expect(templatePattern('which car to steal')).toBeNull();
  });

  it('p4 AI 결과: 검사를 통과한 활용 예시만 저장 (패턴에 안 맞거나 뜻 없는 것은 뺌), 잘못된 패턴은 저장 안 함', () => {
    const sentences = [{ number: 4, text: 'I could use some advice on which car to buy.' }];
    const dialogue = { title: 't', situation: 's', lines: [{ speaker: 'A', en: 'a', ko: 'a', sourceSentenceNumber: 0, chunkTexts: [] }, { speaker: 'B', en: 'b', ko: 'b', sourceSentenceNumber: 0, chunkTexts: [] }], chunkNotes: [] };
    const run = (x: Record<string, unknown>) => {
      const v = validateDayPack(JSON.stringify({ coreChunks: [], extraChunks: [{ sentenceNumber: 4, text: 'which car to buy', parts: ['which car to buy'], surface: 'which car to buy', meaningKo: '어떤 차를 살지', ...x }], dialogue, notes: '' }), sentences);
      return v.ok ? v.pack.extras[0].chunk : null;
    };
    const good = run({ pattern: 'which + 명사 + to buy', slotNote: '명사 자리: 사려는 물건', swapExamples: [ex('which phone to buy', '어떤 폰을 살지'), ex('phone which to buy', '틀림'), ex('which laptop to buy', '')] });
    expect(good).toMatchObject({ text: 'which car to buy', pattern: 'which + 명사 + to buy', slotNote: '명사 자리: 사려는 물건', swapExamples: [{ en: 'which phone to buy', ko: '어떤 폰을 살지' }] });
    const bad = run({ pattern: 'which + 물건 + to purchase', slotNote: 'x', swapExamples: [ex('which phone to purchase', '어떤 폰')] });
    expect(bad).toMatchObject({ text: 'which car to buy', pattern: '', swapExamples: [] });
  });

  it('보여 주기 순서: AI 결과(검사 통과) → 검토된 틀(예전 자료) → 이전 형식 그대로, 저장값은 바꾸지 않음', async () => {
    const { extraViewOf } = await import('./chunkRoles');
    const e = (text: string) => ({ id: 'e', text, normalizedKey: text, meaningKo: '', sourceRefs: [], isFavorite: false, isMarkedDifficult: false, createdAt: T, updatedAt: T }) as never;
    const item = (chunk: Record<string, unknown> | undefined) => ({ id: 'li', kind: 'chunk', expressionId: 'e', videoId: 'v', chunk }) as never;
    const base = { meaningInSentence: '', nuance: '', usage: '', comparison: '', examples: [] };
    const p4 = item({ ...base, pattern: 'which + 명사 + to buy', slotNote: 'n', swapExamples: [ex('which bike to buy', '어떤 자전거를 살지')] });
    expect(extraViewOf(p4, e('which car to buy'))).toMatchObject({ patternSource: 'ai', pattern: { examples: [{ en: 'which bike to buy' }] } });
    const legacy = item(undefined);
    const lv = extraViewOf(legacy, e('which car to buy'));
    expect([lv.patternSource, lv.pattern?.examples.length]).toEqual(['app', 3]);
    const p3 = item({ ...base, pattern: 'get + 명사', swaps: ['get coffee'] });
    const before = JSON.stringify(p3);
    expect(extraViewOf(p3, e('get lunch'))).toMatchObject({ patternSource: 'old', oldSwaps: ['get coffee'] });
    expect(JSON.stringify(p3)).toBe(before);
    expect(extraViewOf(item(undefined), e('could use some help')).pattern).toBeNull();
  });
});
