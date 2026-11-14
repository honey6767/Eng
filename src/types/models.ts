/**
 * My English Study — 도메인 모델
 *
 * 1단계에서 전체 8단계에 필요한 데이터 구조를 미리 정의한다.
 * - 모든 레코드는 문자열 id를 가지며(UUID), Supabase 등 원격 DB로 이전 시 그대로 PK로 사용 가능하다.
 * - 날짜는 모두 ISO 8601 문자열로 저장한다. (IndexedDB/JSON/Postgres 간 이식성)
 * - isSample=true 인 레코드는 테스트용 샘플 데이터이며, 사용자 데이터와 분리해 삭제할 수 있다.
 */

export type ISODateString = string;

/** 공통 메타 필드 */
export interface BaseRecord {
  id: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  /** 테스트용 샘플 데이터 여부 */
  isSample?: boolean;
}

// ─────────────────────────────────────────────
// 재생목록 / 영상
// ─────────────────────────────────────────────

export interface Playlist extends BaseRecord {
  url: string;
  /** YouTube 재생목록 ID (list= 파라미터) */
  youtubePlaylistId: string | null;
  title: string;
  /** 영상 목록을 마지막으로 불러온 시각 (불러온 적 없으면 null) */
  lastSyncedAt: ISODateString | null;
  /** 마지막 동기화 결과 */
  syncStatus: 'never' | 'success' | 'failed';
  syncError?: string;
}

/** 영상 학습 상태 */
export type VideoStatus = 'new' | 'in_progress' | 'completed';

export interface Video extends BaseRecord {
  playlistId: string | null;
  youtubeVideoId: string | null;
  title: string;
  url: string | null;
  thumbnailUrl: string | null;
  durationSec: number | null;
  /** 재생목록 내 원래 순서 */
  orderIndex: number;
  /** 신규 영상 무작위 학습 순서용 키 (2단계에서 사용) */
  randomOrderKey: number;
  status: VideoStatus;
  completedAt: ISODateString | null;
}

// ─────────────────────────────────────────────
// 자막
// ─────────────────────────────────────────────

export type TranscriptSource = 'youtube' | 'manual_paste';
export type TranscriptStatus = 'not_attempted' | 'success' | 'failed';

export interface TranscriptSegment {
  /** 타임스탬프가 없는 자막이면 null */
  startSec: number | null;
  endSec: number | null;
  text: string;
}

export interface Transcript extends BaseRecord {
  videoId: string;
  source: TranscriptSource;
  status: TranscriptStatus;
  /** 사용자가 붙여넣은 원본 또는 가져온 원문 */
  rawText: string;
  segments: TranscriptSegment[];
  errorMessage?: string;
}

// ─────────────────────────────────────────────
// 영상 앞부분 주요 표현 노트 (미리보기)
// ─────────────────────────────────────────────

/**
 * 출처 구분
 * - video: 영상(자막) 설명에서 확인한 내용
 * - ai_supplement: AI가 추가한 보충 설명
 * - user: 사용자가 직접 입력
 */
export type ContentOrigin = 'video' | 'ai_supplement' | 'user';

export interface SimilarExpression {
  expression: string;
  difference: string;
}

export interface ExpressionNote extends BaseRecord {
  videoId: string;
  /** 연결된 표현(Expression) id */
  expressionId: string | null;
  expression: string;
  meaningKo: string;
  usageContext: string;
  nuance: string;
  examples: { en: string; ko: string }[];
  similar: SimilarExpression[];
  /** 원본 영상 타임스탬프(초) */
  sourceTimestampSec: number | null;
  origin: ContentOrigin;
  /** 영상 설명 내용을 확인했는지 여부. 확인하지 못했다면 needs_check */
  verification: 'confirmed' | 'needs_check';
  order: number;
}

// ─────────────────────────────────────────────
// 핵심 문장 5개
// ─────────────────────────────────────────────

export type LearningStatus = 'not_started' | 'learning' | 'reviewing' | 'memorized';

export interface KeySentence extends BaseRecord {
  videoId: string;
  /** 1~5 */
  order: number;
  /** 영상 원문 그대로 보존 */
  english: string;
  korean: string;
  expressionIds: string[];
  situation: string;
  timestampSec: number | null;
  status: LearningStatus;
  correctCount: number;
  wrongCount: number;
}

// ─────────────────────────────────────────────
// 대화문
// ─────────────────────────────────────────────

export type Speaker = 'A' | 'B';

/**
 * 대화 한 줄은 여러 세그먼트로 구성된다.
 * - key: 핵심 학습 문장 (keySentenceId로 원문과 연결)
 * - connector: 자연스러운 대화를 위해 추가한 연결 문장 (학습 대상과 구분)
 */
export interface DialogueSegment {
  kind: 'key' | 'connector';
  text: string;
  keySentenceId?: string;
  /** 원문 문장을 수정했다면 수정 전 원문과 이유를 기록 */
  modification?: { originalText: string; reason: string };
}

export interface DialogueLine {
  id: string;
  order: number;
  speaker: Speaker;
  segments: DialogueSegment[];
  korean: string;
}

/**
 * - original: 영상 핵심 문장 5개로 재구성한 원본 대화문
 * - combined: 누적 취약 표현으로 새로 만든 조합 대화문 (7단계)
 */
export type DialogueKind = 'original' | 'combined';
export type DialogueGeneratedBy = 'sample' | 'manual' | 'ai';

export interface Dialogue extends BaseRecord {
  kind: DialogueKind;
  /** original일 때 출처 영상 */
  videoId: string | null;
  /** combined일 때 표현 출처가 되는 영상들 */
  sourceVideoIds: string[];
  /** 같은 영상 안에서의 순서 (대화문 1, 2, 3) */
  orderInVideo: number;
  title: string;
  situation: string;
  lines: DialogueLine[];
  /** 대화문에 포함된 학습 표현 */
  expressionIds: string[];
  generatedBy: DialogueGeneratedBy;
  /** 분리/구성 이유 등 메모 */
  compositionNote?: string;
  isFavorite: boolean;
}

/** 영상별 대화문 구성 결과 — 대화문에 넣지 못한 문장은 별도 연습 대상 */
export interface DialogueComposition extends BaseRecord {
  videoId: string;
  dialogueIds: string[];
  /** 자연스럽게 연결하지 못해 별도 연습 대상으로 남긴 핵심 문장 */
  leftoverSentenceIds: string[];
  note?: string;
}

// ─────────────────────────────────────────────
// 표현 (중복 없이 하나의 표현에 이력 누적)
// ─────────────────────────────────────────────

export interface SourceRef {
  videoId: string | null;
  dialogueId?: string | null;
  sentenceId?: string | null;
}

export interface Expression extends BaseRecord {
  /** 중복 판별용 정규화 키 (소문자, 공백/구두점 정리) — 고유 인덱스 */
  normalizedKey: string;
  text: string;
  meaningKo: string;
  sourceRefs: SourceRef[];
  isFavorite: boolean;
  /** 사용자가 직접 어렵다고 표시 */
  isMarkedDifficult: boolean;
}

// ─────────────────────────────────────────────
// 복습 상태 (에빙하우스 기반 간격 반복)
// ─────────────────────────────────────────────

export type ReviewItemType = 'expression' | 'sentence' | 'dialogue';

/** 학습 결과 자기 평가 */
export type Rating = 'wrong' | 'hard' | 'easy';

export interface ReviewState {
  /** `${itemType}:${itemId}` */
  id: string;
  itemType: ReviewItemType;
  itemId: string;
  correctCount: number;
  wrongCount: number;
  lastResult: Rating | null;
  lastStudiedAt: ISODateString | null;
  nextReviewAt: ISODateString | null;
  /** 0(완벽) ~ 100(매우 취약) */
  weakness: number;
  /** 연속 정답 횟수 */
  streak: number;
  /** 추천 간격 단계 인덱스 (0=직후, 1=1일, 2=3일 ...) */
  intervalIndex: number;
  reviewCount: number;
  /** 최근 출제 시각 — 랜덤 테스트 다양성 유지용 */
  lastQuizzedAt: ISODateString | null;
  isSample?: boolean;
}

// ─────────────────────────────────────────────
// 대화문 5단계 진행도
// ─────────────────────────────────────────────

export type MemorizeStep = 1 | 2 | 3 | 4 | 5;

export interface StepResult {
  step: MemorizeStep;
  /** 0~1 */
  accuracy: number;
  rating: Rating | null;
  completedAt: ISODateString;
}

export interface DialogueProgress {
  /** dialogueId와 동일 */
  id: string;
  dialogueId: string;
  currentStep: MemorizeStep;
  /** 지금까지 완료한 가장 높은 단계 (0=시작 전) */
  highestCompletedStep: 0 | MemorizeStep;
  stepResults: StepResult[];
  memorized: boolean;
  memorizedAt: ISODateString | null;
  /** 3단계 적응형 빈칸: 세그먼트별 숙련도 (키: lineId:segmentIndex) */
  blankMastery: Record<string, number>;
  updatedAt: ISODateString;
  isSample?: boolean;
}

// ─────────────────────────────────────────────
// 학습 기록 (오늘/주간 학습량, 누적 복습 횟수, 정답/오답 기록)
// ─────────────────────────────────────────────

export type StudyActivity =
  | 'dialogue_step'
  | 'expression_review'
  | 'sentence_review'
  | 'random_test'
  | 'preview';

export interface StudyLog {
  id: string;
  timestamp: ISODateString;
  /** 로컬 기준 YYYY-MM-DD — 일별 집계용 인덱스 */
  date: string;
  activity: StudyActivity;
  itemType: ReviewItemType;
  itemId: string;
  step?: MemorizeStep;
  rating?: Rating;
  /** 0~1 */
  accuracy?: number;
  isReview: boolean;
  isSample?: boolean;
}

// ─────────────────────────────────────────────
// 앱 메타 (설정, 스키마 버전 등)
// ─────────────────────────────────────────────

export interface AppMeta {
  key: string;
  value: unknown;
}
