import { describe, expect, it } from 'vitest';
import type { StudyDatabase } from '@/db/database';
import { createContentStore, META_AI_TASKS } from '@/repositories/contentStore';
import { createExtractionStore } from '@/repositories/extractionStore';
import { createTestRepos } from '@/test/helpers';
import type { AiClient, AiTransportResult } from '@/services/integrations/aiClient';
import type { KeySentence } from '@/types/models';
import { DEFAULT_AI_CAPS, handleAiExtract } from '../../../server/ai/extractHandler';
import { memoryLedgerStore } from '../../../server/ai/ledger';
import { createMockGemini } from '../../../server/ai/mockGemini';
import { createPrepController } from '@/services/prep/prepController';
import { dayUserRecordOf, dayViewOf } from './dayView';

/**
 * Day 화면 구성·문장 번호가 기존 저장 데이터와 호환되는지
 * - 예전 방식(pack·daypack) Day 자료는 실제 예전 처리 흐름으로 만든 데이터(일반 제목으로 만든 뒤 Day 1~100 제목으로 바꿈)
 * - 요청 기록은 appMeta 'aiTasks' 그대로 (새 키 'dayuser:<영상>'만 새로 생김, 기존 'pack:'·'daypack:' 기록은 읽지 않음)
 */

const T = '2026-11-16T12:00:00.000Z';
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function setup() {
  const { db, repos } = createTestRepos();
  const gemini = createMockGemini();
  const ledger = memoryLedgerStore();
  const client: AiClient = {
    async extract(key, body): Promise<AiTransportResult> {
      const r = await handleAiExtract({ idempotencyKey: key, body }, { store: ledger, gemini, caps: { ...DEFAULT_AI_CAPS, minGapMs: 0 }, now: () => Date.parse(T) });
      return { kind: 'response', httpStatus: r.status, body: r.body };
    },
  };
  const pc = createPrepController({ store: createContentStore(db), extraction: createExtractionStore(db), client, now: () => new Date(T), newId: uuid, sleep: async () => {}, pollMs: 1, extractPollMs: 1, withLock: async (fn) => (await fn(), true) });
  return { db, repos, pc, store: createContentStore(db) };
}

async function seedVideo(db: StudyDatabase, id: string, title: string, transcript?: string[]) {
  await db.videos.add({ id, createdAt: T, updatedAt: T, playlistId: null, youtubeVideoId: `${id}xxxxxxxxxxx`.slice(0, 11), title, url: null, thumbnailUrl: null, durationSec: 300, orderIndex: 0, randomOrderKey: 0.1, status: 'new', completedAt: null, sources: [{ kind: 'manual', addedAt: T }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
  if (transcript) await db.transcripts.add({ id: `tr-${id}`, createdAt: T, updatedAt: T, videoId: id, source: 'manual_paste', status: 'success', rawText: transcript.join('\n'), segments: transcript.map((text, i) => ({ startSec: i * 10, endSec: i * 10 + 9, text })), format: 'timestamped' });
}
const ks = (id: string, videoId: string, order: number, english: string, origin: KeySentence['origin'], extra: Partial<KeySentence> = {}): KeySentence => ({
  id, createdAt: T, updatedAt: T, videoId, order, english, korean: '', expressionIds: [], situation: '', timestampSec: null, status: 'not_started', correctCount: 0, wrongCount: 0, origin, ...extra,
});

async function view(db: StudyDatabase, videoId: string) {
  const store = createContentStore(db);
  const [sentences, items, dialogues, task, excluded] = await Promise.all([
    db.keySentences.where('videoId').equals(videoId).toArray(),
    db.learningItems.where('videoId').equals(videoId).toArray(),
    db.dialogues.where('videoId').equals(videoId).toArray(),
    store.getTask(`dayuser:${videoId}`),
    store.getDayExcluded(videoId),
  ]);
  return dayViewOf(sentences, items, dialogues, dayUserRecordOf(task), excluded);
}

const TRANSCRIPT = ['Welcome.', '1. I could use a break.', '2. You could use some rest.', '3. That sounds like a plan.'];

describe('기존 Day 자료와 호환', () => {
  it('예전 pack 방식 Day 자료(실제 처리 흐름으로 만든 것): 예전 화면 그대로, 번호·문장 그대로, dayuser 기록 없음', async () => {
    const { db, pc } = setup();
    await seedVideo(db, 'p1', '[Day 111] 예전 방식', TRANSCRIPT);
    await pc.enqueue(['p1']);
    await pc.start();
    await db.videos.update('p1', { title: '[Day 11] 예전 방식' }); // 운영의 예전 Day 11 자료와 같은 모양
    const before = await db.keySentences.where('videoId').equals('p1').toArray();
    const tasks = (await db.appMeta.get(META_AI_TASKS))?.value as Record<string, unknown>;
    expect(Object.keys(tasks).some((k) => k.startsWith('pack:'))).toBe(true);
    expect(Object.keys(tasks).some((k) => k.startsWith('dayuser:'))).toBe(false);
    const v = await view(db, 'p1');
    expect(v.mode).toBe('old_ai');
    expect(v.hasMaterial).toBe(true);
    expect(v.userItems).toEqual([]);
    expect(v.oldItems.length).toBe((await db.learningItems.where('videoId').equals('p1').count()));
    // 화면 계산은 저장 데이터를 바꾸지 않음
    expect(await db.keySentences.where('videoId').equals('p1').toArray()).toEqual(before);
    await pc.refresh();
    expect(pc.getSnapshot().rows.find((r) => r.video.id === 'p1')).toMatchObject({ series: 'day', status: 'ready' });
  });

  it('예전 daypack 방식(이미 있던 AI 문장으로 만든) Day 자료: 예전 화면 그대로', async () => {
    const { db, pc } = setup();
    await seedVideo(db, 'q1', '[Day 112] 문장 있음', TRANSCRIPT);
    await db.keySentences.bulkAdd([ks('a1', 'q1', 101, 'I could use a break.', 'ai_extracted', { aiNumber: 1 }), ks('a2', 'q1', 102, 'You could use some rest.', 'ai_extracted', { aiNumber: 2 })]);
    await pc.enqueue(['q1']);
    await pc.start();
    await db.videos.update('q1', { title: '[Day 12] 문장 있음' });
    expect(Object.keys(((await db.appMeta.get(META_AI_TASKS))?.value ?? {}) as object)).toContain('daypack:q1');
    expect((await view(db, 'q1')).mode).toBe('old_ai');
  });

  it('연결 정보가 전혀 없는 예전 Day 대화문도 접지 않고 예전 화면 그대로 (애매하면 old_ai)', async () => {
    const { db } = setup();
    await seedVideo(db, 'r1', '[Day 13] 연결 없음');
    await db.keySentences.add(ks('ai-r', 'r1', 101, 'I could use a hand.', 'ai_extracted', { aiNumber: 1 }));
    await db.dialogues.add({ id: 'dlg-day-oldreq', createdAt: T, updatedAt: T, kind: 'original', videoId: 'r1', sourceVideoIds: [], orderInVideo: 1, title: '예전', situation: '', lines: [], expressionIds: [], generatedBy: 'ai', isFavorite: false });
    expect((await view(db, 'r1')).mode).toBe('old_ai');
  });
});

describe('Day 자료(영상 원문 후보 + 사용자 문장): 요청 때 번호 유지', () => {
  async function made(opts: { excludeCandidate?: boolean } = {}) {
    const s = setup();
    await seedVideo(s.db, 'd7', '[Day 7] 사용자 문장');
    await s.db.keySentences.bulkAdd([
      ks('ai1', 'd7', 101, 'I could use a break.', 'ai_extracted', { aiNumber: 1 }),
      ks('u1', 'd7', 1, 'I could use a cup of coffee.', 'transcript'),
      ks('u2', 'd7', 2, 'We could really use some help here.', 'manual'),
      ks('u3', 'd7', 3, 'That sounds like a plan.', 'manual'),
    ]);
    if (opts.excludeCandidate) await s.pc.setDayExcluded('d7', 'ai1', true);
    await s.pc.makeDay('d7');
    await s.pc.start();
    return s;
  }

  it('요청 기록(appMeta aiTasks의 dayuser 키)은 저장 뒤에도 보낸 문장을 그대로 갖고 있고, 화면 번호는 그 번호', async () => {
    const { db, store } = await made();
    const task = await store.getTask('dayuser:d7');
    expect(task).toMatchObject({ status: 'applied', resultText: null });
    const rec = dayUserRecordOf(task)!;
    expect(rec.sentences).toEqual([
      { number: 1, text: 'I could use a break.' },
      { number: 2, text: 'I could use a cup of coffee.' },
      { number: 3, text: 'We could really use some help here.' },
      { number: 4, text: 'That sounds like a plan.' },
    ]);
    expect((await db.dialogues.where('videoId').equals('d7').first())!.id).toBe(`dlg-day-${rec.requestId}`);
    const v = await view(db, 'd7');
    expect(v.mode).toBe('user');
    expect([...v.numbering.entries()]).toEqual([['ai1', 1], ['u1', 2], ['u2', 3], ['u3', 4]]);
    expect(v.candidates.map((s) => s.id)).toEqual(['ai1']);
  });

  it('자료를 만든 뒤 문장을 앞쪽 순서로 더하거나 연결 없는 문장을 빼도 자료의 번호는 그대로, 새 문장은 자료에 끼지 않음', async () => {
    const { db } = await made();
    await db.keySentences.add(ks('u0', 'd7', 0, 'Let me figure it out.', 'manual')); // 순서상 맨 앞
    await db.keySentences.add(ks('u9', 'd7', 9, 'Added later.', 'manual'));
    await db.keySentences.delete('u9'); // 연결 없는 문장 선정 취소
    const v = await view(db, 'd7');
    expect([...v.numbering.entries()]).toEqual([['ai1', 1], ['u1', 2], ['u2', 3], ['u3', 4]]);
    expect(v.numbering.has('u0')).toBe(false);
    expect(v.linkedIds.has('u0')).toBe(false);
  });

  it('요청 기록이 없을 때: 원문 후보를 쓴 자료는 예전 자료처럼 아무것도 접지 않고 보여 줌(안전), 사용자 문장만 쓴 자료는 연결로 알아보고 지금 순서로 번호', async () => {
    const withCandidate = await made();
    await withCandidate.store.putTask('dayuser:d7', null);
    expect((await view(withCandidate.db, 'd7')).mode).toBe('old_ai');
    const { db, store } = await made({ excludeCandidate: true });
    const task = (await store.getTask('dayuser:d7'))!;
    await store.putTask('dayuser:d7', null);
    let v = await view(db, 'd7');
    expect(v.mode).toBe('user');
    expect([...v.numbering.entries()]).toEqual([['u1', 1], ['u2', 2], ['u3', 3]]);
    // 다른 요청 식별자의 기록 (예: 다시 만들기 전에 실패했던 기록) → 번호에 쓰지 않음
    await store.putTask('dayuser:d7', { ...task, requestId: 'other-request', body: { ...task.body, sentences: [{ number: 1, text: 'That sounds like a plan.', meaningKo: '', chunks: [] }] } as never });
    v = await view(db, 'd7');
    expect(v.numbering.get('u3')).toBe(3);
  });

  it('dayUserRecordOf: 형식이 다른 기록은 무시 (예전 pack 기록 등)', () => {
    expect(dayUserRecordOf(null)).toBeNull();
    expect(dayUserRecordOf({ requestId: 'r', body: { task: 'pack', transcript: 'x' } })).toBeNull();
    expect(dayUserRecordOf({ requestId: 1, body: { task: 'daypack', sentences: [] } })).toBeNull();
    expect(dayUserRecordOf({ requestId: 'r', body: { task: 'daypack', sentences: [{ number: 1, text: 'a' }, { bad: true }] } })).toEqual({ requestId: 'r', sentences: [{ number: 1, text: 'a' }] });
  });
});
