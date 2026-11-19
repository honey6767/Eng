import { describe, expect, it } from 'vitest';
import { createTestRepos } from '@/test/helpers';
import type { Repositories } from '@/repositories/types';
import { createReviewState } from './scheduler';
import { seedSampleData } from './seedService';
import {
  addKeySentence,
  getRemovalBlocker,
  KeySentenceError,
  linkExpression,
  removeKeySentence,
  resolveSpans,
  setExpressionSpan,
  unlinkExpression,
  updateKeySentenceDetails,
} from './keySentenceService';

async function userVideo(repos: Repositories) {
  const [r] = await repos.videos.upsertFromYouTube(
    [{ youtubeVideoId: 'abcdefghijk', title: '내 영상', channelTitle: null, thumbnailUrl: null, durationSec: 300, metadataSource: 'youtube_api' }],
    { kind: 'manual' },
  );
  return r.video;
}

const add = (repos: Repositories, videoId: string, english: string) =>
  addKeySentence(repos, videoId, { english, origin: 'transcript', timestampSec: 12 });

describe('3단계 핵심 문장', () => {
  it('원문 그대로 저장하고 영상당 5개까지만 선정한다', async () => {
    const { repos } = createTestRepos();
    const v = await userVideo(repos);
    const s1 = await add(repos, v.id, '  It completely   slipped my mind.\n');
    expect(s1.english).toBe('It completely slipped my mind.');
    expect(s1.order).toBe(1);
    expect(s1.status).toBe('not_started');
    expect(s1.isSample).toBeUndefined();
    for (const e of ['A one.', 'B two.', 'C three.', 'D four.']) await add(repos, v.id, e);
    await expect(add(repos, v.id, 'Sixth sentence.')).rejects.toMatchObject({ code: 'limit' });
    expect(await repos.keySentences.listByVideo(v.id)).toHaveLength(5);
  });

  it('같은 문장은 중복 선정하지 않는다', async () => {
    const { repos } = createTestRepos();
    const v = await userVideo(repos);
    await add(repos, v.id, "That's not a big deal.");
    await expect(add(repos, v.id, 'that’s not a big deal')).rejects.toMatchObject({ code: 'duplicate' });
    await expect(add(repos, v.id, '   ')).rejects.toMatchObject({ code: 'empty' });
  });

  it('영어 원문은 저장 후 바뀌지 않는다 (번역·상황만 수정)', async () => {
    const { repos } = createTestRepos();
    const v = await userVideo(repos);
    const s = await add(repos, v.id, 'Let me know if you need a hand.');
    await updateKeySentenceDetails(repos, s.id, { korean: ' 도움 필요하면 말해. ', situation: '도움 제안' });
    // 저장소에 english를 억지로 넘겨도 무시된다
    await repos.keySentences.update(s.id, { english: 'CHANGED' } as never);
    const after = (await repos.keySentences.get(s.id))!;
    expect(after.english).toBe('Let me know if you need a hand.');
    expect(after.korean).toBe('도움 필요하면 말해.');
    expect(after.situation).toBe('도움 제안');
  });

  it('선정 취소 후 빈 번호를 다시 채운다', async () => {
    const { repos } = createTestRepos();
    const v = await userVideo(repos);
    const a = await add(repos, v.id, 'First.');
    await add(repos, v.id, 'Second.');
    await removeKeySentence(repos, a.id);
    const c = await add(repos, v.id, 'Third.');
    expect(c.order).toBe(1);
  });

  it('학습·복습 기록이 있거나 대화문에서 쓰인 문장은 선정 취소할 수 없다', async () => {
    const { repos } = createTestRepos();
    const v = await userVideo(repos);
    const s = await add(repos, v.id, 'Studied sentence.');
    await repos.keySentences.update(s.id, { correctCount: 1, status: 'learning' });
    await expect(removeKeySentence(repos, s.id)).rejects.toMatchObject({ code: 'locked' });

    const r = await add(repos, v.id, 'Reviewed sentence.');
    await repos.reviewStates.put(createReviewState('sentence', r.id));
    await expect(removeKeySentence(repos, r.id)).rejects.toBeInstanceOf(KeySentenceError);
    expect(await repos.keySentences.listByVideo(v.id)).toHaveLength(2);

    // 샘플 영상: 대화문에서 사용 중
    await seedSampleData(repos);
    const sv = (await repos.videos.list()).find((x) => x.isSample && x.title.includes('안부'))!;
    const [ks] = await repos.keySentences.listByVideo(sv.id);
    expect(await getRemovalBlocker(repos, ks)).toMatch(/대화문/);
  });

  it('핵심 표현 연결: 위치 자동 탐색, 중복 표현은 하나로, 연결 해제해도 표현과 즐겨찾기는 남는다', async () => {
    const { repos } = createTestRepos();
    const v = await userVideo(repos);
    const s = await add(repos, v.id, 'It completely slipped my mind.');
    const { expression, spanFound } = await linkExpression(repos, s.id, { text: 'slip my mind', meaningKo: '깜빡 잊다' });
    expect(spanFound).toBe(true);
    let saved = (await repos.keySentences.get(s.id))!;
    const span = saved.expressionSpans![0];
    expect(saved.english.slice(span.start, span.end)).toBe('slipped my mind');

    await repos.expressions.setFavorite(expression.id, true);
    await repos.expressions.setMarkedDifficult(expression.id, true);
    // 같은 표현을 다시 연결해도 새로 만들지 않는다
    const again = await linkExpression(repos, s.id, { text: 'Slip my mind', meaningKo: '' });
    expect(again.expression.id).toBe(expression.id);
    expect((await repos.expressions.list()).filter((e) => e.normalizedKey === 'slip my mind')).toHaveLength(1);

    // 위치 직접 지정
    await setExpressionSpan(repos, s.id, expression.id, { start: 14, end: 21 });
    saved = (await repos.keySentences.get(s.id))!;
    expect(saved.english.slice(14, 21)).toBe('slipped');
    await expect(setExpressionSpan(repos, s.id, expression.id, { start: 5, end: 999 })).rejects.toMatchObject({ code: 'bad_span' });

    await unlinkExpression(repos, s.id, expression.id);
    saved = (await repos.keySentences.get(s.id))!;
    expect(saved.expressionIds).toEqual([]);
    const kept = (await repos.expressions.get(expression.id))!;
    expect(kept.isFavorite).toBe(true);
    expect(kept.isMarkedDifficult).toBe(true);
    expect(kept.sourceRefs.some((r) => r.sentenceId === s.id)).toBe(false);
  });

  it('위치를 못 찾으면 spanFound=false, 화면용 위치는 저장값 우선·없으면 자동 탐색', async () => {
    const { repos } = createTestRepos();
    const v = await userVideo(repos);
    const s = await add(repos, v.id, "I'm running a bit behind today.");
    const r = await linkExpression(repos, s.id, { text: 'run behind', meaningKo: '늦어지다' });
    expect(r.spanFound).toBe(false);
    const saved = (await repos.keySentences.get(s.id))!;
    expect(resolveSpans(saved, [r.expression])).toEqual([]);

    // 샘플 문장(위치 미저장)은 자동 탐색으로 표시
    await seedSampleData(repos);
    const sv = (await repos.videos.list()).find((x) => x.isSample && x.title.includes('약속'))!;
    const sentences = await repos.keySentences.listByVideo(sv.id);
    const exprs = await repos.expressions.list();
    const slip = sentences.find((x) => x.english.includes('slipped'))!;
    const [rs] = resolveSpans(slip, exprs);
    expect(rs.source).toBe('auto');
    expect(slip.english.slice(rs.start, rs.end)).toBe('slipped my mind');
  });

  it('샘플 영상에 추가한 문장은 샘플로 표시된다 (샘플 삭제 시 함께 정리)', async () => {
    const { repos } = createTestRepos();
    await seedSampleData(repos);
    const v3 = (await repos.videos.list()).find((x) => x.isSample && x.title.includes('신규'))!;
    const s = await add(repos, v3.id, 'Sample-added sentence.');
    expect(s.isSample).toBe(true);
    await repos.maintenance.deleteSampleData();
    expect(await repos.keySentences.get(s.id)).toBeUndefined();
  });
});
