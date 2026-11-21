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
import { createPrepController } from '@/services/prep/prepController';
import { containsVerbatim } from '@/services/prep/packService';
import { includedDaySentences, originalCandidatesOf } from './daySeries';
import { dayUserRecordOf, dayViewOf } from './dayView';

/**
 * Day 1~100 자료 재료 = 영상 원문 후보(예전에 AI가 자막에서 찾은 번호 문장, 번호순, 기본 포함)
 *                    + 사용자가 직접 입력하거나 자막에서 고른 문장 − 뺀 문장, 같은 문장은 한 번만.
 * 원문 후보가 없으면 사용자 문장만 (후보를 새로 만들지 않음). 포함한 문장은 모두 원문 그대로 대화문에.
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

const ks = (id: string, order: number, english: string, origin: KeySentence['origin'], extra: Partial<KeySentence> = {}): KeySentence => ({
  id, createdAt: T, updatedAt: T, videoId: 'd2', order, english, korean: '', expressionIds: [], situation: '', timestampSec: null, status: 'not_started', correctCount: 0, wrongCount: 0, origin, ...extra,
});
const ORIGINAL = ['I could use a break.', 'That sounds like a good idea.', 'Let me figure out what to do.', 'We should catch up soon.', 'I am running late again.'];

/** Day 2: 영상 원문 후보 5개(번호 순서를 섞어 저장, 1번은 학습 기록 있음) + 사용자 문장 */
async function seed(db: StudyDatabase, user: KeySentence[] = [], candidates = true) {
  await db.videos.add({ id: 'd2', createdAt: T, updatedAt: T, playlistId: null, youtubeVideoId: 'dayTwoCand1', title: '[Day 2] 원문 후보', url: null, thumbnailUrl: null, durationSec: 300, orderIndex: 0, randomOrderKey: 0.1, status: 'new', completedAt: null, sources: [{ kind: 'manual', addedAt: T }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
  const rows: KeySentence[] = candidates
    ? [4, 2, 5, 1, 3].map((n) => ks(`c${n}`, 100 + n, ORIGINAL[n - 1], 'ai_extracted', { aiNumber: n, contentRequestId: 'oldreq', ...(n === 1 ? { status: 'learning', correctCount: 3 } : {}) }))
    : [];
  await db.keySentences.bulkAdd([...rows, ...user]);
  if (candidates) await db.reviewStates.add({ id: 'sentence:c1', createdAt: T, updatedAt: T, itemType: 'sentence', itemId: 'c1' } as never);
  return [...rows, ...user];
}
const lineText = (l: { segments: { text: string }[] }) => l.segments.map((s) => s.text).join(' ');

describe('Day 자료 재료: 영상 원문 후보 + 사용자 문장', () => {
  it('원문 후보 5개(번호순) + 사용자 문장 2개 → 요청 7개, 모두 원문 그대로 대화문에 들어가고 출처로 연결 · 문장·학습·복습 기록 그대로', async () => {
    const { db } = createTestRepos();
    const all = await seed(db, [ks('u1', 1, 'No big deal at all.', 'manual'), ks('u2', 2, 'Can you make it tonight?', 'transcript')]);
    const reviewBefore = await db.reviewStates.toArray();
    const { pc, sent } = setup(db);
    await pc.refresh();
    expect(pc.getSnapshot().rows.find((r) => r.video.id === 'd2')).toMatchObject({ series: 'day', status: 'not_queued', daySentences: 7 });
    await pc.makeDay('d2');
    await pc.start();
    const body = sent.find((b) => b.task === 'daypack') as AiDayPackRequest;
    expect(body.sentences.map((s) => [s.number, s.text])).toEqual([...ORIGINAL.map((t, i) => [i + 1, t]), [6, 'No big deal at all.'], [7, 'Can you make it tonight?']]);
    const d = (await db.dialogues.where('videoId').equals('d2').first())!;
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5', 'u1', 'u2']) {
      const s = all.find((x) => x.id === id)!;
      const line = d.lines.find((l) => l.sourceSentenceId === id);
      expect(line, id).toBeTruthy();
      expect(containsVerbatim(lineText(line!), s.english)).toBe(true);
    }
    for (const s of all) expect(await db.keySentences.get(s.id)).toEqual(s);
    expect(await db.reviewStates.toArray()).toEqual(reviewBefore);
    expect(await db.keySentences.where('videoId').equals('d2').count()).toBe(7);
  });

  it('원문 후보 중 뺀 문장은 요청·대화문에 넣지 않고, 다시 넣으면 포함', async () => {
    const { db } = createTestRepos();
    await seed(db, [ks('u1', 1, 'No big deal at all.', 'manual')]);
    const { pc, sent } = setup(db);
    expect(await pc.setDayExcluded('d2', 'c3', true)).toBe('ok');
    expect(await pc.setDayExcluded('d2', 'c5', true)).toBe('ok');
    expect(await pc.setDayExcluded('d2', 'c5', false)).toBe('ok');
    await pc.makeDay('d2');
    await pc.start();
    const body = sent.find((b) => b.task === 'daypack') as AiDayPackRequest;
    expect(body.sentences.map((s) => s.text)).toEqual([ORIGINAL[0], ORIGINAL[1], ORIGINAL[3], ORIGINAL[4], 'No big deal at all.']);
    const d = (await db.dialogues.where('videoId').equals('d2').first())!;
    expect(d.lines.some((l) => l.sourceSentenceId === 'c3')).toBe(false);
    expect(new Set(d.lines.map((l) => l.sourceSentenceId).filter(Boolean))).toEqual(new Set(['c1', 'c2', 'c4', 'c5', 'u1']));
    expect(await db.keySentences.get('c3')).toBeTruthy();
  });

  it('같은 문장은 한 번만: 사용자 문장이 원문 후보와 같으면(대소문자·공백 무시) 원문 후보 자리에 한 번 · 후보를 빼면 사용자 문장이 쓰임', () => {
    const list = [
      ks('c1', 101, 'I could use a break.', 'ai_extracted', { aiNumber: 1 }),
      ks('c1dup', 103, 'I could  use a break.', 'ai_extracted', { aiNumber: 1 }),
      ks('c2', 102, 'We should catch up soon.', 'ai_extracted', { aiNumber: 2 }),
      ks('u1', 1, 'i could use a BREAK.', 'manual'),
      ks('u2', 2, 'Can you make it tonight?', 'transcript'),
    ];
    expect(originalCandidatesOf(list).map((s) => s.id)).toEqual(['c1', 'c2']);
    expect(includedDaySentences(list, new Set()).map((s) => s.id)).toEqual(['c1', 'c2', 'u2']);
    expect(includedDaySentences(list, new Set(['c1'])).map((s) => s.id)).toEqual(['c2', 'u1', 'u2']);
  });

  it('회귀: 원문 후보를 빼고 똑같은 문장을 사용자가 넣으면, 화면 번호·원문 출처가 사용자 문장에 연결 (뺀 후보는 번호 없음)', async () => {
    const { db } = createTestRepos();
    // 사용자 문장 u3은 원문 후보 c3과 글자까지 같음
    await seed(db, [ks('u1', 1, 'No big deal at all.', 'manual'), ks('u3', 2, ORIGINAL[2], 'manual')]);
    const { pc, sent } = setup(db);
    expect(await pc.setDayExcluded('d2', 'c3', true)).toBe('ok');
    await pc.makeDay('d2');
    await pc.start();
    const body = sent.find((b) => b.task === 'daypack') as AiDayPackRequest;
    // 요청: c1 c2 c4 c5 → u1 → u3 (c3 대신 사용자 문장이 쓰임, 한 번만)
    expect(body.sentences.map((s) => [s.number, s.text])).toEqual([[1, ORIGINAL[0]], [2, ORIGINAL[1]], [3, ORIGINAL[3]], [4, ORIGINAL[4]], [5, 'No big deal at all.'], [6, ORIGINAL[2]]]);
    const store = createContentStore(db);
    const [sentences, items, dialogues, task, excluded] = await Promise.all([
      db.keySentences.where('videoId').equals('d2').toArray(),
      db.learningItems.where('videoId').equals('d2').toArray(),
      db.dialogues.where('videoId').equals('d2').toArray(),
      store.getTask('dayuser:d2'),
      store.getDayExcluded('d2'),
    ]);
    const v = dayViewOf(sentences, items, dialogues, dayUserRecordOf(task), excluded);
    expect(v.mode).toBe('user');
    expect([...v.numbering.entries()]).toEqual([['c1', 1], ['c2', 2], ['c4', 3], ['c5', 4], ['u1', 5], ['u3', 6]]);
    expect(v.numbering.has('c3')).toBe(false);
    // 대화 줄의 원문 출처도 사용자 문장 u3 (화면의 '원문 문장 연결'이 '대화에 쓰지 않음'으로 잘못 보이지 않음)
    const d = dialogues.find((x) => x.generatedBy === 'ai')!;
    expect(d.lines.some((l) => l.sourceSentenceId === 'u3')).toBe(true);
    expect(d.lines.some((l) => l.sourceSentenceId === 'c3')).toBe(false);
    for (const id of v.numbering.keys()) expect(d.lines.some((l) => l.sourceSentenceId === id), id).toBe(true);
  });

  it('원문 후보가 없는 영상: 사용자 문장만 (후보를 새로 만들지 않음) · 번호 없는 AI 문장은 쓰지 않음', async () => {
    const { db } = createTestRepos();
    await seed(db, [ks('u1', 1, 'No big deal at all.', 'manual'), ks('ai-no-number', 50, 'Some AI sentence.', 'ai_extracted')], false);
    const { pc, sent } = setup(db);
    await pc.makeDay('d2');
    await pc.start();
    const body = sent.find((b) => b.task === 'daypack') as AiDayPackRequest;
    expect(body.sentences.map((s) => s.text)).toEqual(['No big deal at all.']);
    expect(await db.keySentences.where('videoId').equals('d2').count()).toBe(2);
  });

  it('원문 후보도 없고 사용자 문장도 없으면 요청하지 않음', async () => {
    const { db } = createTestRepos();
    await seed(db, [], false);
    const { pc, gemini } = setup(db);
    await pc.makeDay('d2');
    await pc.start();
    expect(gemini.createCalls).toEqual([]);
    expect(pc.getSnapshot().rows.find((r) => r.video.id === 'd2')?.failure?.error.code).toBe('day_sentences');
  });

  it('이미 Day 자료가 있으면(예전 방식으로 만든 자료 포함) 원문 후보가 있어도 다시 만들거나 바꾸지 않음', async () => {
    const { db } = createTestRepos();
    await seed(db, [ks('u1', 1, 'No big deal at all.', 'manual')]);
    const old = { id: 'dlg-day-oldreq', createdAt: T, updatedAt: T, kind: 'original' as const, videoId: 'd2', sourceVideoIds: [], orderInVideo: 1, title: '예전 Day 2', situation: '', lines: [], expressionIds: [], generatedBy: 'ai' as const, isFavorite: true };
    await db.dialogues.add(old);
    const { pc, gemini } = setup(db);
    expect(await pc.makeDay('d2')).toBe(false);
    expect(await pc.setDayExcluded('d2', 'c1', true)).toBe('has_material');
    await pc.start();
    expect(gemini.createCalls).toEqual([]);
    expect(await db.dialogues.get('dlg-day-oldreq')).toEqual(old);
  });
});
