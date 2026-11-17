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

/** 영상/재생목록 정보를 어디서 가져왔는지 */
export type MetadataSource =
  /** YouTube Data API (전체 정보) */
  | 'youtube_api'
  /** oEmbed (API 키 없이: 제목·썸네일만, 길이 없음) */
  | 'oembed'
  /** 재생목록 RSS 피드 (API 키 없이: 최근 15개만) */
  | 'rss'
  /** 서버 연결 없이 URL에서 ID만 추출해 직접 등록 */
  | 'manual'
  | 'sample';

export interface PlaylistSyncSummary {
  /** 재생목록에서 확인한 항목 수 */
  totalItems: number;
  added: number;
  /** 이미 등록된 영상에 출처만 연결 */
  linked: number;
  /** 비공개/삭제 등으로 불러올 수 없는 영상 */
  unavailable: number;
  /** 전체를 가져왔는지 (RSS 제한 모드는 false) */
  complete: boolean;
}

export interface Playlist extends BaseRecord {
  url: string;
  /** YouTube 재생목록 ID (list= 파라미터) */
  youtubePlaylistId: string | null;
  title: string;
  channelTitle?: string | null;
  thumbnailUrl?: string | null;
  /** YouTube가 알려준 항목 수 */
  itemCount?: number | null;
  /** 영상 목록을 마지막으로 불러온 시각 (불러온 적 없으면 null) */
  lastSyncedAt: ISODateString | null;
  /** 마지막 동기화 결과 */
  syncStatus: 'never' | 'success' | 'failed';
  syncError?: string;
  syncSource?: MetadataSource | null;
  lastSyncSummary?: PlaylistSyncSummary | null;
}

/** 영상 학습 상태 */
export type VideoStatus = 'new' | 'in_progress' | 'completed';

/**
 * 영상이 어떤 경로로 등록되었는지 (중복 영상은 하나의 레코드에 출처만 누적)
 * - playlist: 재생목록 동기화로 등록 (position은 재생목록 내 순서, 0부터)
 * - manual: 개별 영상 URL로 등록
 */
export type VideoSource =
  | { kind: 'playlist'; playlistId: string; position: number | null; addedAt: ISODateString }
  | { kind: 'manual'; addedAt: ISODateString };

/** 자막 자동 가져오기 시도 결과 (공식 API captions.list 기준) */
export interface CaptionCheck {
  checkedAt: ISODateString;
  result:
    /** 자막 트랙은 있지만 공식 API로 내용을 내려받을 권한이 없음 (소유자/편집자만 가능) */
    | 'tracks_found_no_permission'
    /** 영상에 자막 트랙이 없음 */
    | 'no_tracks'
    /** API 키 미설정 등으로 확인 불가 */
    | 'not_configured'
    | 'quota_exceeded'
    | 'error';
  tracks: { language: string; name: string; kind: 'standard' | 'asr' | 'forced' | string }[];
  message: string;
}

export interface Video extends BaseRecord {
  /** 처음 등록된 재생목록 (호환용). 전체 출처는 sources 참고 */
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
  /** v2 — 등록 경로(출처) 목록 */
  sources: VideoSource[];
  /** v2 */
  channelTitle: string | null;
  /** v2 — 정보 출처 */
  metadataSource: MetadataSource | null;
  /** v2 — 자막 자동 가져오기 확인 결과 */
  captionCheck: CaptionCheck | null;
  /** v2 — 처음 학습을 시작한 시각 */
  startedAt?: ISODateString | null;
}

// ─────────────────────────────────────────────
// 자막
// ─────────────────────────────────────────────

/** ai_transcription: B1 — Gemini가 전사하고 앱이 자동 적용한 자막 (새로 추가한 기록에만) */
export type TranscriptSource = 'youtube' | 'manual_paste' | 'ai_transcription';
/** 붙여넣은 자막의 형식 */
export type TranscriptFormat = 'srt' | 'vtt' | 'timestamped' | 'plain';
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
  /** v2 */
  format?: TranscriptFormat | null;
  /** B1 — AI 자막일 때만: 사람이 확인하지 않음(ai_unverified) / 품질 경고가 있어 확인 권장(needs_review) */
  verification?: 'ai_unverified' | 'needs_review' | null;
  /** B1 — 이 자막을 만든 AI 초안 */
  extractionDraftId?: string | null;
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

/**
 * 3단계 — 핵심 문장 안에서 핵심 표현이 차지하는 위치 (english 기준 글자 위치, end는 미포함).
 * 5단계 빈칸 위치로 사용한다. 'slipped my mind'처럼 형태가 바뀐 표현도 정확히 가리키기 위함.
 */
export interface ExpressionSpan {
  expressionId: string;
  start: number;
  end: number;
}

/** 3단계 — 핵심 문장을 어디서 가져왔는지 */
export type KeySentenceOrigin = 'transcript' | 'manual' | 'ai_extracted';

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
  /** 3단계(선택) — 핵심 표현 위치. 없으면 표현 텍스트로 자동 탐색 */
  expressionSpans?: ExpressionSpan[];
  /** 3단계(선택) — 선정 경로 */
  origin?: KeySentenceOrigin;
  /** AI 추출 문장 — 영상에 나온 번호 그대로 (order는 영상 안 정렬·중복 방지용) */
  aiNumber?: number;
  /** 사용자가 '암기할 문장'으로 고름 */
  selected?: boolean;
  /** 이 문장을 만든 AI 요청 식별자 */
  contentRequestId?: string;
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
  /** 통합 대화문 — 이 부분이 어떤 학습 Chunk(학습 항목)인지 */
  learningItemId?: string;
}

export interface DialogueLine {
  id: string;
  order: number;
  speaker: Speaker;
  segments: DialogueSegment[];
  korean: string;
  /** Day 통합 대화문 — 이 줄이 원문 문장을 그대로(또는 거의 그대로) 쓴 경우 그 핵심 문장 id */
  sourceSentenceId?: string;
}

/**
 * 빈칸 암기 자료 — 줄마다 단어별 빈칸 순위. 단어 순서는 wordsOf(영어 문장)과 같다
 * - version 1: 1=핵심 Chunk, 2=주요 단어, 3=나머지
 * - version 2: 1=핵심 Chunk, 2=추가 덩어리 표현, 3=주요 단어, 4=나머지
 */
export interface BlankPlan {
  version: 1 | 2;
  lines: Record<string, number[]>;
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
  /** 통합 대화문 — 사용한 Chunk와 그 출처·의미·뉘앙스 */
  chunkUsages?: DialogueChunkUsage[];
  /** 통합 대화문 — 사용한 Chunk의 출처 Day (일반 영상은 제외) */
  sourceDays?: number[];
  /** 생성에 쓰려고 골랐지만 대화문에 쓰지 않은 Chunk */
  unusedLearningItemIds?: string[];
  /** 이 대화문을 만든 AI 요청 식별자 */
  aiRequestId?: string;
  /** 빈칸 암기 자료 (AI 없이 기기에서 계산) */
  blankPlan?: BlankPlan;
}

export interface DialogueChunkUsage {
  learningItemId: string;
  /** core = 강사가 가르친 핵심 Chunk, extra = AI가 찾은 추가 덩어리 표현 (없으면 core) */
  kind?: 'core' | 'extra';
  expressionId: string;
  /** 학습한 형태 */
  text: string;
  /** 대화 속 실제 형태 */
  usedAs: string;
  dayNumber: number | null;
  videoId: string | null;
  meaningInContext: string;
  nuance: string;
  whyUsed: string;
  example: { en: string; ko: string };
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
  /** B1 — AI 추출로 새로 만든 표현에만 */
  origin?: 'ai_extracted';
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
  /** 빈칸 양 (0~100, 단계별) — 사용자가 조절 */
  blankLevels?: Partial<Record<MemorizeStep, number>>;
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

// ─────────────────────────────────────────────
// B1 — DB v3 새 테이블 (기존 12개 테이블은 그대로, 여기에 기록만 추가)
// ─────────────────────────────────────────────

/** 학습 대상의 종류: 핵심 표현 · 영상 속 Chunk · 대화문 Chunk */
/** core = 영상(Day)의 공통 핵심 Chunk (여러 원문 문장에 반복되는 표현) */
export type LearningItemKind = 'key' | 'intro_chunk' | 'dialogue_chunk' | 'chunk' | 'core';

/** 문장 속 Chunk 설명 (AI 학습 콘텐츠) */
export interface ChunkDetail {
  /** 이 문장에서의 뜻 */
  meaningInSentence: string;
  nuance: string;
  /** 어떤 상황에서 쓰는지 */
  usage: string;
  /** 비슷한 표현과의 차이 */
  comparison: string;
  examples: { en: string; ko: string }[];
  /** 떨어진 표현의 구성 단어 (예: ["could", "use"] — "could seriously use"에도 맞음) */
  parts?: string[];
  /** 원문에 나온 실제 형태 (예: "could seriously use") */
  surface?: string;
  /** 핵심 Chunk — 강사가 강의에서 설명한 부분 (자막 인용) */
  taught?: string;
}
/** Day 영상에서 왔는지(day), 그 밖의 영상인지(other) */
export type LearningItemSourceType = 'day' | 'other';
export type LearningItemOrigin = 'migrated' | 'user' | 'ai_extracted';
export type LearningItemStatus = 'confirmed' | 'needs_review';

/** 출처별 학습 대상 — 같은 표현이라도 출처(영상·종류·대화문)마다 하나씩 */
export interface LearningItem extends BaseRecord {
  expressionId: string;
  videoId: string | null;
  sourceType: LearningItemSourceType;
  /** Day 번호 (sourceType=other면 null) */
  dayNumber: number | null;
  kind: LearningItemKind;
  /** 대화문 Chunk일 때 */
  dialogueId: string | null;
  /** 영상 원문 문장 그대로 */
  sourceText: string | null;
  timestampSec: number | null;
  /** 화면 자막에서만 찾음 */
  onScreen: boolean;
  origin: LearningItemOrigin;
  status: LearningItemStatus;
  /** AI 초안에서 왔을 때 */
  extractionDraftId: string | null;
  /** v2 핵심 문장에서 옮겨 왔을 때 (기존 핵심 문장은 그대로 둔다) */
  legacyKeySentenceId: string | null;
  /** kind='chunk' — 이 Chunk가 들어 있는 원문 문장 (핵심 문장 id) */
  sentenceId?: string | null;
  /** kind='chunk' — 뜻·뉘앙스·상황·비교·예문 */
  chunk?: ChunkDetail;
  /** 사용자가 '암기할 Chunk'로 고름 */
  selected?: boolean;
  /** 이 항목을 만든 AI 요청 식별자 (문장·Chunk 생성) */
  contentRequestId?: string;
  /** kind='core' — 이 공통 Chunk가 나오는 원문 문장과 그 문장 속 실제 형태 */
  occurrences?: { sentenceId: string; surface: string }[];
  /** kind='chunk' — 'extra' = 강사가 가르치지 않았지만 AI가 문맥에서 찾은 추가 덩어리 표현 (새 기준으로 만든 항목에만) */
  chunkRole?: 'extra';
}

export type DayAssignmentStatus = 'suggested' | 'confirmed';
export type DayAssignmentSource = 'title' | 'ai' | 'user';

/** 영상의 Day 번호 제안·확정 — 영상 레코드는 바꾸지 않고 여기에만 기록 (영상당 1개) */
export interface DayAssignment extends BaseRecord {
  videoId: string;
  dayNumber: number;
  status: DayAssignmentStatus;
  source: DayAssignmentSource;
}

export type StudySessionStatus = 'in_progress' | 'completed' | 'abandoned';

/** 5단계 학습 세션 (B1은 테이블만, 횟수 계산은 C단계) */
export interface StudySession extends BaseRecord {
  dialogueId: string;
  /** 학습한 날짜 (YYYY-MM-DD, 기기 시간대) */
  date: string;
  status: StudySessionStatus;
  learningItemIds: string[];
  startedAt: ISODateString;
  completedAt: ISODateString | null;
}

export type DialogueDraftStatus = 'pending_review' | 'approved' | 'rejected' | 'superseded';

/** 통합 대화문 초안 (승인 전) */
export interface DialogueDraft extends BaseRecord {
  status: DialogueDraftStatus;
  expressionIds: string[];
  /** 초안 내용 (B1-d에서 형식 확정) */
  content: unknown;
}

export type ExtractionJobStatus = 'queued' | 'running' | 'succeeded' | 'failed_retryable' | 'failed_permanent' | 'skipped';

/** 영상별 자동 추출 작업 상태 (영상당 1개) */
export interface ExtractionJob extends BaseRecord {
  videoId: string;
  status: ExtractionJobStatus;
  attempts: number;
  /** 다시 시도해도 되는 시각 */
  attemptAfter: ISODateString | null;
  lastError: { code: string; message: string } | null;
  /** 진행 중인 요청 식별자 */
  currentRequestId: string | null;
  /** 사용자가 다시 시도를 누름 → 다음 새 요청의 첫 전송에 retryFailed를 붙인다 */
  retryRequested?: boolean;
  /** 사용자가 결과를 버리고 다시 추출한 횟수 + 1 (2부터 요청에 붙여 새 작업으로) */
  variant?: number;
  /** 항상 빈 배열 — 구간 분할은 구현하지 않음 */
  segments: unknown[];
  /** 한 탭만 실행하기 위한 점유 표시 */
  leaseOwner: string | null;
  leaseUntil: ISODateString | null;
  model: string | null;
  apiStyle: 'interactions';
  promptVersion: string | null;
  videoDurationSec: number | null;
  draftId: string | null;
}

export type ExtractionDraftStatus = 'pending_review' | 'approved' | 'partially_approved' | 'rejected' | 'superseded';

/** Gemini 결과 초안 (검토·수정·승인 대기) — result는 한 번 저장하면 바꾸지 않는다 */
export interface ExtractionDraft extends BaseRecord {
  videoId: string;
  jobId: string;
  /** 이 초안을 만든 요청 식별자 (요청당 초안 1개) */
  requestId: string;
  status: ExtractionDraftStatus;
  result: unknown;
  /** Gemini가 돌려준 원본 JSON 텍스트 (검사 전 그대로 보존) */
  rawText?: string;
  model?: string | null;
  usage?: { inputTokens: number | null; outputTokens: number | null; videoTokens: number | null } | null;
  /** 검사에서 거부한 전사 구간 (영상 길이를 넘는 시각 등) */
  rejectedSegments?: unknown[];
  edited: unknown | null;
  validation: unknown[];
  approvedRefs: string[];
}

export type AiRequestStatus = 'reserved' | 'sent' | 'succeeded' | 'failed_definite' | 'failed_unknown';

/** AI 요청 장부 — id는 요청 식별자(UUID v4) */
export interface AiRequest extends BaseRecord {
  jobId: string;
  videoId: string;
  status: AiRequestStatus;
  bodyHash: string | null;
  /** Gemini interaction id (백그라운드 실행) */
  interactionId: string | null;
  estVideoSec: number | null;
  estTokens: number | null;
  inputTokens: number | null;
  sentAt: ISODateString | null;
  finishedAt: ISODateString | null;
  /** 사용량을 센 날짜 (태평양 시간 기준 YYYY-MM-DD) */
  pacificDate: string | null;
  httpStatus: number | null;
  errorCode: string | null;
  responseHash: string | null;
}
