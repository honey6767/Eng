import { describe, expect, it } from 'vitest';
import type { StudyDatabase } from '@/db/database';
import { createContentStore } from '@/repositories/contentStore';
import { createTestRepos } from '@/test/helpers';
import type { AiClient, AiTransportResult } from '@/services/integrations/aiClient';
import type { AiTaskRequest } from '@/types/aiApi';
import { handleAiExtract, DEFAULT_AI_CAPS } from '../../../server/ai/extractHandler';
import { memoryLedgerStore } from '../../../server/ai/ledger';
import { createMockGemini } from '../../../server/ai/mockGemini';
import { generateContent } from './controller';
import { validateContent } from './contentService';
import { buildCandidateGroups, buildDialogueRecord, buildDialogueRequest, defaultChecked, recommendGroups, segmentLine } from '@/services/dialogue/combinedDialogue';
import { generateCombinedDialogue, DIALOGUE_TASK_KEY } from '@/services/dialogue/controller';

const T = '2026-11-16T12:00:00.000Z';
let seq = 0;
const newId = () => `gen-${++seq}`;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

/** 서버(장부 + 가짜 Gemini)를 그대로 거치는 클라이언트 — 요청이 몇 번 나갔는지 센다 */
/**
 * asUser(기본): 이 파일의 문장·Chunk 만들기(generateContent)는 화면에서 부르지 않는 예전 기능이라 요청 유형 표시가 없다.
 * Day 1~100 영상 자료는 서버가 사용자 요청만 받으므로, 픽스처를 만들 때는 사용자가 누른 것처럼 표시를 붙인다.
 * asUser=false로 두면 예전 앱과 같은 요청(표시 없음)이 그대로 간다.
 */
function serverClient(asUser = true) {
  const gemini = createMockGemini();
  const store = memoryLedgerStore();
  const sent: { key: string; body: AiTaskRequest }[] = [];
  const client: AiClient = {
    async extract(key, raw): Promise<AiTransportResult> {
      const body = asUser && !(raw as { origin?: string }).origin ? ({ ...raw, origin: 'user' } as unknown as AiTaskRequest) : raw;
      sent.push({ key, body });
      const r = await handleAiExtract({ idempotencyKey: key, body }, { store, gemini, caps: { ...DEFAULT_AI_CAPS, minGapMs: 0 }, now: () => Date.parse(T) });
      return { kind: 'response', httpStatus: r.status, body: r.body };
    },
  };
  return { client, gemini, sent };
}

async function seedVideo(db: StudyDatabase, id: string, title: string, lines: string[], status: 'new' | 'in_progress' | 'completed' = 'new', startedAt: string | null = null) {
  await db.videos.add({ id, createdAt: T, updatedAt: T, playlistId: null, youtubeVideoId: `${id}xxxxxxxxxxx`.slice(0, 11), title, url: null, thumbnailUrl: null, durationSec: 300, orderIndex: 0, randomOrderKey: 0.1, status, completedAt: null, startedAt, sources: [{ kind: 'manual', addedAt: T }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
  await db.transcripts.add({ id: `tr-${id}`, createdAt: T, updatedAt: T, videoId: id, source: 'ai_transcription', status: 'success', rawText: lines.join('\n'), segments: lines.map((text, i) => ({ startSec: i * 10, endSec: i * 10 + 9, text })), format: 'timestamped' });
}

const deps = (db: StudyDatabase, client: AiClient) => ({ store: createContentStore(db), client, newId, sleep: async () => {}, now: () => new Date(T) });
const DAY11 = ['Hi guys, welcome to Day 11.', '1. I could use a little break right now.', '2. That sounds like a good idea.', '3. Let me figure out what to do.', '4. I am running late again.', 'Thanks for watching!'];

describe('학습 콘텐츠: 원문 문장 + 문장 속 Chunk', () => {
  it('Day 영상: 번호·원문 그대로 4개(고정 개수 아님), Chunk는 문장과 따로 저장되고 문장·영상·Day에 연결', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'v11', '[Day 11] 필요해 I need 말고', DAY11);
    const { client, gemini } = serverClient();
    const seen: string[] = [];
    const out = await generateContent({ ...deps(db, client), newId: uuid }, 'v11', (p) => seen.push(p.phase));
    expect(out).toMatchObject({ phase: 'succeeded', sentences: 4 });
    expect(seen[0]).toBe('sending');
    expect(gemini.createCalls).toEqual(['content:v11xxxxxxxx']);
    const ks = (await db.keySentences.where('videoId').equals('v11').toArray()).sort((a, b) => a.order - b.order);
    expect(ks.map((s) => [s.aiNumber, s.english])).toEqual([
      [1, 'I could use a little break right now.'],
      [2, 'That sounds like a good idea.'],
      [3, 'Let me figure out what to do.'],
      [4, 'I am running late again.'],
    ]);
    expect(ks.every((s) => s.origin === 'ai_extracted' && s.selected === false)).toBe(true);
    const chunks = await db.learningItems.where('kind').equals('chunk').toArray();
    const exprs = new Map((await db.expressions.toArray()).map((e) => [e.id, e.text]));
    const s1 = chunks.filter((c) => c.sentenceId === ks[0].id).map((c) => exprs.get(c.expressionId));
    expect(s1.sort()).toEqual(['a little break', 'could use', 'right now']);
    expect(chunks.every((c) => c.dayNumber === 11 && c.sourceType === 'day' && c.videoId === 'v11' && c.chunk && c.chunk.examples.length > 0)).toBe(true);
    // 문장과 Chunk는 다른 항목: 문장 전체가 Chunk로 들어가지 않는다
    expect(chunks.some((c) => exprs.get(c.expressionId) === ks[0].english)).toBe(false);
  });

  it('다시 눌러도 요청하지 않음, 기존 핵심 문장·표현은 바꾸지 않고 같은 표현은 재사용', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'v11', '[Day 11] 필요해', DAY11);
    const userSentence = { id: 'ks-user', createdAt: T, updatedAt: T, videoId: 'v11', order: 1, english: 'I could use a little break right now.', korean: '내가 쓴 뜻', expressionIds: [], situation: '', timestampSec: null, status: 'learning' as const, correctCount: 3, wrongCount: 1 };
    await db.keySentences.add(userSentence);
    const oldExpr = { id: 'ex-old', createdAt: T, updatedAt: T, normalizedKey: 'could use', text: 'could use', meaningKo: '기존 뜻', sourceRefs: [], isFavorite: true, isMarkedDifficult: false };
    await db.expressions.add(oldExpr);
    const { client, gemini } = serverClient();
    await generateContent({ ...deps(db, client), newId: uuid }, 'v11', () => {});
    expect(await db.keySentences.get('ks-user')).toEqual(userSentence);
    expect(await db.expressions.get('ex-old')).toEqual(oldExpr);
    const ai = await db.keySentences.where('videoId').equals('v11').filter((s) => s.origin === 'ai_extracted').toArray();
    expect(ai).toHaveLength(3); // 1번은 기존 문장과 같아 새로 만들지 않음
    expect(new Set([1, ...ai.map((s) => s.order)]).size).toBe(4); // 순서 충돌 없음
    const could = await db.learningItems.where('expressionId').equals('ex-old').toArray();
    expect(could).toHaveLength(1);
    expect(could[0].sentenceId).toBe('ks-user');
    const again = await generateContent({ ...deps(db, client), newId: uuid }, 'v11', () => {});
    expect(again.phase).toBe('already');
    expect(gemini.createCalls).toHaveLength(1);
  });

  it('Day 1~100 영상: 표시 없는(자동·예전 앱) 문장·Chunk 요청은 서버가 Gemini 없이 거절 (day_manual_only)', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'v11', '[Day 11] 필요해', DAY11);
    const { client, gemini } = serverClient(false);
    const out = await generateContent({ ...deps(db, client), newId: uuid }, 'v11', () => {});
    expect(out).toMatchObject({ phase: 'failed', code: 'day_manual_only', httpStatus: 409 });
    expect(gemini.createCalls).toHaveLength(0);
    expect(await db.keySentences.count()).toBe(0);
    // Day 101 이상은 일반 영상 → 자동 요청도 그대로 진행
    await seedVideo(db, 'v101', '[Day 101] 일반', DAY11);
    expect(await generateContent({ ...deps(db, client), newId: uuid }, 'v101', () => {})).toMatchObject({ phase: 'succeeded' });
    expect(gemini.createCalls).toEqual(['content:v101xxxxxxx']);
  });

  it('일반 영상은 번호 대신 맥락으로 고른다 (general 요청)', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'g1', 'How to small talk at work', ['So yeah, it was no big deal.', 'We need to catch up soon.', 'The office is in Seoul.']);
    const { client, sent } = serverClient();
    const out = await generateContent({ ...deps(db, client), newId: uuid }, 'g1', () => {});
    expect(sent[0].body).toMatchObject({ task: 'content', seriesKind: 'general', dayNumber: null });
    expect(out).toMatchObject({ phase: 'succeeded', sentences: 2 });
    const items = await db.learningItems.toArray();
    expect(items.every((i) => i.sourceType === 'other' && i.dayNumber === null)).toBe(true);
  });

  it('자막이 없으면 요청하지 않는다 / 실패하면 HTTP 상태와 코드', async () => {
    const { db } = createTestRepos();
    await db.videos.add({ id: 'n1', createdAt: T, updatedAt: T, playlistId: null, youtubeVideoId: 'n1xxxxxxxxx', title: 'x', url: null, thumbnailUrl: null, durationSec: 100, orderIndex: 0, randomOrderKey: 0, status: 'new', completedAt: null, sources: [], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
    const { client, sent } = serverClient();
    expect(await generateContent(deps(db, client), 'n1', () => {})).toMatchObject({ phase: 'failed', code: 'no_transcript' });
    expect(sent).toHaveLength(0);
    await seedVideo(db, 'mockBad1', '[Day 2] bad', DAY11);
    const r = await generateContent({ ...deps(db, client), newId: uuid }, 'mockBad1', () => {});
    expect(r).toMatchObject({ phase: 'failed', httpStatus: 502, code: 'gemini_rejected' });
  });

  it('응답 검사: 문장에 없는 Chunk·중복 문장은 빼고, 영상 길이를 넘는 시각은 비움', () => {
    const v = validateContent(JSON.stringify({ sentences: [
      { number: 1, text: 'I could use a break.', meaningKo: '', timestampSec: 999, chunks: [{ text: 'could use', meaningKo: '' }, { text: 'made up', meaningKo: '' }, { text: 'I could use a break.', meaningKo: '' }] },
      { number: 2, text: 'i could use a break', meaningKo: '', timestampSec: 1, chunks: [] },
    ], notes: '' }), 300);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.result.sentences).toHaveLength(1);
    expect(v.result.sentences[0].timestampSec).toBeNull();
    expect(v.result.sentences[0].chunks.map((c) => c.text)).toEqual(['could use']);
    expect(v.issues.length).toBeGreaterThan(0);
  });

  it('선택 표시: AI 문장·Chunk의 selected만 바뀐다', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'v11', '[Day 11] x', DAY11);
    const { client } = serverClient();
    await generateContent({ ...deps(db, client), newId: uuid }, 'v11', () => {});
    const store = createContentStore(db);
    const s = (await db.keySentences.toArray())[0];
    const c = (await db.learningItems.toArray())[0];
    await store.setSentenceSelected(s.id, true);
    await store.setChunkSelected(c.id, true);
    expect((await db.keySentences.get(s.id))).toEqual({ ...s, selected: true });
    expect((await db.learningItems.get(c.id))).toEqual({ ...c, selected: true });
  });
});

describe('통합 대화문: 여러 Day의 Chunk', () => {
  async function seedThreeDays(db: StudyDatabase, client: AiClient) {
    await seedVideo(db, 'v11', '[Day 11] a', ['1. I could use a little break right now.'], 'completed', '2026-11-10T00:00:00.000Z');
    await seedVideo(db, 'v12', '[Day 12] b', ['1. That sounds like a good idea.'], 'in_progress', '2026-11-12T00:00:00.000Z');
    await seedVideo(db, 'v13', '[Day 13] c', ['1. Let me figure out what to do.'], 'in_progress', '2026-11-14T00:00:00.000Z');
    await seedVideo(db, 'v05', '[Day 5] old', ['1. We should catch up soon.'], 'new');
    for (const v of ['v11', 'v12', 'v13', 'v05']) await generateContent({ ...deps(db, client), newId: uuid }, v, () => {});
  }

  it('기본 추천: 최근 학습한 Day 3개, 미리 체크는 학습함·선택함만', async () => {
    const { db } = createTestRepos();
    const { client } = serverClient();
    await seedThreeDays(db, client);
    const store = createContentStore(db);
    const could = (await db.expressions.where('normalizedKey').equals('could use').first())!;
    await db.reviewStates.add({ id: `expression:${could.id}`, itemType: 'expression', itemId: could.id } as never);
    const sounds = (await db.learningItems.toArray()).find((i) => i.sourceText?.includes('sounds like'))!;
    await store.setChunkSelected(sounds.id, true);
    const groups = buildCandidateGroups(await store.readCombine());
    expect(groups.map((g) => g.label)).toEqual(['Day 5', 'Day 11', 'Day 12', 'Day 13']);
    const rec = recommendGroups(groups);
    expect(rec).toEqual(['day-13', 'day-12', 'day-11']);
    const checked = defaultChecked(groups, rec);
    const texts = groups.flatMap((g) => g.chunks).filter((c) => checked.includes(c.item.id)).map((c) => c.expression.text).sort();
    expect(texts).toEqual(['could use', 'sounds like']);
  });

  it('생성: 고른 Chunk만 보내고, 실제로 쓴 Chunk와 출처 Day를 기록 (안 쓴 것은 사용으로 표시 안 함), 기존 대화문 보존', async () => {
    const { db } = createTestRepos();
    const { client, gemini, sent } = serverClient();
    await seedThreeDays(db, client);
    await db.dialogues.add({ id: 'dlg-old', createdAt: T, updatedAt: T, kind: 'original', videoId: 'v11', sourceVideoIds: [], orderInVideo: 1, title: '기존', situation: '', lines: [], expressionIds: [], generatedBy: 'manual', isFavorite: true });
    const store = createContentStore(db);
    const groups = buildCandidateGroups(await store.readCombine());
    const pick = groups.filter((g) => ['day-11', 'day-12', 'day-13'].includes(g.key)).flatMap((g) => g.chunks.slice(0, 1).map((c) => c.item.id));
    const req = buildDialogueRequest(groups, pick, 8);
    if ('error' in req) throw new Error(req.error);
    expect(req.chunks.map((c) => c.source)).toEqual(['Day 11', 'Day 12', 'Day 13']);
    const out = await generateCombinedDialogue({ store, client, newId: uuid, sleep: async () => {}, now: () => new Date(T) }, req, () => {});
    expect(out).toMatchObject({ phase: 'succeeded' });
    if (out.phase !== 'succeeded') return;
    expect(gemini.createCalls.filter((c) => c === 'dialogue')).toHaveLength(1);
    expect(sent.filter((s) => s.body.task === 'dialogue').every((s) => s.key === sent.find((x) => x.body.task === 'dialogue')!.key)).toBe(true);
    // '대화문 만들기'는 사용자가 누른 작업 → 사용자 표시
    expect(sent.filter((s) => s.body.task === 'dialogue').every((s) => (s.body as { origin?: string }).origin === 'user')).toBe(true);
    const d = (await db.dialogues.get(out.dialogueId))!;
    expect(d.kind).toBe('combined');
    expect(d.sourceDays).toEqual([11, 12]); // 가짜 Gemini는 마지막 Chunk를 쓰지 않음
    expect(d.unusedLearningItemIds).toEqual([pick[2]]);
    expect(d.chunkUsages!.map((u) => u.learningItemId)).toEqual(pick.slice(0, 2));
    expect(d.chunkUsages!.every((u) => u.meaningInContext && u.nuance && u.whyUsed && u.example.en)).toBe(true);
    const keySegs = d.lines.flatMap((l) => l.segments).filter((s) => s.kind === 'key');
    expect(keySegs.map((s) => s.learningItemId)).toEqual(pick.slice(0, 2));
    expect(d.lines.every((l) => l.korean)).toBe(true);
    expect(await db.dialogues.get('dlg-old')).toMatchObject({ title: '기존', isFavorite: true });
    expect(await store.getTask(DIALOGUE_TASK_KEY)).toBeNull();
  });

  it('응답 검사: 목록에 없는 ref·대사에 없는 Chunk는 사용한 것으로 표시하지 않음', () => {
    const groups = [{ key: 'day-1', label: 'Day 1', dayNumber: 1, videoIds: ['v'], lastStudiedAt: null, chunks: [
      { item: { id: 'a', videoId: 'v' }, expression: { id: 'ea', text: 'could use', meaningKo: '' }, sentence: null, learned: true, selected: false },
      { item: { id: 'b', videoId: 'v' }, expression: { id: 'eb', text: 'figure out', meaningKo: '' }, sentence: null, learned: true, selected: false },
    ] }] as never;
    const req = { task: 'dialogue' as const, chunks: [{ ref: 'a', text: 'could use', meaningKo: '', day: 1, source: 'Day 1' }, { ref: 'b', text: 'figure out', meaningKo: '', day: 1, source: 'Day 1' }], lineCount: 6, promptVersion: 'd1' };
    const res = buildDialogueRecord(JSON.stringify({ title: 't', situation: 's', lines: [{ speaker: 'A', en: 'I could really use a coffee.', ko: '커피 마시고 싶다.', chunkRefs: ['a', 'zzz'] }, { speaker: 'B', en: 'Me too.', ko: '나도.', chunkRefs: ['b'] }], chunkNotes: [{ ref: 'a', usedAs: 'could really use', meaningInContext: 'm', nuance: 'n', whyUsed: 'w', example: { en: 'e', ko: 'k' } }, { ref: 'b', usedAs: 'figure out', meaningInContext: '', nuance: '', whyUsed: '', example: { en: '', ko: '' } }], unusedRefs: [], notes: '' }), req, groups, 'r1', T);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.dialogue.chunkUsages!.map((u) => u.learningItemId)).toEqual(['a']);
    expect(res.dialogue.unusedLearningItemIds).toEqual(['b']);
    expect(res.issues.join(' ')).toContain('figure out');
    expect(res.dialogue.lines[0].segments).toEqual([{ kind: 'connector', text: 'I' }, { kind: 'key', text: 'could really use', learningItemId: 'a' }, { kind: 'connector', text: 'a coffee.' }]);
  });

  it('segmentLine: 겹치지 않게 여러 Chunk 표시', () => {
    expect(segmentLine('Sounds like you could use a break.', [{ learningItemId: 'x', usedAs: 'could use' }, { learningItemId: 'y', usedAs: 'sounds like' }]).map((s) => s.kind)).toEqual(['key', 'connector', 'key', 'connector']);
  });
});
