import type Dexie from 'dexie';

/**
 * 스키마 마이그레이션 정의
 *
 * 규칙 (기존 데이터와 학습 이력 보존):
 * 1. 이미 배포된 version(n)의 정의는 절대 수정하지 않는다.
 * 2. 스키마를 바꿀 때는 새 version(n+1)을 아래에 추가한다.
 *    Dexie는 이전 버전 사용자의 DB를 순서대로 업그레이드한다.
 * 3. 데이터 변환이 필요하면 .upgrade(tx => ...)에서 기존 레코드를 변환한다.
 *    (레코드를 지우지 말고 필드를 추가/변환하는 방식으로)
 * 4. 인덱스에 없는 필드는 스키마 변경 없이 추가할 수 있다.
 *
 * 주의: IndexedDB는 boolean 값을 인덱싱할 수 없으므로 isSample/isFavorite 등은 인덱스에 넣지 않는다.
 * 인덱스 문법: '&'=고유, '*'=배열(multiEntry), '[a+b]'=복합 인덱스
 */
export const CURRENT_SCHEMA_VERSION = 1;

export function applyMigrations(db: Dexie): void {
  // v1 — 최초 스키마 (1단계)
  db.version(1).stores({
    playlists: 'id, youtubePlaylistId',
    videos: 'id, playlistId, youtubeVideoId, status, orderIndex, randomOrderKey',
    transcripts: 'id, videoId, status',
    expressionNotes: 'id, videoId, expressionId',
    keySentences: 'id, videoId, [videoId+order], status',
    dialogues: 'id, kind, videoId, *sourceVideoIds',
    dialogueCompositions: 'id, &videoId',
    expressions: 'id, &normalizedKey',
    reviewStates: 'id, [itemType+itemId], itemType, nextReviewAt, weakness',
    dialogueProgress: 'id, &dialogueId',
    studyLogs: 'id, date, timestamp, activity, [itemType+itemId]',
    appMeta: 'key',
  });

  // 예시 — 다음 버전 추가 시:
  // db.version(2)
  //   .stores({ videos: 'id, playlistId, youtubeVideoId, status, orderIndex, randomOrderKey, isSample, lastStudiedAt' })
  //   .upgrade(async (tx) => {
  //     await tx.table('videos').toCollection().modify((v) => { v.lastStudiedAt ??= null; });
  //   });
}
