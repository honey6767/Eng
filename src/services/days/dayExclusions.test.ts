import { describe, expect, it } from 'vitest';
import type { StudyDatabase } from '@/db/database';
import { CURRENT_SCHEMA_VERSION } from '@/db/migrations';
import { createContentStore } from '@/repositories/contentStore';
import { createExtractionStore } from '@/repositories/extractionStore';
import { createBackupStore, createSnapshotStore } from '@/repositories/backupStore';
import { createTestRepos } from '@/test/helpers';
import type { AiClient, AiTransportResult } from '@/services/integrations/aiClient';
import type { AiDayPackRequest, AiTaskRequest } from '@/types/aiApi';
import type { KeySentence } from '@/types/models';
import { DEFAULT_AI_CAPS, handleAiExtract } from '../../../server/ai/extractHandler';
import { memoryLedgerStore } from '../../../server/ai/ledger';
import { createMockGemini } from '../../../server/ai/mockGemini';
import { createPrepController } from '@/services/prep/prepController';
import { addKeySentence } from '@/services/keySentenceService';
import { applyRestore, buildBackupFile, createBackup, parseBackupText, previewRestore, serializeBackup } from '@/services/backup/backupService';
import { DAY_EXCLUSIONS_META_KEY, parseDayExclusions } from './daySeries';
import { dayViewOf } from './dayView';

/**
 * Day 자료에서 문장 빼기·다시 넣기 (appMeta 'dayExclusions')
 * - 문장·학습 기록·복습 기록은 그대로, 이 기록만 바뀐다 / DB 버전·테이블 그대로
 * - 뺀 문장은 AI 요청에서 완전히 빠진다 / 요청 대기·진행 중·자료 생성 뒤에는 바꿀 수 없다
 * - 백업·복원과 호환
 */

const T = '2026-11-16T12:00:00.000Z';
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function setup(db: StudyDatabase) {
  const gemini = createMockGemini();
  const ledger = memoryLedgerStore();
  const sent: { key: string; body: AiTaskRequest }[] = [];
  let before: ((body: AiTaskRequest) => Promise<void>) | null = null;
  const client: AiClient = {
    async extract(key, body): Promise<AiTransportResult> {
      sent.push({ key, body });
      if (before) await before(body);
      const r = await handleAiExtract({ idempotencyKey: key, body }, { store: ledger, gemini, caps: { ...DEFAULT_AI_CAPS, minGapMs: 0 }, now: () => Date.parse(T) });
      return { kind: 'response', httpStatus: r.status, body: r.body };
    },
  };
  const pc = createPrepController({ store: createContentStore(db), extraction: createExtractionStore(db), client, now: () => new Date(T), newId: uuid, sleep: async () => {}, pollMs: 1, extractPollMs: 1, withLock: async (fn) => (await fn(), true) });
  return { pc, gemini, sent, store: createContentStore(db), onSend: (fn: (body: AiTaskRequest) => Promise<void>) => (before = fn) };
}

async function seedVideo(db: StudyDatabase, id: string, title: string) {
  await db.videos.add({ id, createdAt: T, updatedAt: T, playlistId: null, youtubeVideoId: `${id}xxxxxxxxxxx`.slice(0, 11), title, url: null, thumbnailUrl: null, durationSec: 300, orderIndex: 0, randomOrderKey: 0.1, status: 'new', completedAt: null, sources: [{ kind: 'manual', addedAt: T }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
}
const ks = (id: string, videoId: string, order: number, english: string, origin: KeySentence['origin'], extra: Partial<KeySentence> = {}): KeySentence => ({
  id, createdAt: T, updatedAt: T, videoId, order, english, korean: '', expressionIds: [], situation: '', timestampSec: null, status: 'not_started', correctCount: 0, wrongCount: 0, origin, ...extra,
});
const LONG = `Long ${'word '.repeat(110)}end.`;

/** Day 15: 학습 기록·복습 기록이 있는 500자 초과 문장 + 일반 문장 2개 + 예전 AI 문장 */
async function seedStuck(db: StudyDatabase) {
  await seedVideo(db, 'x', '[Day 15] 긴 문장');
  await db.keySentences.bulkAdd([
    ks('xl', 'x', 1, LONG, 'manual', { status: 'learning', correctCount: 3, wrongCount: 1 }),
    ks('x2', 'x', 2, 'I could use a cup of coffee.', 'transcript'),
    ks('x3', 'x', 3, 'That sounds like a plan.', 'manual'),
    ks('xa', 'x', 101, 'AI sentence.', 'ai_extracted', { aiNumber: 1 }),
  ]);
  await db.reviewStates.add({ id: 'sentence:xl', createdAt: T, updatedAt: T, itemType: 'sentence', itemId: 'xl' } as never);
  await db.appMeta.put({ key: 'studyQueue', value: { cycle: 1, order: ['x'] } });
}
const snapshotOf = async (db: StudyDatabase) => ({
  sentences: await db.keySentences.toArray(),
  reviews: await db.reviewStates.toArray(),
  otherMeta: (await db.appMeta.toArray()).filter((m) => m.key !== DAY_EXCLUSIONS_META_KEY && m.key !== 'prepState' && m.key !== 'aiTasks'),
});

describe('Day 자료에서 뺀 문장', () => {
  it('빼기·다시 넣기: dayExclusions 기록만 바뀌고 문장·학습·복습 기록·다른 설정은 그대로 / AI 문장·다른 영상 문장은 거절', async () => {
    const { db } = createTestRepos();
    await seedStuck(db);
    const { pc, store } = setup(db);
    const before = await snapshotOf(db);
    expect(await pc.setDayExcluded('x', 'xl', true)).toBe('ok');
    expect((await db.appMeta.get(DAY_EXCLUSIONS_META_KEY))?.value).toEqual({ x: ['xl'] });
    expect([...(await store.getDayExcluded('x'))]).toEqual(['xl']);
    expect(await snapshotOf(db)).toEqual(before);
    expect(await pc.setDayExcluded('x', 'xl', false)).toBe('ok');
    expect((await db.appMeta.get(DAY_EXCLUSIONS_META_KEY))?.value).toEqual({});
    expect(await snapshotOf(db)).toEqual(before);
    expect(await pc.setDayExcluded('x', 'xa', true)).toBe('not_user_sentence');
    await seedVideo(db, 'y', '[Day 16] 다른 영상');
    expect(await pc.setDayExcluded('y', 'x2', true)).toBe('not_found');
    expect((await db.appMeta.get(DAY_EXCLUSIONS_META_KEY))?.value).toEqual({});
  });

  it('학습 기록 있는 500자 초과 문장을 빼면: 그 문장은 AI 요청에서 완전히 빠지고 나머지로 자료 생성 (원문·기록 그대로) / 다시 넣으면 다시 막힘', async () => {
    const { db } = createTestRepos();
    await seedStuck(db);
    const { pc, gemini, sent } = setup(db);
    // 다시 넣은 상태(뺀 문장 없음)에서는 막힘
    await pc.makeDay('x');
    await pc.start();
    expect(gemini.createCalls).toEqual([]);
    expect(pc.getSnapshot().rows.find((r) => r.video.id === 'x')?.failure?.error.message).toContain('Day 자료에서 빼기');
    const before = await snapshotOf(db);
    expect(await pc.setDayExcluded('x', 'xl', true)).toBe('ok');
    expect(pc.getSnapshot().rows.find((r) => r.video.id === 'x')?.daySentences).toBe(2);
    await pc.makeDay('x');
    await pc.start();
    expect(gemini.createCalls).toEqual(['daypack:xxxxxxxxxxx']);
    const body = sent.find((s) => s.body.task === 'daypack')!.body as AiDayPackRequest;
    expect(body.sentences.map((s) => [s.number, s.text])).toEqual([[1, 'I could use a cup of coffee.'], [2, 'That sounds like a plan.']]);
    expect(JSON.stringify(sent.map((s) => s.body))).not.toContain('Long word');
    const d = (await db.dialogues.where('videoId').equals('x').first())!;
    const items = await db.learningItems.where('videoId').equals('x').toArray();
    const refs = [...d.lines.map((l) => l.sourceSentenceId), ...items.flatMap((i) => [i.sentenceId, ...(i.occurrences ?? []).map((o) => o.sentenceId)])].filter(Boolean);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((id) => id === 'x2' || id === 'x3')).toBe(true);
    const after = await snapshotOf(db);
    expect(after.sentences).toEqual(before.sentences);
    expect(after.reviews).toEqual(before.reviews);
    // 자료 생성 뒤에는 바꿀 수 없음 (기록 그대로)
    expect(await pc.setDayExcluded('x', 'xl', false)).toBe('has_material');
    expect(await createContentStore(db).setDayExcluded('x', 'xl', false)).toBe('has_material');
    expect((await db.appMeta.get(DAY_EXCLUSIONS_META_KEY))?.value).toEqual({ x: ['xl'] });
  });

  it('다시 넣으면 문제 안내가 돌아오고 요청하지 않음', async () => {
    const { db } = createTestRepos();
    await seedStuck(db);
    const { pc, gemini } = setup(db);
    await pc.setDayExcluded('x', 'xl', true);
    await pc.setDayExcluded('x', 'xl', false);
    await pc.makeDay('x');
    await pc.start();
    expect(gemini.createCalls).toEqual([]);
    expect(pc.getSnapshot().rows.find((r) => r.video.id === 'x')?.failure?.error).toMatchObject({ code: 'day_sentences' });
  });

  it('요청 대기 중에는 바꿀 수 없음 (busy, 기록 그대로)', async () => {
    const { db } = createTestRepos();
    await seedStuck(db);
    const { pc } = setup(db);
    await pc.setDayExcluded('x', 'xl', true);
    await pc.stop();
    await createContentStore(db).updatePrep((s) => ({ ...s, queue: [...s.queue, 'x'], manual: [...(s.manual ?? []), 'x'] }));
    expect(await pc.setDayExcluded('x', 'xl', false)).toBe('busy');
    expect((await db.appMeta.get(DAY_EXCLUSIONS_META_KEY))?.value).toEqual({ x: ['xl'] });
  });

  it('보낸 뒤 빼기·다시 넣기가 바뀌면 결과를 저장하지 않음 (sentences_changed)', async () => {
    const { db } = createTestRepos();
    await seedStuck(db);
    const { pc, onSend } = setup(db);
    await pc.setDayExcluded('x', 'xl', true);
    let once = false;
    onSend(async (body) => {
      if (body.task === 'daypack' && !once) {
        once = true;
        await createContentStore(db).setDayExcluded('x', 'x3', true); // 대기열을 거치지 않은 변경(다른 탭 등)
      }
    });
    await pc.makeDay('x');
    await pc.start();
    expect(await db.dialogues.where('videoId').equals('x').count()).toBe(0);
    expect(pc.getSnapshot().rows.find((r) => r.video.id === 'x')).toMatchObject({ status: 'failed', failure: { error: { code: 'sentences_changed' } } });
  });

  it('개수: Day 자료에 쓰는 문장만 20개까지, 뺀 문장은 개수 제한 없음 / 뺀 문장과 같은 문장은 다시 넣기 안내', async () => {
    const { db, repos } = createTestRepos();
    await seedVideo(db, 'd', '[Day 20] 많음');
    const { pc } = setup(db);
    for (let i = 1; i <= 20; i++) await addKeySentence(repos, 'd', { english: `Sentence ${i}.`, origin: 'manual' }, { day: true });
    await expect(addKeySentence(repos, 'd', { english: 'One more.', origin: 'manual' }, { day: true })).rejects.toMatchObject({ code: 'limit' });
    const all = (await db.keySentences.where('videoId').equals('d').toArray()).sort((a, b) => a.order - b.order);
    for (const s of all.slice(0, 8)) expect(await pc.setDayExcluded('d', s.id, true)).toBe('ok');
    for (let i = 21; i <= 28; i++) await addKeySentence(repos, 'd', { english: `Sentence ${i}.`, origin: 'manual' }, { day: true });
    await expect(addKeySentence(repos, 'd', { english: 'Twenty-nine.', origin: 'manual' }, { day: true })).rejects.toMatchObject({ code: 'limit' });
    const now = await db.keySentences.where('videoId').equals('d').toArray();
    expect(now).toHaveLength(28);
    expect(new Set(now.map((s) => s.order)).size).toBe(28);
    await expect(addKeySentence(repos, 'd', { english: 'Sentence 1.', origin: 'manual' }, { day: true })).rejects.toThrow('다시 넣기');
    // 20개 포함 상태에서는 다시 넣기 대신 빼기 필요 — 포함 개수 21개를 만드는 요청은 대기열 검사에서 막힘
    await pc.setDayExcluded('d', all[0].id, false);
    await pc.makeDay('d');
    await pc.start();
    expect(pc.getSnapshot().rows.find((r) => r.video.id === 'd')?.failure?.error.message).toContain('20개');
  });

  it('번호 표시: 요청 기록이 없을 때는 뺀 문장을 건너뛴 순서', () => {
    const sentences = [ks('a', 'v', 1, 'A.', 'manual'), ks('b', 'v', 2, 'B.', 'manual'), ks('c', 'v', 3, 'C.', 'manual')];
    const v = dayViewOf(sentences, [], [], null, new Set(['b']));
    expect([...v.numbering.entries()]).toEqual([['a', 1], ['c', 2]]);
    expect(v.excludedSentences.map((s) => s.id)).toEqual(['b']);
  });

  it('형식이 다른 기록은 빈 값으로 (기존 데이터·잘못된 값 → 뺀 문장 없음)', () => {
    expect(parseDayExclusions(undefined)).toEqual({});
    expect(parseDayExclusions([1, 2])).toEqual({});
    expect(parseDayExclusions({ v: ['a', 'a', 3], w: 'x' })).toEqual({ v: ['a'] });
  });
});

describe('백업·복원 호환', () => {
  it('내보내기에 들어가고, 빈 기기에 복원하면 추가 · 같은 키가 다르면 기기 값 유지 · 기록 없는 예전 백업도 그대로 통과', async () => {
    const src = createTestRepos().db;
    await seedStuck(src);
    const { pc } = setup(src);
    await pc.setDayExcluded('x', 'xl', true);
    const file = await createBackup(createBackupStore(src));
    expect(file.tables.appMeta.find((m) => m.key === DAY_EXCLUSIONS_META_KEY)).toEqual({ key: DAY_EXCLUSIONS_META_KEY, value: { x: ['xl'] } });
    const parsed = parseBackupText(serializeBackup(file), CURRENT_SCHEMA_VERSION);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // 빈 기기
    const empty = createTestRepos().db;
    await applyRestore(createBackupStore(empty), createSnapshotStore(`snap-ex-${Date.now()}-a`), parsed.backup);
    expect((await empty.appMeta.get(DAY_EXCLUSIONS_META_KEY))?.value).toEqual({ x: ['xl'] });
    expect(await empty.keySentences.get('xl')).toEqual(await src.keySentences.get('xl'));
    // 이미 다른 값이 있는 기기 → 충돌로 표시하고 기기 값 유지
    const other = createTestRepos().db;
    await other.appMeta.put({ key: DAY_EXCLUSIONS_META_KEY, value: { z: ['zz'] } });
    const plan = await previewRestore(createBackupStore(other), parsed.backup);
    expect(plan.conflicts.some((c) => c.table === 'appMeta' && c.id === DAY_EXCLUSIONS_META_KEY)).toBe(true);
    await applyRestore(createBackupStore(other), createSnapshotStore(`snap-ex-${Date.now()}-b`), parsed.backup);
    expect((await other.appMeta.get(DAY_EXCLUSIONS_META_KEY))?.value).toEqual({ z: ['zz'] });
    // 기록이 없는 예전 백업
    const oldFile = buildBackupFile({ ...file.tables, appMeta: file.tables.appMeta.filter((m) => m.key !== DAY_EXCLUSIONS_META_KEY) }, file.schemaVersion);
    const oldParsed = parseBackupText(serializeBackup(oldFile), CURRENT_SCHEMA_VERSION);
    expect(oldParsed.ok).toBe(true);
    if (!oldParsed.ok) return;
    const fresh = createTestRepos().db;
    await applyRestore(createBackupStore(fresh), createSnapshotStore(`snap-ex-${Date.now()}-c`), oldParsed.backup);
    expect(await fresh.appMeta.get(DAY_EXCLUSIONS_META_KEY)).toBeUndefined();
    expect([...(await createContentStore(fresh).getDayExcluded('x'))]).toEqual([]);
    // DB 버전 그대로
    expect(fresh.verno).toBe(src.verno);
  });
});
