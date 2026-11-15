import { StudyDatabase } from '@/db/database';
import { seedSampleData } from '@/services/seedService';
import { createIndexedDbRepositories } from '@/repositories/indexeddb';

/**
 * 테스트 전용 v2 DB — 운영 앱과 비슷한 규모·모양의 가짜 데이터 (개인 데이터 아님)
 *
 * - 샘플 데이터(앱 기본) + 사용자 데이터: 재생목록 1개, 영상 103개(Day 1~100, 같은 Day 제목 1개, 긴 강의 2개)
 * - 자막: 출처·상태·형식이 섞인 기록 (youtube·manual_paste, success·failed, srt·plain·null)
 * - 핵심 문장: 표현 0개·1개·여러 개, 없는 표현을 가리키는 문장 1개
 * - 표현 즐겨찾기·어려워요, 복습 상태, 학습 기록, 5단계 진행, 앱 설정
 * 테스트마다 이름이 다른 메모리 IndexedDB(fake-indexeddb)에 만든다.
 */

let counter = 0;
export const T0 = '2026-10-01T09:00:00.000Z';
const at = (i: number) => new Date(Date.parse(T0) + i * 3_600_000).toISOString();

export async function createV2Fixture(name = `v2-fixture-${Date.now()}-${counter++}`) {
  const v2 = new StudyDatabase(name, 2);
  await v2.open();
  // 앱 기본 샘플 데이터 (v2 앱이 처음 열릴 때 넣던 것)
  await seedSampleData(createIndexedDbRepositories(v2), new Date(T0));

  const playlistId = 'pl-user-1';
  await v2.table('playlists').add({
    id: playlistId, createdAt: T0, updatedAt: T0, youtubePlaylistId: 'PLtestFixture0000001', title: '100일 챌린지 시즌2 (테스트)',
    description: null, channelTitle: '테스트 채널', thumbnailUrl: null, itemCount: 103, lastSyncedAt: T0, metadataSource: 'youtube_api', lastSync: null,
  });

  const videos: Record<string, unknown>[] = [];
  const titleOf = (i: number) => {
    if (i < 100) return `[Day ${i + 1}] 테스트 영상 ${i + 1}`;
    if (i === 100) return '[Day 7] 같은 Day 번호를 가진 다른 영상';
    if (i === 101) return '영어 표현 몰아보기 9시간';
    return '긴 강의 1시간 42분 (Day 아님)';
  };
  for (let i = 0; i < 103; i++) {
    videos.push({
      id: `v-${String(i + 1).padStart(3, '0')}`, createdAt: at(i), updatedAt: at(i + 1), playlistId,
      youtubeVideoId: `yt${String(i).padStart(9, '0')}`, title: titleOf(i), url: null, thumbnailUrl: null,
      durationSec: i === 101 ? 9 * 3600 : i === 102 ? 6120 : 240 + (i % 7) * 15, orderIndex: i, randomOrderKey: (i * 37) % 103 / 103,
      status: i < 20 ? 'completed' : i < 40 ? 'in_progress' : 'new', completedAt: i < 20 ? at(i + 2) : null,
      sources: [{ kind: 'playlist', playlistId, position: i, addedAt: at(i) }], channelTitle: '테스트 채널',
      captionCheck: i % 9 === 0 ? { checkedAt: at(i), hasCaptions: false, languages: [] } : null, metadataSource: 'youtube_api',
      ...(i === 5 ? { isFavorite: true } : {}),
    });
  }
  await v2.table('videos').bulkAdd(videos);

  // 자막: 30개 영상 — 출처·상태·형식·확인 정보가 섞여 있다 (업그레이드 뒤에도 그대로여야 함)
  const transcripts = Array.from({ length: 30 }, (_, i) => ({
    id: `tr-${i + 1}`, createdAt: at(i), updatedAt: at(i + 3), videoId: videos[i].id,
    source: i % 3 === 0 ? 'youtube' : 'manual_paste', status: i % 10 === 9 ? 'failed' : 'success',
    format: i % 4 === 0 ? 'srt' : i % 4 === 1 ? 'plain' : i % 4 === 2 ? 'timestamped' : null,
    rawText: `1\n00:00:01,000 --> 00:00:03,000\nline ${i}`, segments: [{ start: 1, end: 3, text: `line ${i}` }],
    language: 'en', verification: i % 5 === 0 ? 'checked_by_user' : undefined, errorMessage: i % 10 === 9 ? '자막 없음' : null,
  }));
  await v2.table('transcripts').bulkAdd(transcripts.map((t) => Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined))));

  // 표현 40개 (즐겨찾기·어려워요 일부)
  const expressions = Array.from({ length: 40 }, (_, i) => ({
    id: `ex-${i + 1}`, createdAt: at(i), updatedAt: at(i + 5), normalizedKey: `could use ${i + 1}`, text: `could use ${i + 1}`,
    meaningKo: `뜻 ${i + 1}`, sourceRefs: [{ videoId: videos[i % 25].id, dialogueId: null, sentenceId: null }],
    isFavorite: i % 6 === 0, isMarkedDifficult: i % 8 === 0,
  }));
  await v2.table('expressions').bulkAdd(expressions);

  // 핵심 문장: 25개 영상 × 2문장 = 50개. 표현 1개·2개·0개, 없는 표현 1건
  const keySentences: Record<string, unknown>[] = [];
  for (let v = 0; v < 25; v++) {
    for (let o = 1; o <= 2; o++) {
      const n = keySentences.length;
      const expressionIds = n === 3 ? [] : n === 7 ? ['ex-missing'] : n % 5 === 0 ? [`ex-${(n % 40) + 1}`, `ex-${((n + 1) % 40) + 1}`] : [`ex-${(n % 40) + 1}`];
      keySentences.push({
        id: `ks-${n + 1}`, createdAt: at(n), updatedAt: at(n + 2), videoId: videos[v].id, order: o, english: `I could use some help ${n + 1}.`,
        korean: `도움이 좀 필요해 ${n + 1}`, expressionIds, situation: '상황', timestampSec: n % 4 === 0 ? null : 10 + n, status: 'learning',
        correctCount: n % 3, wrongCount: n % 2, ...(n % 6 === 0 ? { expressionSpans: [{ expressionId: `ex-${(n % 40) + 1}`, start: 2, end: 11 }], origin: 'transcript' } : {}),
      });
    }
  }
  await v2.table('keySentences').bulkAdd(keySentences);

  // 복습 상태·학습 기록·노트
  await v2.table('reviewStates').bulkAdd(
    expressions.slice(0, 15).map((e, i) => ({
      id: `expression:${e.id}`, itemType: 'expression', itemId: e.id, correctCount: i, wrongCount: i % 3, lastResult: i % 2 ? 'easy' : 'hard',
      lastStudiedAt: at(50 + i), nextReviewAt: at(80 + i), weakness: (i * 7) % 100, streak: i % 4, intervalIndex: i % 5, reviewCount: i + 1, lastQuizzedAt: null,
    })),
  );
  await v2.table('studyLogs').bulkAdd(
    Array.from({ length: 60 }, (_, i) => ({
      id: `log-${i + 1}`, timestamp: at(60 + i), date: at(60 + i).slice(0, 10), activity: i % 2 ? 'review' : 'sentence_quiz',
      itemType: i % 2 ? 'expression' : 'sentence', itemId: i % 2 ? expressions[i % 40].id : keySentences[i % 50].id, rating: 'easy', accuracy: 1, isReview: i % 2 === 1,
    })),
  );
  await v2.table('expressionNotes').bulkAdd(
    expressions.slice(0, 10).map((e, i) => ({ id: `note-${i + 1}`, createdAt: at(i), updatedAt: at(i), videoId: videos[i].id, expressionId: e.id, meaningKo: '뜻', nuance: '뉘앙스', examples: [], origin: 'video' })),
  );
  await v2.table('appMeta').bulkPut([
    { key: 'initializedAt', value: T0 },
    { key: 'schemaVersion', value: 2 },
    { key: 'studyQueue', value: { version: 1, cycle: 2, order: videos.slice(0, 50).map((v) => v.id), visited: ['v-001', 'v-002'], includeCompleted: false } },
  ]);
  return { name, db: v2 };
}
