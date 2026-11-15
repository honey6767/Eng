import type Dexie from 'dexie';
import { V2_TABLE_NAMES } from './tables';
import { upgradeV2toV3, type V2Tables } from './upgradeV2toV3';

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
export const CURRENT_SCHEMA_VERSION = 3;

/** v3 업그레이드 기록 (appMeta 새 키) */
export const META_MIGRATION_LOG = 'migrationLog';

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

  if (upTo < 3) return;

  // v3 — B1: 새 테이블 7개만 선언한다. 기존 12개 테이블은 다시 선언하지 않아 인덱스가 그대로다.
  // 업그레이드 함수는 기존 테이블을 읽기만 하고(쓰기 0건), 새 테이블과 appMeta 새 키(migrationLog)만 추가한다.
  // 어느 단계에서든 예외가 나면 IndexedDB가 전체를 취소해 DB는 v2 그대로 남는다.
  db.version(3)
    .stores({
      learningItems: 'id, expressionId, videoId, [sourceType+dayNumber], kind, status',
      dayAssignments: 'id, &videoId, dayNumber, status',
      studySessions: 'id, dialogueId, status, date',
      dialogueDrafts: 'id, status, createdAt',
      extractionJobs: 'id, &videoId, status, attemptAfter, updatedAt',
      extractionDrafts: 'id, videoId, jobId, status, createdAt',
      aiRequests: 'id, jobId, status, pacificDate',
    })
    .upgrade(async (tx) => {
      const v2 = {} as V2Tables;
      for (const name of V2_TABLE_NAMES) v2[name] = (await tx.table(name).toArray()) as Record<string, unknown>[];
      const { newTables, log } = upgradeV2toV3(v2, new Date().toISOString());
      for (const [name, rows] of Object.entries(newTables)) if (rows.length) await tx.table(name).bulkAdd(rows);
      // add: 같은 키가 이미 있으면 실패 → 업그레이드 전체 취소 (덮어쓰지 않음)
      await tx.table('appMeta').add({ key: META_MIGRATION_LOG, value: log });
    });

  // 다음 버전을 추가할 때: 위의 정의는 고치지 말고 db.version(4)를 아래에 새로 추가한다.
}
