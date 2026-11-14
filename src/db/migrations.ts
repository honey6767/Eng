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
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * @param upTo 테스트용 — 지정한 버전까지만 정의 (마이그레이션 테스트에서 구버전 DB를 만들 때 사용)
 */
export function applyMigrations(db: Dexie, upTo = CURRENT_SCHEMA_VERSION): void {
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

  if (upTo < 2) return;

  // v2 — 2단계: 영상 출처(sources)·자막 확인 결과·정보 출처 필드 추가.
  // 인덱스는 그대로 두고(기존 데이터 위험 없음) 기존 레코드에 새 필드를 채운다. 레코드는 삭제하지 않는다.
  db.version(2)
    .stores({
      videos: 'id, playlistId, youtubeVideoId, status, orderIndex, randomOrderKey',
    })
    .upgrade(async (tx) => {
      await tx
        .table('videos')
        .toCollection()
        .modify((v: Record<string, unknown>) => {
          if (!Array.isArray(v.sources)) {
            v.sources = v.playlistId
              ? [{ kind: 'playlist', playlistId: v.playlistId, position: v.orderIndex ?? null, addedAt: v.createdAt }]
              : [{ kind: 'manual', addedAt: v.createdAt }];
          }
          v.channelTitle ??= null;
          v.captionCheck ??= null;
          v.metadataSource ??= v.isSample ? 'sample' : null;
        });
      await tx
        .table('transcripts')
        .toCollection()
        .modify((t: Record<string, unknown>) => {
          t.format ??= null;
        });
    });

  // 예시 — 다음 버전 추가 시:
  // db.version(2)
  //   .stores({ videos: 'id, playlistId, youtubeVideoId, status, orderIndex, randomOrderKey, isSample, lastStudiedAt' })
  //   .upgrade(async (tx) => {
  //     await tx.table('videos').toCollection().modify((v) => { v.lastStudiedAt ??= null; });
  //   });
}
