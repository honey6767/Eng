import { describe, expect, it } from 'vitest';
import type { StudyDatabase } from '@/db/database';
import { createContentStore } from '@/repositories/contentStore';
import { createExtractionStore } from '@/repositories/extractionStore';
import { createTestRepos } from '@/test/helpers';
import type { AiClient, AiTransportResult } from '@/services/integrations/aiClient';
import type { AiDayPackRequest, AiTaskRequest } from '@/types/aiApi';
import type { KeySentence } from '@/types/models';
import { DEFAULT_AI_CAPS, handleAiExtract } from '../../../server/ai/extractHandler';
import { memoryLedgerStore } from '../../../server/ai/ledger';
import { createMockGemini } from '../../../server/ai/mockGemini';
import { buildDayPackPrompt, buildPackPrompt, bodyHashSource, validateTaskRequest } from '../../../server/ai/tasks';
import { createPrepController } from './prepController';
import { containsVerbatim, validateDayPack } from './packService';

/**
 * Day 1~100 자료: 사용자가 고른 핵심 문장은 AI가 줄이거나 바꾸지 않고 모두 원문 그대로 통합 대화문에 들어가야 한다.
 * (일반 영상·예전 방식 자료 규칙은 그대로)
 */

const T = '2026-11-16T12:00:00.000Z';
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function setup(db: StudyDatabase) {
  const gemini = createMockGemini();
  const ledger = memoryLedgerStore();
  const sent: AiTaskRequest[] = [];
  const client: AiClient = {
    async extract(key, body): Promise<AiTransportResult> {
      sent.push(body);
      const r = await handleAiExtract({ idempotencyKey: key, body }, { store: ledger, gemini, caps: { ...DEFAULT_AI_CAPS, minGapMs: 0 }, now: () => Date.parse(T) });
      return { kind: 'response', httpStatus: r.status, body: r.body };
    },
  };
  const pc = createPrepController({ store: createContentStore(db), extraction: createExtractionStore(db), client, now: () => new Date(T), newId: uuid, sleep: async () => {}, pollMs: 1, extractPollMs: 1, withLock: async (fn) => (await fn(), true) });
  return { pc, gemini, sent };
}

const FIVE = ['I could use a cup of coffee.', 'We could really use some help here.', "That sounds like a plan, doesn't it?", 'Let me figure out what to do next.', 'I am running late again.'];

async function seedDay(db: StudyDatabase, yt: string, sentences = FIVE) {
  await db.videos.add({ id: 'd', createdAt: T, updatedAt: T, playlistId: null, youtubeVideoId: yt, title: '[Day 2] 다섯 문장', url: null, thumbnailUrl: null, durationSec: 300, orderIndex: 0, randomOrderKey: 0.1, status: 'new', completedAt: null, sources: [{ kind: 'manual', addedAt: T }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
  const rows: KeySentence[] = sentences.map((english, i) => ({ id: `u${i + 1}`, createdAt: T, updatedAt: T, videoId: 'd', order: i + 1, english, korean: '', expressionIds: [], situation: '', timestampSec: null, status: i === 0 ? 'learning' : 'not_started', correctCount: i === 0 ? 2 : 0, wrongCount: 0, origin: i % 2 ? 'manual' : 'transcript' }));
  await db.keySentences.bulkAdd(rows);
  return rows;
}

describe('Day 1~100: 고른 핵심 문장 전부 원문 그대로', () => {
  it('5개를 고르면 5개 모두 대화 줄에 원문 그대로 들어가고 각각 출처로 연결 (원문·학습 기록은 그대로)', async () => {
    const { db } = createTestRepos();
    const rows = await seedDay(db, 'dayFiveAll1');
    const { pc, sent } = setup(db);
    await pc.makeDay('d');
    await pc.start();
    const body = sent.find((b) => b.task === 'daypack') as AiDayPackRequest;
    expect(body.promptVersion).toBe('du1');
    expect('variant' in body).toBe(false);
    expect(body.sentences.map((s) => s.text)).toEqual(FIVE);
    const d = (await db.dialogues.where('videoId').equals('d').first())!;
    for (const r of rows) {
      const line = d.lines.find((l) => l.sourceSentenceId === r.id);
      expect(line, r.english).toBeTruthy();
      expect(containsVerbatim(line!.segments.map((s) => s.text).join(' '), r.english)).toBe(true);
    }
    for (const r of rows) expect(await db.keySentences.get(r.id)).toEqual(r);
  });

  it('선택 수가 5개가 아니어도 전부 (1개 · 8개)', async () => {
    for (const list of [FIVE.slice(0, 1), [...FIVE, 'No big deal at all.', 'Can you make it tonight?', 'We should catch up soon.']]) {
      const { db } = createTestRepos();
      await seedDay(db, `dayCount${String(list.length).padStart(3, '0')}`, list);
      const { pc } = setup(db);
      await pc.makeDay('d');
      await pc.start();
      const d = (await db.dialogues.where('videoId').equals('d').first())!;
      expect(new Set(d.lines.map((l) => l.sourceSentenceId).filter(Boolean)).size).toBe(list.length);
    }
  });

  it('AI가 문장을 빠뜨리면 저장하지 않고 빠진 번호를 알림 → 다시 누르면 같은 문장으로 새로 생성(variant 2)해 5개 모두 반영', async () => {
    const { db } = createTestRepos();
    const rows = await seedDay(db, 'mockDropD05');
    const { pc, gemini, sent } = setup(db);
    await pc.makeDay('d');
    await pc.start();
    expect(await db.dialogues.where('videoId').equals('d').count()).toBe(0);
    const fail = pc.getSnapshot().rows.find((r) => r.video.id === 'd')!.failure!;
    expect(fail.error.code).toBe('invalid_result');
    expect(fail.error.message).toContain('3, 4, 5번');
    expect(fail.error.message).toContain('다시 만들기');
    for (const r of rows) expect(await db.keySentences.get(r.id)).toEqual(r);
    await pc.makeDay('d');
    await pc.start();
    expect(gemini.createCalls).toEqual(['daypack:mockDropD05', 'daypack:mockDropD05']);
    const bodies = sent.filter((b) => b.task === 'daypack') as AiDayPackRequest[];
    expect(bodies.at(-1)!.variant).toBe(2);
    const d = (await db.dialogues.where('videoId').equals('d').first())!;
    expect(new Set(d.lines.map((l) => l.sourceSentenceId).filter(Boolean))).toEqual(new Set(rows.map((r) => r.id)));
  });

  it('AI가 원문 표현을 바꾸면 저장하지 않음', async () => {
    const { db } = createTestRepos();
    await seedDay(db, 'mockAlterD5');
    const { pc } = setup(db);
    await pc.makeDay('d');
    await pc.start();
    expect(await db.dialogues.where('videoId').equals('d').count()).toBe(0);
    expect(pc.getSnapshot().rows.find((r) => r.video.id === 'd')!.failure!.error.message).toContain('3번');
  });

  it('검사: 앞뒤 짧은 말·대소문자·구두점 차이는 허용, 단어가 바뀌면 거절, 출처 번호를 빠뜨린 줄은 원문이 있으면 연결', () => {
    expect(containsVerbatim("Honestly, i could use a cup of coffee!", 'I could use a cup of coffee.')).toBe(true);
    expect(containsVerbatim('That sounds like a plan, doesn’t it? Totally.', "That sounds like a plan, doesn't it?")).toBe(true);
    expect(containsVerbatim('I could really use a cup of coffee.', 'I could use a cup of coffee.')).toBe(false);
    expect(containsVerbatim('I might use a cup of coffee.', 'I could use a cup of coffee.')).toBe(false);
    const result = (lines: { en: string; n: number }[]) => JSON.stringify({ coreChunks: [], extraChunks: [], dialogue: { title: 't', situation: 's', lines: lines.map((l, i) => ({ speaker: i % 2 ? 'B' : 'A', en: l.en, ko: '뜻', sourceSentenceNumber: l.n, chunkTexts: [] })), chunkNotes: [] }, notes: '' });
    const two = [{ number: 1, text: 'I could use a break.' }, { number: 2, text: 'No big deal.' }];
    const v = validateDayPack(result([{ en: 'Wow, I could use a break.', n: 0 }, { en: 'No big deal.', n: 2 }, { en: 'Right?', n: 0 }]), two, { requireAll: true });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.pack.lines[0].sourceNumber).toBe(1);
    const miss = validateDayPack(result([{ en: 'I could use a break.', n: 1 }, { en: 'Sure.', n: 0 }]), two, { requireAll: true });
    expect(miss).toMatchObject({ ok: false });
    if (!miss.ok) expect(miss.error).toContain('2번');
    // 예전 방식(일반 영상 daypack)은 검사하지 않음 (기존 규칙 그대로)
    expect(validateDayPack(result([{ en: 'I could use a break.', n: 1 }, { en: 'Sure.', n: 0 }]), two).ok).toBe(true);
  });

  it('프롬프트: Day 1~100에만 "고른 n개 모두 원문 그대로·나열하지 않음" 규칙과 늘어난 줄 수, 일반 영상·pack 프롬프트는 그대로', () => {
    const base = { task: 'daypack' as const, videoId: 'dayFiveAll1', title: '[Day 2] x', sentences: FIVE.map((text, i) => ({ number: i + 1, text, meaningKo: '', chunks: [] })), promptVersion: 'du1' };
    const day = buildDayPackPrompt({ ...base, seriesKind: 'day', dayNumber: 2 });
    expect(day).toContain('5개 모두 빠짐없이');
    expect(day).toContain('원문 그대로');
    expect(day).toContain('나열하지 않습니다');
    expect(day).toContain('9~14줄');
    expect(day).not.toContain('원문 문장을 그대로 넣어도 되고');
    const twenty = buildDayPackPrompt({ ...base, seriesKind: 'day', dayNumber: 2, sentences: Array.from({ length: 20 }, (_, i) => ({ number: i + 1, text: `Sentence ${i}.`, meaningKo: '', chunks: [] })) });
    expect(twenty).toContain('24~30줄');
    const general = buildDayPackPrompt({ ...base, seriesKind: 'general', dayNumber: null, promptVersion: 'dp5' });
    expect(general).toContain('원문 문장을 그대로 넣어도 되고');
    expect(general).toContain('8~14줄');
    expect(general).not.toContain('빠짐없이');
    expect(buildPackPrompt({ task: 'pack', videoId: 'dayFiveAll1', title: 'x', seriesKind: 'day', dayNumber: 2, transcript: 'a'.repeat(30), promptVersion: 'p5' })).toContain('8~14줄');
  });

  it('서버: variant 2~99만 받고, variant 없는 예전 요청은 작업 키가 그대로', () => {
    const body = { task: 'daypack', videoId: 'dayFiveAll1', title: 't', seriesKind: 'day', dayNumber: 2, sentences: [{ number: 1, text: 'Hi there.', meaningKo: '', chunks: [] }], promptVersion: 'dp5' };
    const old = validateTaskRequest(body)!;
    expect('variant' in old).toBe(false);
    expect(bodyHashSource(old)).toBe(JSON.stringify({ task: 'daypack', videoId: 'dayFiveAll1', title: 't', seriesKind: 'day', dayNumber: 2, sentences: [{ number: 1, text: 'Hi there.', meaningKo: '', chunks: [] }], promptVersion: 'dp5' }));
    expect(validateTaskRequest({ ...body, variant: 2 })).toMatchObject({ variant: 2 });
    expect(validateTaskRequest({ ...body, variant: 1 })).toBeNull();
    expect(validateTaskRequest({ ...body, variant: 100 })).toBeNull();
  });
});
