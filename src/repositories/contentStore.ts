import type { StudyDatabase } from '@/db/database';
import { DAY_EXCLUSIONS_META_KEY, excludedSetOf, isOriginalCandidate, parseDayExclusions, type DayExclusions } from '@/services/days/daySeries';
import type { AiTaskRequest } from '@/types/aiApi';
import type { DayAssignment, Dialogue, DialogueProgress, Expression, ExtractionDraft, ExtractionJob, KeySentence, LearningItem, ReviewState, Transcript, Video } from '@/types/models';
import { hasContent, type ContentContext, type ContentPlan } from '@/services/content/contentService';
import { hasDayDialogue, type PackContext, type PackPlan } from '@/services/prep/packService';

/**
 * 학습 콘텐츠(문장·Chunk)·통합 대화문 저장소
 *
 * 쓰기 범위
 * - 추가만: keySentences · expressions · learningItems · dialogues 에 새 레코드를 더한다 (기존 레코드는 바꾸지 않음)
 * - 사용자 선택 표시: AI가 만든 문장·Chunk 레코드의 selected 값만 바꾼다
 * - 진행 중 AI 요청: appMeta 새 키 'aiTasks' (같은 요청 식별자로 이어서 조회하기 위해)
 */

export const META_AI_TASKS = 'aiTasks';
/** 학습 자료 자동 생성 대기열 상태 (appMeta 새 키) */
export const META_PREP = 'prepState';

export interface PrepVideoState {
  status: 'failed' | 'skipped';
  /** dayuser: Day 1~100 영상의 Day 자료 (사용자 문장) */
  stage: 'transcript' | 'pack' | 'daypack' | 'dayuser';
  error: { code: string; message: string; httpStatus: number | null };
  attempts: number;
  updatedAt: string;
}

export interface PrepState {
  /** '기존 영상 자료 만들기 시작'을 누름 → 모든 영상의 빠진 자료를 차례로 */
  allStarted: boolean;
  /** 새로 등록·'학습 시작'으로 넣은 영상 (먼저 처리) */
  queue: string[];
  /** 실패·건너뜀 기록 (성공하면 지움) */
  videos: Record<string, PrepVideoState>;
  /** '실패만 다시 시도'로 다음 한 번은 결과를 모르는 실패도 다시 요청 */
  retry: string[];
  pausedUntil: string | null;
  pauseReason: string | null;
  pauseMessage: string | null;
  /** 사용자가 직접 넣은 영상(버튼·다시 시도) — 자동 준비 몫으로 세지 않는다. 없으면 [] */
  manual?: string[];
  /** Gemini 한도 초과로 보류된 횟수 (영상별) — 초기화 뒤 1번만 이어서 보낸다 */
  held?: Record<string, number>;
  /** 자동 준비 몫을 다 써서 자동 영상만 멈춘 시각 (이 시각까지 사용자가 넣은 영상만 처리) */
  autoPausedUntil?: string | null;
  /** Gemini 처리 실패로 대기열을 멈춤 — 사용자가 '이어서 만들기'를 누를 때까지 (앱을 다시 열어도 그대로) */
  stopped?: { code: string; message: string; at: string } | null;
  updatedAt: string;
}

export const emptyPrepState = (): PrepState => ({ allStarted: false, queue: [], videos: {}, retry: [], pausedUntil: null, pauseReason: null, pauseMessage: null, updatedAt: new Date(0).toISOString() });

export interface PrepOverview {
  videos: Video[];
  transcripts: Transcript[];
  days: DayAssignment[];
  sentences: KeySentence[];
  items: LearningItem[];
  dialogues: Dialogue[];
  jobs: ExtractionJob[];
  drafts: ExtractionDraft[];
  /** Day 자료에서 뺀 문장 (appMeta 'dayExclusions', 없으면 빈 값) */
  dayExclusions: DayExclusions;
}

/** 뺀 문장 바꾸기 결과 — ok 말고는 아무것도 바꾸지 않음 */
export type DayExclusionResult = 'ok' | 'not_found' | 'not_user_sentence' | 'has_material';

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
  /** 이 영상 학습 항목의 표현 */
  expressions: Expression[];
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
  /** 누적 복습 일정 계산용 (읽기만) */
  readReviewInput(): Promise<{ dialogues: Dialogue[]; progress: DialogueProgress[]; reviewStates: ReviewState[]; days: DayAssignment[] }>;
  getPrep(): Promise<PrepState>;
  /** 읽고 바꾸기 (한 트랜잭션) */
  updatePrep(fn: (s: PrepState) => PrepState): Promise<PrepState>;
  readPrepOverview(): Promise<PrepOverview>;
  /** 공통 Chunk·Day 대화문 저장 — 추가만. 이미 Day 대화문이 있으면 null */
  /** Day 정리 목록 (읽기 전용 — 영상 목록의 Day/일반 구분용) */
  listDayAssignments(): Promise<DayAssignment[]>;
  /** 이 영상에서 Day 자료에서 뺀 문장 id */
  getDayExcluded(videoId: string): Promise<Set<string>>;
  /**
   * Day 자료에서 빼기·다시 넣기 — appMeta 'dayExclusions' 기록만 바꾼다 (문장·학습·복습 기록은 그대로).
   * 사용자 문장·영상 원문 후보만, 그 영상에 Day 자료(AI Day 대화문)가 아직 없을 때만. 요청 대기·진행 중 확인은 대기열이 한다
   */
  setDayExcluded(videoId: string, sentenceId: string, excluded: boolean): Promise<DayExclusionResult>;
  applyPack(videoId: string, plan: (ctx: Omit<PackContext, 'content' | 'pack' | 'requestId' | 'now' | 'newId' | 'dayNumber'>) => PackPlan): Promise<PackPlan | null>;
  readDialogueStudy(dialogueId: string): Promise<{ dialogue: Dialogue; progress: DialogueProgress | undefined; sentences: KeySentence[] } | null>;
  /** 이 대화문의 암기 진도만 저장 */
  putDialogueProgress(p: DialogueProgress): Promise<void>;
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
      const expressions = (await db.expressions.bulkGet([...new Set(items.map((i) => i.expressionId))])).filter((e): e is Expression => !!e);
      return { video, transcript, day, sentences, items, expressions };
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
    readReviewInput: () =>
      db.transaction('r', [db.dialogues, db.dialogueProgress, db.reviewStates, db.dayAssignments], async () => ({
        dialogues: await db.dialogues.toArray(),
        progress: await db.dialogueProgress.toArray(),
        reviewStates: await db.reviewStates.where('itemType').equals('dialogue').toArray(),
        days: await db.dayAssignments.toArray(),
      })),
    getPrep: async () => ({ ...emptyPrepState(), ...(((await db.appMeta.get(META_PREP))?.value as Partial<PrepState> | undefined) ?? {}) }),
    updatePrep: (fn) =>
      db.transaction('rw', db.appMeta, async () => {
        const cur = { ...emptyPrepState(), ...(((await db.appMeta.get(META_PREP))?.value as Partial<PrepState> | undefined) ?? {}) };
        const next = { ...fn(cur), updatedAt: new Date().toISOString() };
        await db.appMeta.put({ key: META_PREP, value: next });
        return next;
      }),
    readPrepOverview: () =>
      db.transaction('r', [db.videos, db.transcripts, db.dayAssignments, db.keySentences, db.learningItems, db.dialogues, db.extractionJobs, db.extractionDrafts, db.appMeta], async () => ({
        videos: await db.videos.toArray(),
        transcripts: await db.transcripts.toArray(),
        days: await db.dayAssignments.toArray(),
        sentences: await db.keySentences.toArray(),
        items: await db.learningItems.toArray(),
        dialogues: await db.dialogues.toArray(),
        jobs: await db.extractionJobs.toArray(),
        drafts: await db.extractionDrafts.toArray(),
        dayExclusions: parseDayExclusions((await db.appMeta.get(DAY_EXCLUSIONS_META_KEY))?.value),
      })),
    listDayAssignments: () => db.dayAssignments.toArray(),
    getDayExcluded: async (videoId) => excludedSetOf(parseDayExclusions((await db.appMeta.get(DAY_EXCLUSIONS_META_KEY))?.value), videoId),
    setDayExcluded: (videoId, sentenceId, excluded) =>
      db.transaction('rw', [db.appMeta, db.keySentences, db.dialogues], async (): Promise<DayExclusionResult> => {
        const s = await db.keySentences.get(sentenceId);
        if (!s || s.videoId !== videoId) return 'not_found';
        // Day 자료 재료만: 사용자 문장 또는 영상 원문 후보(AI가 자막에서 찾은 번호 문장). 그 밖의 AI 문장은 거절
        if (s.origin === 'ai_extracted' && !isOriginalCandidate(s)) return 'not_user_sentence';
        if (hasDayDialogue(await db.dialogues.where('videoId').equals(videoId).toArray(), videoId)) return 'has_material';
        const all = parseDayExclusions((await db.appMeta.get(DAY_EXCLUSIONS_META_KEY))?.value);
        const ids = new Set(all[videoId] ?? []);
        if (excluded) ids.add(sentenceId);
        else ids.delete(sentenceId);
        const next = { ...all };
        if (ids.size) next[videoId] = [...ids];
        else delete next[videoId];
        await db.appMeta.put({ key: DAY_EXCLUSIONS_META_KEY, value: next });
        return 'ok';
      }),
    applyPack: (videoId, plan) =>
      db.transaction('rw', [db.videos, db.keySentences, db.expressions, db.learningItems, db.dialogues], async () => {
        const video = await db.videos.get(videoId);
        if (!video) return null;
        const existingDialogues = await db.dialogues.where('videoId').equals(videoId).toArray();
        if (hasDayDialogue(existingDialogues, videoId)) return null;
        const existingSentences = await db.keySentences.where('videoId').equals(videoId).toArray();
        const existingItems = await db.learningItems.where('videoId').equals(videoId).toArray();
        const expressions = await db.expressions.toArray();
        const p = plan({ video, existingSentences, existingItems, existingDialogues, expressionIdByKey: new Map(expressions.map((e) => [e.normalizedKey, e.id])) });
        if (p.sentences.length) await db.keySentences.bulkAdd(p.sentences);
        if (p.expressions.length) await db.expressions.bulkAdd(p.expressions);
        if (p.items.length) await db.learningItems.bulkAdd(p.items);
        if (p.dialogue) await db.dialogues.add(p.dialogue);
        return p;
      }),
    readDialogueStudy: async (dialogueId) => {
      const dialogue = await db.dialogues.get(dialogueId);
      if (!dialogue) return null;
      const ids = dialogue.lines.map((l) => l.sourceSentenceId).filter((x): x is string => !!x);
      const [progress, sentences] = await Promise.all([db.dialogueProgress.where('dialogueId').equals(dialogueId).first(), db.keySentences.bulkGet(ids)]);
      return { dialogue, progress, sentences: sentences.filter((s): s is KeySentence => !!s) };
    },
    putDialogueProgress: async (p) => {
      // 다른 대화문의 진도는 건드리지 않는다 (dialogueId 고유)
      const cur = await db.dialogueProgress.where('dialogueId').equals(p.dialogueId).first();
      await db.dialogueProgress.put({ ...p, id: cur?.id ?? p.id });
    },
    addDialogue: (d) =>
      db.transaction('rw', db.dialogues, async () => {
        if (await db.dialogues.get(d.id)) return false;
        await db.dialogues.add(d);
        return true;
      }),
  };
}
