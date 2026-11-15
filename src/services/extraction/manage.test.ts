import { describe, expect, it } from 'vitest';
import type { StudyDatabase } from '@/db/database';
import { createExtractionStore } from '@/repositories/extractionStore';
import { createTestRepos } from '@/test/helpers';
import type { ExtractionDraft, ExtractionJob } from '@/types/models';
import { confirmAllSuggestions, loadDayRows, setVideoDay } from '@/services/days/dayService';
import { assessDraft } from './applyDraft';
import { applyDraft, autoApplyPending, rejectDraftAndRetry, retryAllFailed, reviewOverview, skipDraft } from './manage';
import { validateExtraction } from './validateResult';

const T = '2026-11-15T12:00:00.000Z';
let seq = 0;
const newId = () => `gen-${++seq}`;

async function seedVideo(db: StudyDatabase, id: string, title: string, dur = 300) {
  await db.videos.add({ id, createdAt: T, updatedAt: T, playlistId: null, youtubeVideoId: `${id}xxxxxxxxxxx`.slice(0, 11), title, url: null, thumbnailUrl: null, durationSec: dur, orderIndex: 0, randomOrderKey: 0.1, status: 'new', completedAt: null, sources: [{ kind: 'manual', addedAt: T }], channelTitle: null, captionCheck: null, metadataSource: 'manual' });
}
function job(videoId: string, status: ExtractionJob['status'] = 'succeeded'): ExtractionJob {
  return { id: `job-${videoId}`, videoId, status, attempts: 1, attemptAfter: null, lastError: status === 'failed_permanent' ? { code: 'gemini_failed', message: 'x' } : null, currentRequestId: 'r', segments: [], leaseOwner: null, leaseUntil: null, model: null, apiStyle: 'interactions', promptVersion: 'v1', videoDurationSec: 300, draftId: null, createdAt: T, updatedAt: T };
}
function draft(videoId: string, full = true, keys = ['could use', 'make it'], dayNumber = 0): ExtractionDraft {
  const segs = [];
  for (let t = 0; t < (full ? 300 : 40); t += 10) segs.push({ start: t, end: t + 10, text: t === 0 ? 'I could use some help. Can you make it?' : `line ${t}` });
  const v = validateExtraction(JSON.stringify({ language: 'mixed', dayNumber, transcript: segs, keyExpressions: keys.map((k) => ({ text: k, meaningKo: `뜻 ${k}`, sourceSentence: 'I could use some help. Can you make it?', timestampSec: 1, onScreen: false, confidence: 1 })), introChunks: [{ text: 'some help', meaningKo: '도움', timestampSec: 2 }], notes: '' }), 300);
  if (!v.ok) throw new Error('bad fixture');
  return { id: `draft-${videoId}`, videoId, jobId: `job-${videoId}`, requestId: `req-${videoId}`, status: 'pending_review', result: v.result, rawText: '{}', edited: null, validation: v.issues, approvedRefs: [], createdAt: T, updatedAt: T };
}
const snapshot = async (db: StudyDatabase) => ({
  videos: JSON.stringify(await db.videos.toArray()),
  transcripts: await db.transcripts.toArray(),
  expressions: await db.expressions.toArray(),
});

describe('B1-d 초안 적용 (추가만, 덮어쓰기 없음)', () => {
  it('품질 판정: 전사가 충분하고 표현이 있으면 자동 적용, 전사가 절반도 안 되면 확인 필요', () => {
    expect(assessDraft(draft('a')).autoApply).toBe(true);
    expect(assessDraft(draft('a', false))).toMatchObject({ autoApply: false, blocking: expect.arrayContaining(['low_coverage']) });
    expect(assessDraft(draft('a', true, []))).toMatchObject({ autoApply: false, blocking: ['no_key_expressions'] });
  });

  it('자막이 없는 영상: AI 자막·새 표현·학습 대상 추가 / 같은 표현이 이미 있으면 기존 표현을 그대로 쓰고 고치지 않음', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'v1', '[Day 3] 테스트');
    const existing = { id: 'ex-old', createdAt: T, updatedAt: T, normalizedKey: 'could use', text: 'could use', meaningKo: '내가 쓴 뜻', sourceRefs: [], isFavorite: true, isMarkedDifficult: true };
    await db.expressions.add(existing);
    await db.extractionJobs.add(job('v1'));
    await db.extractionDrafts.add(draft('v1'));
    const store = createExtractionStore(db);
    const plan = await applyDraft({ store, newId, now: () => new Date(T) }, 'draft-v1');
    expect(plan).not.toBeNull();
    expect(await db.expressions.get('ex-old')).toEqual(existing); // 즐겨찾기·어려워요·뜻 그대로
    const t = (await db.transcripts.where('videoId').equals('v1').toArray())[0];
    expect(t).toMatchObject({ source: 'ai_transcription', status: 'success', verification: 'ai_unverified', extractionDraftId: 'draft-v1' });
    const exprs = await db.expressions.toArray();
    expect(exprs.map((e) => e.normalizedKey).sort()).toEqual(['could use', 'make it', 'some help']);
    expect(exprs.find((e) => e.normalizedKey === 'make it')).toMatchObject({ origin: 'ai_extracted', sourceRefs: [{ videoId: 'v1' }] });
    const items = await db.learningItems.toArray();
    expect(items.map((i) => [i.kind, i.expressionId === 'ex-old']).sort()).toEqual([['intro_chunk', false], ['key', false], ['key', true]]);
    expect(items.every((i) => i.origin === 'ai_extracted' && i.videoId === 'v1' && i.sourceType === 'other')).toBe(true);
    expect((await db.extractionDrafts.get('draft-v1'))!.status).toBe('approved');
    // 두 번 적용해도 아무것도 더 생기지 않음
    expect(await applyDraft({ store, newId }, 'draft-v1')).toBeNull();
    expect(await db.learningItems.count()).toBe(3);
  });

  it('이미 자막 기록이 있는 영상(실패 기록 포함)에는 AI 자막을 넣지 않는다 — 기존 자막 그대로', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'v2', '영상');
    await db.transcripts.add({ id: 'tr-old', createdAt: T, updatedAt: T, videoId: 'v2', source: 'manual_paste', status: 'failed', rawText: '', segments: [] });
    await db.extractionJobs.add(job('v2'));
    await db.extractionDrafts.add(draft('v2'));
    const before = await snapshot(db);
    await applyDraft({ store: createExtractionStore(db), newId }, 'draft-v2');
    const after = await snapshot(db);
    expect(after.transcripts).toEqual(before.transcripts);
    expect(after.videos).toBe(before.videos);
    expect(await db.learningItems.count()).toBe(3);
  });

  it('일부 표현을 빼고 적용하면 partially_approved, 확인 필요 초안은 자동 적용하지 않는다', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'v3', '영상');
    await seedVideo(db, 'v4', '영상');
    await db.extractionJobs.bulkAdd([job('v3'), job('v4')]);
    await db.extractionDrafts.bulkAdd([draft('v3', false), draft('v4')]);
    const store = createExtractionStore(db);
    expect(await autoApplyPending({ store, newId })).toBe(1); // v4만
    expect((await db.extractionDrafts.get('draft-v3'))!.status).toBe('pending_review');
    const ov = await reviewOverview(store);
    expect(ov.needsReview.map((r) => r.draft.id)).toEqual(['draft-v3']);
    const p = await applyDraft({ store, newId }, 'draft-v3', { excludeKeyIdx: [1], excludeChunkIdx: [0] });
    expect(p!.status).toBe('partially_approved');
    expect(p!.needsReview).toBe(true);
    const items = await db.learningItems.where('videoId').equals('v3').toArray();
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('needs_review');
  });
});

describe('B1-c 확인 필요·재시도 관리', () => {
  it('실패한 영상 모두 다시 시도 → 대기열(새 식별자로 1번 더), 확인 필요 초안 버리고 다시 / 건너뛰기', async () => {
    const { db } = createTestRepos();
    for (const v of ['f1', 'f2', 'd1', 'd2']) await seedVideo(db, v, v);
    await db.extractionJobs.bulkAdd([job('f1', 'failed_permanent'), job('f2', 'failed_permanent'), job('d1'), job('d2')]);
    await db.extractionDrafts.bulkAdd([draft('d1', false), draft('d2', false)]);
    const store = createExtractionStore(db);
    expect(await retryAllFailed({ store })).toBe(2);
    expect((await db.extractionJobs.get('job-f1'))).toMatchObject({ status: 'queued', currentRequestId: null, lastError: null });
    expect(await rejectDraftAndRetry({ store }, 'draft-d1')).toBe(true);
    expect((await db.extractionDrafts.get('draft-d1'))!.status).toBe('rejected'); // 지우지 않고 '버림'으로 남김
    expect((await db.extractionJobs.get('job-d1'))).toMatchObject({ status: 'queued', draftId: null });
    expect(await skipDraft({ store }, 'draft-d2')).toBe(true);
    expect((await db.extractionJobs.get('job-d2'))).toMatchObject({ status: 'skipped', lastError: { code: 'user_skipped' } });
    const ov = await reviewOverview(store);
    expect(ov.needsReview).toHaveLength(0);
    expect(ov.skipped.some((s) => s.job.videoId === 'd2')).toBe(false);
  });
});

describe('B1-d Day 정리', () => {
  it('제목·Day 기록·AI 번호로 제안, 겹치는 번호는 확인 필요, 모두 확정은 겹치지 않는 것만, 확정하면 학습 대상이 Day로', async () => {
    const { db } = createTestRepos();
    await seedVideo(db, 'a', '[Day 1] 첫 영상');
    await seedVideo(db, 'b', '[Day 2] 둘째');
    await seedVideo(db, 'c', '[Day 2] 같은 번호');
    await seedVideo(db, 'd', '번호 없는 영상');
    await seedVideo(db, 'e', '이미 확정');
    await db.dayAssignments.add({ id: 'day-e', videoId: 'e', dayNumber: 5, status: 'confirmed', source: 'user', createdAt: T, updatedAt: T });
    await db.extractionJobs.add(job('d'));
    await db.extractionDrafts.add({ ...draft('d', true, ['x'], 9), status: 'approved' });
    await db.learningItems.add({ id: 'li-a', createdAt: T, updatedAt: T, expressionId: 'ex', videoId: 'a', sourceType: 'other', dayNumber: null, kind: 'key', dialogueId: null, sourceText: null, timestampSec: null, onScreen: false, origin: 'ai_extracted', status: 'confirmed', extractionDraftId: null, legacyKeySentenceId: null });
    const videosBefore = JSON.stringify(await db.videos.toArray());
    const store = createExtractionStore(db);
    const rows = await loadDayRows(store);
    const by = Object.fromEntries(rows.map((r) => [r.video.id, r]));
    expect(by.a).toMatchObject({ dayNumber: 1, status: 'suggested', source: 'title' });
    expect(by.b.status).toBe('conflict');
    expect(by.c.status).toBe('conflict');
    expect(by.d).toMatchObject({ dayNumber: 9, status: 'suggested', source: 'ai_draft' });
    expect(by.e).toMatchObject({ dayNumber: 5, status: 'confirmed' });
    expect(await confirmAllSuggestions(store, new Date(T))).toBe(2); // a, d
    expect((await db.dayAssignments.get('day-a'))).toMatchObject({ dayNumber: 1, status: 'confirmed' });
    expect((await db.learningItems.get('li-a'))).toMatchObject({ sourceType: 'day', dayNumber: 1 });
    expect(await db.dayAssignments.get('day-b')).toBeUndefined(); // 겹치는 번호는 확정하지 않음
    expect(await setVideoDay(store, 'c', 3, new Date(T))).toBe(true);
    expect((await loadDayRows(store)).find((r) => r.video.id === 'b')!.status).toBe('suggested');
    expect(await setVideoDay(store, 'c', 0)).toBe(false);
    expect(JSON.stringify(await db.videos.toArray())).toBe(videosBefore); // 영상 레코드는 그대로
  });
});
