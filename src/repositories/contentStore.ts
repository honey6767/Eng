import type { StudyDatabase } from '@/db/database';
import type { AiTaskRequest } from '@/types/aiApi';
import type { DayAssignment, Dialogue, Expression, KeySentence, LearningItem, ReviewState, Transcript, Video } from '@/types/models';
import { hasContent, type ContentContext, type ContentPlan } from '@/services/content/contentService';

/**
 * 학습 콘텐츠(문장·Chunk)·통합 대화문 저장소
 *
 * 쓰기 범위
 * - 추가만: keySentences · expressions · learningItems · dialogues 에 새 레코드를 더한다 (기존 레코드는 바꾸지 않음)
 * - 사용자 선택 표시: AI가 만든 문장·Chunk 레코드의 selected 값만 바꾼다
 * - 진행 중 AI 요청: appMeta 새 키 'aiTasks' (같은 요청 식별자로 이어서 조회하기 위해)
 */

export const META_AI_TASKS = 'aiTasks';

export interface AiTaskState {
  requestId: string;
  body: AiTaskRequest;
  status: 'sent' | 'succeeded' | 'applied' | 'failed';
  startedAt: string;
  updatedAt: string;
  /** 받은 결과 (저장 전까지만 보관, 저장 후 지움) */
  resultText: string | null;
  error: { code: string; message: string; httpStatus: number | null } | null;
}

export interface VideoContentContext {
  video: Video;
  transcript: Transcript | undefined;
  day: DayAssignment | undefined;
  sentences: KeySentence[];
  items: LearningItem[];
}

export interface CombineContext {
  videos: Video[];
  days: DayAssignment[];
  items: LearningItem[];
  expressions: Expression[];
  sentences: KeySentence[];
  expressionReviews: ReviewState[];
}

export interface ContentStore {
  getTask(key: string): Promise<AiTaskState | null>;
  putTask(key: string, state: AiTaskState | null): Promise<void>;
  readVideo(videoId: string): Promise<VideoContentContext | null>;
  /** 한 트랜잭션 안에서 지금 상태를 다시 읽어 계획을 만들고 추가만 한다. 이미 저장돼 있으면 null */
  applyContent(videoId: string, plan: (ctx: Omit<ContentContext, 'result' | 'requestId' | 'now' | 'newId' | 'dayNumber'>) => ContentPlan): Promise<ContentPlan | null>;
  setSentenceSelected(id: string, selected: boolean): Promise<void>;
  setChunkSelected(id: string, selected: boolean): Promise<void>;
  readCombine(): Promise<CombineContext>;
  /** 같은 id가 있으면 그대로 두고 false */
  addDialogue(d: Dialogue): Promise<boolean>;
}

export function createContentStore(db: StudyDatabase): ContentStore {
  const readTasks = async () => ((await db.appMeta.get(META_AI_TASKS))?.value as Record<string, AiTaskState> | undefined) ?? {};
  return {
    getTask: async (key) => (await readTasks())[key] ?? null,
    putTask: (key, state) =>
      db.transaction('rw', db.appMeta, async () => {
        const all = { ...(await readTasks()) };
        if (state) all[key] = state;
        else delete all[key];
        await db.appMeta.put({ key: META_AI_TASKS, value: all });
      }),
    readVideo: async (videoId) => {
      const video = await db.videos.get(videoId);
      if (!video) return null;
      const [transcripts, day, sentences, items] = await Promise.all([
        db.transcripts.where('videoId').equals(videoId).toArray(),
        db.dayAssignments.where('videoId').equals(videoId).first(),
        db.keySentences.where('videoId').equals(videoId).toArray(),
        db.learningItems.where('videoId').equals(videoId).toArray(),
      ]);
      const transcript = transcripts.find((t) => t.status === 'success' && (t.segments.length > 0 || t.rawText.trim().length > 0));
      return { video, transcript, day, sentences, items };
    },
    applyContent: (videoId, plan) =>
      db.transaction('rw', [db.videos, db.keySentences, db.expressions, db.learningItems], async () => {
        const video = await db.videos.get(videoId);
        if (!video) return null;
        const existingSentences = await db.keySentences.where('videoId').equals(videoId).toArray();
        const existingItems = await db.learningItems.where('videoId').equals(videoId).toArray();
        if (hasContent(existingSentences, existingItems)) return null;
        const expressions = await db.expressions.toArray();
        const p = plan({ video, existingSentences, existingItems, expressionIdByKey: new Map(expressions.map((e) => [e.normalizedKey, e.id])) });
        if (p.sentences.length) await db.keySentences.bulkAdd(p.sentences);
        if (p.expressions.length) await db.expressions.bulkAdd(p.expressions);
        if (p.items.length) await db.learningItems.bulkAdd(p.items);
        return p;
      }),
    setSentenceSelected: async (id, selected) => {
      const s = await db.keySentences.get(id);
      if (s?.origin === 'ai_extracted') await db.keySentences.update(id, { selected });
    },
    setChunkSelected: async (id, selected) => {
      const li = await db.learningItems.get(id);
      if (li) await db.learningItems.update(id, { selected });
    },
    readCombine: () =>
      db.transaction('r', [db.videos, db.dayAssignments, db.learningItems, db.expressions, db.keySentences, db.reviewStates], async () => ({
        videos: await db.videos.toArray(),
        days: await db.dayAssignments.toArray(),
        items: await db.learningItems.toArray(),
        expressions: await db.expressions.toArray(),
        sentences: await db.keySentences.toArray(),
        expressionReviews: await db.reviewStates.where('itemType').equals('expression').toArray(),
      })),
    addDialogue: (d) =>
      db.transaction('rw', db.dialogues, async () => {
        if (await db.dialogues.get(d.id)) return false;
        await db.dialogues.add(d);
        return true;
      }),
  };
}
