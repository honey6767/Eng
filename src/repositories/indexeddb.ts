import type { StudyDatabase, TableName } from '@/db/database';
import { TABLE_NAMES } from '@/db/database';
import type { Expression } from '@/types/models';
import { createId } from '@/utils/id';
import { nowISO } from '@/utils/date';
import { normalizeExpressionKey } from '@/utils/text';
import { reviewStateId } from '@/services/scheduler';
import type { Repositories, TableCount } from './types';

export const TABLE_LABELS: Record<TableName, string> = {
  playlists: '재생목록',
  videos: '영상',
  transcripts: '자막',
  expressionNotes: '주요 표현 노트',
  keySentences: '핵심 문장',
  dialogues: '대화문',
  dialogueCompositions: '대화문 구성 정보',
  expressions: '표현',
  reviewStates: '복습 상태',
  dialogueProgress: '5단계 진행도',
  studyLogs: '학습 기록',
  appMeta: '앱 설정',
};

const byOrder = <T extends { order: number }>(a: T, b: T) => a.order - b.order;

/** IndexedDB(Dexie) 기반 저장소 구현 */
export function createIndexedDbRepositories(db: StudyDatabase): Repositories {
  return {
    playlists: {
      list: () => db.playlists.orderBy('id').toArray(),
      get: (id) => db.playlists.get(id),
    },

    videos: {
      list: () => db.videos.orderBy('orderIndex').toArray(),
      get: (id) => db.videos.get(id),
      listByStatus: (status) => db.videos.where('status').equals(status).sortBy('orderIndex'),
      update: async (id, patch) => {
        await db.videos.update(id, { ...patch, updatedAt: nowISO() });
      },
    },

    transcripts: {
      getByVideo: (videoId) => db.transcripts.where('videoId').equals(videoId).first(),
    },

    expressionNotes: {
      listByVideo: async (videoId) =>
        (await db.expressionNotes.where('videoId').equals(videoId).toArray()).sort(byOrder),
    },

    keySentences: {
      list: () => db.keySentences.toArray(),
      listByVideo: (videoId) =>
        db.keySentences
          .where('[videoId+order]')
          .between([videoId, -Infinity], [videoId, Infinity])
          .toArray(),
      getMany: async (ids) => (await db.keySentences.bulkGet(ids)).filter((x) => x != null),
    },

    dialogues: {
      list: async (kind) => {
        const rows = kind ? await db.dialogues.where('kind').equals(kind).toArray() : await db.dialogues.toArray();
        return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.orderInVideo - b.orderInVideo);
      },
      get: (id) => db.dialogues.get(id),
      listByVideo: async (videoId) =>
        (await db.dialogues.where('videoId').equals(videoId).toArray()).sort((a, b) => a.orderInVideo - b.orderInVideo),
      setFavorite: async (id, isFavorite) => {
        await db.dialogues.update(id, { isFavorite, updatedAt: nowISO() });
      },
    },

    compositions: {
      getByVideo: (videoId) => db.dialogueCompositions.where('videoId').equals(videoId).first(),
    },

    expressions: {
      list: async () => (await db.expressions.toArray()).sort((a, b) => a.text.localeCompare(b.text)),
      get: (id) => db.expressions.get(id),
      getMany: async (ids) => (await db.expressions.bulkGet(ids)).filter((x) => x != null),
      upsert: ({ text, meaningKo, sourceRef, isSample }) =>
        db.transaction('rw', db.expressions, async () => {
          const normalizedKey = normalizeExpressionKey(text);
          const existing = await db.expressions.where('normalizedKey').equals(normalizedKey).first();
          const now = nowISO();
          if (existing) {
            const refs = [...existing.sourceRefs];
            if (
              sourceRef &&
              !refs.some(
                (r) =>
                  r.videoId === sourceRef.videoId &&
                  (r.sentenceId ?? null) === (sourceRef.sentenceId ?? null) &&
                  (r.dialogueId ?? null) === (sourceRef.dialogueId ?? null),
              )
            ) {
              refs.push(sourceRef);
            }
            const updated: Expression = {
              ...existing,
              sourceRefs: refs,
              meaningKo: existing.meaningKo || meaningKo,
              // 사용자 데이터에서 다시 등장하면 더 이상 샘플 전용이 아님
              isSample: existing.isSample && isSample ? true : undefined,
              updatedAt: now,
            };
            await db.expressions.put(updated);
            return updated;
          }
          const created: Expression = {
            id: createId(),
            normalizedKey,
            text: text.trim(),
            meaningKo,
            sourceRefs: sourceRef ? [sourceRef] : [],
            isFavorite: false,
            isMarkedDifficult: false,
            createdAt: now,
            updatedAt: now,
            ...(isSample ? { isSample: true } : {}),
          };
          await db.expressions.add(created);
          return created;
        }),
      setFavorite: async (id, isFavorite) => {
        await db.expressions.update(id, { isFavorite, updatedAt: nowISO() });
      },
      setMarkedDifficult: async (id, marked) => {
        await db.expressions.update(id, { isMarkedDifficult: marked, updatedAt: nowISO() });
      },
    },

    reviewStates: {
      list: (itemType) =>
        itemType ? db.reviewStates.where('itemType').equals(itemType).toArray() : db.reviewStates.toArray(),
      get: (itemType, itemId) => db.reviewStates.get(reviewStateId(itemType, itemId)),
      listDue: (now) => db.reviewStates.where('nextReviewAt').belowOrEqual(now.toISOString()).toArray(),
      put: async (state) => {
        await db.reviewStates.put(state);
      },
    },

    dialogueProgress: {
      list: () => db.dialogueProgress.toArray(),
      get: (dialogueId) => db.dialogueProgress.where('dialogueId').equals(dialogueId).first(),
    },

    studyLogs: {
      listSince: (dateKey) => db.studyLogs.where('date').aboveOrEqual(dateKey).toArray(),
      countReviews: () => db.studyLogs.filter((l) => l.isReview).count(),
      count: () => db.studyLogs.count(),
    },

    meta: {
      get: async <T,>(key: string) => (await db.appMeta.get(key))?.value as T | undefined,
      set: async <T,>(key: string, value: T) => {
        await db.appMeta.put({ key, value });
      },
    },

    maintenance: {
      countAll: async () => {
        const result: TableCount[] = [];
        for (const name of TABLE_NAMES) {
          const table = db.table(name);
          const total = await table.count();
          const sample = name === 'appMeta' ? 0 : await table.filter((r: { isSample?: boolean }) => r.isSample === true).count();
          result.push({ table: name, label: TABLE_LABELS[name], total, sample });
        }
        return result;
      },
      hasSampleData: async () => {
        for (const name of TABLE_NAMES) {
          if (name === 'appMeta') continue;
          const n = await db.table(name).filter((r: { isSample?: boolean }) => r.isSample === true).count();
          if (n > 0) return true;
        }
        return false;
      },
      deleteSampleData: async () => {
        let deleted = 0;
        const tables = TABLE_NAMES.filter((n) => n !== 'appMeta').map((n) => db.table(n));
        await db.transaction('rw', tables, async () => {
          for (const table of tables) {
            deleted += await table.filter((r: { isSample?: boolean }) => r.isSample === true).delete();
          }
        });
        // 사용자 표현에 남은 샘플 영상 출처 참조 정리
        const videoIds = new Set((await db.videos.toArray()).map((v) => v.id));
        await db.expressions.toCollection().modify((e) => {
          e.sourceRefs = e.sourceRefs.filter((r) => r.videoId == null || videoIds.has(r.videoId));
        });
        await db.appMeta.delete('sampleSeededAt');
        return deleted;
      },
      bulkInsert: async (data) => {
        const entries = Object.entries(data).filter(([, rows]) => rows && rows.length > 0) as [TableName, unknown[]][];
        if (entries.length === 0) return;
        const tables = entries.map(([name]) => db.table(name));
        await db.transaction('rw', tables, async () => {
          for (const [name, rows] of entries) await db.table(name).bulkAdd(rows);
        });
      },
      clearAll: async () => {
        const tables = TABLE_NAMES.map((n) => db.table(n));
        await db.transaction('rw', tables, async () => {
          for (const table of tables) await table.clear();
        });
      },
    },
  };
}
