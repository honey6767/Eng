import type { StudyDatabase, TableName } from '@/db/database';
import { TABLE_NAMES } from '@/db/database';
import type { Expression, MetadataSource, Playlist, SourceRef, Transcript, Video, VideoSource } from '@/types/models';
import { createId } from '@/utils/id';
import { nowISO } from '@/utils/date';
import { normalizeExpressionKey } from '@/utils/text';
import { reviewStateId } from '@/services/scheduler';
import type { KeySentencePatch, Repositories, TableCount, VideoUpsertResult } from './types';

/** undefined 값은 빼고 반영 (부분 수정 시 기존 값 보존) */
function pickDefined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** 정보 출처 신뢰도 — 더 좋은 출처의 정보로만 덮어쓴다 */
const SOURCE_RANK: Record<MetadataSource, number> = { youtube_api: 3, oembed: 2, rss: 2, manual: 1, sample: 0 };

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
  learningItems: '학습 대상',
  dayAssignments: 'Day 제안·확정',
  studySessions: '학습 세션',
  dialogueDrafts: '대화문 초안',
  extractionJobs: '자동 추출 작업',
  extractionDrafts: '자동 추출 초안',
  aiRequests: 'AI 요청 기록',
};

const byOrder = <T extends { order: number }>(a: T, b: T) => a.order - b.order;

/** IndexedDB(Dexie) 기반 저장소 구현 */
export function createIndexedDbRepositories(db: StudyDatabase): Repositories {
  /** 이 DB에 실제로 있는 테이블만 (구버전 스키마로 연 DB에서도 안전하게) */
  const presentTables = () => TABLE_NAMES.filter((n) => db.tables.some((t) => t.name === n));
  return {
    playlists: {
      list: async () => (await db.playlists.toArray()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      get: (id) => db.playlists.get(id),
      getByYouTubeId: (ytId) => db.playlists.where('youtubePlaylistId').equals(ytId).first(),
      upsertByYouTubeId: (input) =>
        db.transaction('rw', db.playlists, async () => {
          const now = nowISO();
          const existing = await db.playlists.where('youtubePlaylistId').equals(input.youtubePlaylistId).first();
          if (existing) {
            const updated: Playlist = {
              ...existing,
              url: input.url,
              title: input.title || existing.title,
              channelTitle: input.channelTitle ?? existing.channelTitle ?? null,
              thumbnailUrl: input.thumbnailUrl ?? existing.thumbnailUrl ?? null,
              itemCount: input.itemCount ?? existing.itemCount ?? null,
              updatedAt: now,
            };
            await db.playlists.put(updated);
            return { playlist: updated, created: false };
          }
          const created: Playlist = {
            id: createId(),
            createdAt: now,
            updatedAt: now,
            url: input.url,
            youtubePlaylistId: input.youtubePlaylistId,
            title: input.title,
            channelTitle: input.channelTitle,
            thumbnailUrl: input.thumbnailUrl,
            itemCount: input.itemCount,
            lastSyncedAt: null,
            syncStatus: 'never',
            syncSource: null,
            lastSyncSummary: null,
          };
          await db.playlists.add(created);
          return { playlist: created, created: true };
        }),
      update: async (id, patch) => {
        await db.playlists.update(id, { ...patch, updatedAt: nowISO() });
      },
    },

    videos: {
      list: () => db.videos.orderBy('orderIndex').toArray(),
      get: (id) => db.videos.get(id),
      getByYouTubeId: (ytId) => db.videos.where('youtubeVideoId').equals(ytId).first(),
      listByStatus: (status) => db.videos.where('status').equals(status).sortBy('orderIndex'),
      update: async (id, patch) => {
        await db.videos.update(id, { ...patch, updatedAt: nowISO() });
      },
      upsertFromYouTube: (items, source) =>
        db.transaction('rw', db.videos, async () => {
          const now = nowISO();
          let nextOrder = ((await db.videos.orderBy('orderIndex').last())?.orderIndex ?? -1) + 1;
          const results: VideoUpsertResult[] = [];
          const done = new Map<string, VideoUpsertResult>();

          for (const item of items) {
            if (done.has(item.youtubeVideoId)) continue;
            const newSource: VideoSource =
              source.kind === 'playlist'
                ? { kind: 'playlist', playlistId: source.playlistId, position: item.position ?? null, addedAt: now }
                : { kind: 'manual', addedAt: now };
            const existing = await db.videos.where('youtubeVideoId').equals(item.youtubeVideoId).first();

            if (existing) {
              const sources = [...(existing.sources ?? [])];
              const idx = sources.findIndex((s) =>
                s.kind === 'playlist' && newSource.kind === 'playlist' ? s.playlistId === newSource.playlistId : s.kind === newSource.kind,
              );
              const linked = idx === -1;
              if (linked) sources.push(newSource);
              else if (newSource.kind === 'playlist') sources[idx] = { ...sources[idx], position: newSource.position } as VideoSource;

              const better = SOURCE_RANK[item.metadataSource] >= SOURCE_RANK[existing.metadataSource ?? 'manual'];
              const updated: Video = {
                ...existing,
                // 학습 상태·완료일·자막 확인 결과 등 기존 학습 데이터는 그대로 유지
                title: better && item.title ? item.title : existing.title,
                channelTitle: better ? (item.channelTitle ?? existing.channelTitle) : existing.channelTitle,
                thumbnailUrl: better ? (item.thumbnailUrl ?? existing.thumbnailUrl) : existing.thumbnailUrl,
                durationSec: item.durationSec ?? existing.durationSec,
                metadataSource: better ? item.metadataSource : existing.metadataSource,
                playlistId: existing.playlistId ?? (source.kind === 'playlist' ? source.playlistId : null),
                sources,
                updatedAt: now,
              };
              await db.videos.put(updated);
              const r = { video: updated, created: false, linked };
              done.set(item.youtubeVideoId, r);
              results.push(r);
              continue;
            }

            const created: Video = {
              id: createId(),
              createdAt: now,
              updatedAt: now,
              playlistId: source.kind === 'playlist' ? source.playlistId : null,
              youtubeVideoId: item.youtubeVideoId,
              title: item.title,
              url: `https://www.youtube.com/watch?v=${item.youtubeVideoId}`,
              thumbnailUrl: item.thumbnailUrl,
              durationSec: item.durationSec,
              orderIndex: nextOrder++,
              randomOrderKey: Math.random(),
              status: 'new',
              completedAt: null,
              sources: [newSource],
              channelTitle: item.channelTitle,
              metadataSource: item.metadataSource,
              captionCheck: null,
              startedAt: null,
            };
            await db.videos.add(created);
            const r = { video: created, created: true, linked: false };
            done.set(item.youtubeVideoId, r);
            results.push(r);
          }
          return results;
        }),
    },

    transcripts: {
      // 같은 영상에 기록이 여럿이면(예: 실패 기록 + AI 자막) 내용이 있는 자막을 먼저 보여 준다
      getByVideo: async (videoId) => {
        const all = await db.transcripts.where('videoId').equals(videoId).toArray();
        return all.find((t) => t.status === 'success' && t.segments.length > 0) ?? all[0];
      },
      save: (videoId, input) =>
        db.transaction('rw', db.transcripts, db.videos, async () => {
          const now = nowISO();
          const video = await db.videos.get(videoId);
          const existing = await db.transcripts.where('videoId').equals(videoId).toArray();
          await db.transcripts.bulkDelete(existing.map((t) => t.id));
          const record: Transcript = {
            id: createId(),
            createdAt: existing[0]?.createdAt ?? now,
            updatedAt: now,
            videoId,
            ...input,
            // 샘플 영상에 붙인 자막은 샘플 삭제 시 함께 정리되도록 표시
            ...(video?.isSample ? { isSample: true } : {}),
          };
          await db.transcripts.add(record);
          return record;
        }),
      deleteByVideo: async (videoId) => {
        await db.transcripts.where('videoId').equals(videoId).delete();
      },
    },

    expressionNotes: {
      listByVideo: async (videoId) =>
        (await db.expressionNotes.where('videoId').equals(videoId).toArray()).sort(byOrder),
      get: (id) => db.expressionNotes.get(id),
      add: async (note) => {
        await db.expressionNotes.add(note);
      },
      update: async (id, patch) => {
        await db.expressionNotes.update(id, { ...pickDefined(patch), updatedAt: nowISO() });
      },
      remove: async (id) => {
        await db.expressionNotes.delete(id);
      },
    },

    keySentences: {
      list: () => db.keySentences.toArray(),
      listByVideo: (videoId) =>
        db.keySentences
          .where('[videoId+order]')
          .between([videoId, -Infinity], [videoId, Infinity])
          .toArray(),
      getMany: async (ids) => (await db.keySentences.bulkGet(ids)).filter((x) => x != null),
      get: (id) => db.keySentences.get(id),
      add: async (sentence) => {
        await db.keySentences.add(sentence);
      },
      update: async (id, patch) => {
        // 원문 보호: 허용된 필드만 반영 (english·videoId·order 등은 무시)
        const allowed: (keyof KeySentencePatch)[] = [
          'korean',
          'situation',
          'expressionIds',
          'expressionSpans',
          'timestampSec',
          'status',
          'correctCount',
          'wrongCount',
        ];
        const safe: Record<string, unknown> = {};
        for (const k of allowed) if (patch[k] !== undefined) safe[k] = patch[k];
        await db.keySentences.update(id, { ...safe, updatedAt: nowISO() });
      },
      remove: async (id) => {
        await db.keySentences.delete(id);
      },
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
      removeSourceRef: (id, ref) =>
        db.transaction('rw', db.expressions, async () => {
          const e = await db.expressions.get(id);
          if (!e) return;
          const same = (r: SourceRef) =>
            r.videoId === ref.videoId &&
            (r.sentenceId ?? null) === (ref.sentenceId ?? null) &&
            (r.dialogueId ?? null) === (ref.dialogueId ?? null);
          const sourceRefs = e.sourceRefs.filter((r) => !same(r));
          if (sourceRefs.length !== e.sourceRefs.length) await db.expressions.update(id, { sourceRefs, updatedAt: nowISO() });
        }),
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
        for (const name of presentTables()) {
          const table = db.table(name);
          const total = await table.count();
          const sample = name === 'appMeta' ? 0 : await table.filter((r: { isSample?: boolean }) => r.isSample === true).count();
          result.push({ table: name, label: TABLE_LABELS[name], total, sample });
        }
        return result;
      },
      hasSampleData: async () => {
        for (const name of presentTables()) {
          if (name === 'appMeta') continue;
          const n = await db.table(name).filter((r: { isSample?: boolean }) => r.isSample === true).count();
          if (n > 0) return true;
        }
        return false;
      },
      deleteSampleData: async () => {
        let deleted = 0;
        const tables = presentTables().filter((n) => n !== 'appMeta').map((n) => db.table(n));
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
        const tables = presentTables().map((n) => db.table(n));
        await db.transaction('rw', tables, async () => {
          for (const table of tables) await table.clear();
        });
      },
    },
  };
}
