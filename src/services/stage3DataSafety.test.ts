import { describe, expect, it } from 'vitest';
import { createTestRepos } from '@/test/helpers';
import { CURRENT_SCHEMA_VERSION } from '@/db/migrations';
import { TABLE_NAMES } from '@/db/database';
import { initializeApp } from './seedService';
import { applyRating, createReviewState } from './scheduler';
import { addKeySentence, linkExpression, removeKeySentence, unlinkExpression, updateKeySentenceDetails } from './keySentenceService';
import { applyAiNotesResult, parseAiNotesResponse, saveExpressionNote } from './expressionNoteService';

/**
 * 3단계 작업이 기존 학습 기록·즐겨찾기·취약 표현·복습 기록·진행도를 바꾸지 않는지 확인한다.
 */
describe('3단계 데이터 보존', () => {
  it('3단계는 스키마를 바꾸지 않았다 — 스키마 변경은 B1(v3, 새 테이블만 추가)에서 처음 있다', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(3);
  });

  it('핵심 문장·표현 노트 작업 후에도 기존 기록은 그대로 남는다', async () => {
    const { db, repos } = createTestRepos();
    await initializeApp(repos, CURRENT_SCHEMA_VERSION);

    // 사용자 데이터: 영상, 표현(즐겨찾기·어려움), 복습 기록, 학습 기록
    const [r] = await repos.videos.upsertFromYouTube(
      [{ youtubeVideoId: 'abcdefghijk', title: '내 영상', channelTitle: null, thumbnailUrl: null, durationSec: 300, metadataSource: 'youtube_api' }],
      { kind: 'manual' },
    );
    const expr = await repos.expressions.upsert({ text: 'slip my mind', meaningKo: '깜빡 잊다', sourceRef: { videoId: 'other' } });
    await repos.expressions.setFavorite(expr.id, true);
    await repos.expressions.setMarkedDifficult(expr.id, true);
    await repos.reviewStates.put(applyRating(createReviewState('expression', expr.id), 'wrong'));
    await db.studyLogs.add({
      id: 'log-1',
      timestamp: new Date().toISOString(),
      date: '2026-11-14',
      activity: 'expression_review',
      itemType: 'expression',
      itemId: expr.id,
      rating: 'wrong',
      isReview: true,
    });

    const snapshot = async () => ({
      reviewStates: await db.reviewStates.toArray(),
      studyLogs: await db.studyLogs.toArray(),
      dialogueProgress: await db.dialogueProgress.toArray(),
      dialogues: await db.dialogues.toArray(),
      expressionFlags: (await db.expressions.toArray()).map((e) => [e.id, e.isFavorite, e.isMarkedDifficult]),
      videos: (await db.videos.toArray()).map((v) => [v.id, v.status, v.title]),
      counts: Object.fromEntries(await Promise.all(TABLE_NAMES.map(async (t) => [t, await db.table(t).count()]))),
    });
    const before = await snapshot();

    // 3단계 작업 전부 실행
    const s = await addKeySentence(repos, r.video.id, { english: 'It completely slipped my mind.', origin: 'transcript' });
    const tmp = await addKeySentence(repos, r.video.id, { english: 'Wrong pick.', origin: 'manual' });
    await updateKeySentenceDetails(repos, s.id, { korean: '완전히 깜빡했어.' });
    await linkExpression(repos, s.id, { text: 'slip my mind', meaningKo: '' });
    await unlinkExpression(repos, s.id, expr.id);
    await linkExpression(repos, s.id, { text: 'slip my mind', meaningKo: '' });
    await removeKeySentence(repos, tmp.id);
    await saveExpressionNote(repos, r.video.id, {
      expression: 'slip my mind',
      meaningKo: '깜빡 잊다',
      usageContext: '',
      nuance: '',
      examples: [],
      similar: [],
      sourceTimestampSec: null,
      origin: 'video',
      verification: 'confirmed',
    });
    await applyAiNotesResult(
      repos,
      r.video.id,
      parseAiNotesResponse('{"notes":[{"expression":"completely","meaningKo":"완전히"}]}'),
    );

    const after = await snapshot();
    expect(after.reviewStates).toEqual(before.reviewStates);
    expect(after.studyLogs).toEqual(before.studyLogs);
    expect(after.dialogueProgress).toEqual(before.dialogueProgress);
    expect(after.dialogues).toEqual(before.dialogues);
    expect(after.videos).toEqual(before.videos);
    // 기존 표현의 즐겨찾기·어려움 표시 유지 (새 표현만 추가됨)
    for (const row of before.expressionFlags) expect(after.expressionFlags).toContainEqual(row);
    // 줄어든 테이블이 없다 (추가만 됨)
    for (const t of TABLE_NAMES) expect(after.counts[t]).toBeGreaterThanOrEqual(before.counts[t]);
    expect(after.counts.keySentences).toBe(before.counts.keySentences + 1);
  });
});
