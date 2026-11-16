/**
 * 앱 ↔ 우리 서버(/api/ai/extract) 사이의 요청·응답 형식 (서버와 앱이 함께 쓴다)
 *
 * - 요청은 POST, 헤더 Idempotency-Key = 요청 식별자(UUID v4). 같은 식별자로 다시 보내면 Gemini를
 *   다시 부르지 않고 그 요청의 현재 상태나 결과를 돌려준다(결과 조회도 같은 요청을 다시 보내는 방식).
 * - Gemini 생성 요청은 식별자당 최대 1회. 앱은 영상마다 식별자를 하나만 쓰고, Gemini가 처리하지 않은 것이
 *   확실한 경우(consumed=false)에만 새 식별자를 만든다.
 */

export const AI_EXTRACT_PATH = '/api/ai/extract';
export const AI_PROMPT_VERSION = 'v1';

export interface AiExtractRequest {
  /** 생략 = 영상에서 자막 추출 */
  task?: 'extract';
  /** 사용자가 결과를 버리고 다시 추출할 때 2, 3… — 다른 작업으로 취급해 새로 생성 (없으면 1) */
  variant?: number;
  /** YouTube 영상 ID (11자) */
  videoId: string;
  /** 영상 길이(초) — 사용량 계산과 타임스탬프 검사 기준 */
  durationSec: number;
  promptVersion: string;
}

/** 학습 콘텐츠(문장·Chunk) 생성 — 저장된 자막 텍스트만 보낸다 (영상은 다시 보내지 않음) */
export const AI_CONTENT_PROMPT_VERSION = 'c1';
/** 통합 대화문 생성 */
export const AI_DIALOGUE_PROMPT_VERSION = 'd1';

export type SeriesKind = 'day' | 'general';

export interface AiContentRequest {
  task: 'content';
  /** 어느 영상의 콘텐츠인지 (장부 기록용, YouTube 영상 ID) */
  videoId: string;
  title: string;
  seriesKind: SeriesKind;
  dayNumber: number | null;
  /** "MM:SS 문장" 줄들 */
  transcript: string;
  promptVersion: string;
}

export interface AiDialogueChunk {
  /** 앱의 학습 항목 id (응답에서 이 값으로 어떤 Chunk를 썼는지 알려 준다) */
  ref: string;
  text: string;
  meaningKo: string;
  /** Day 번호 (일반 영상이면 null) */
  day: number | null;
  /** 출처 설명 (예: "Day 11", 일반 영상 제목) */
  source: string;
}

export interface AiDialogueRequest {
  task: 'dialogue';
  chunks: AiDialogueChunk[];
  /** 대화 줄 수 목표 */
  lineCount: number;
  promptVersion: string;
}

/** 학습 자료 전체 (자막 → 원문 문장·문장별 Chunk·공통 핵심 Chunk·Day 통합 대화문) */
export const AI_PACK_PROMPT_VERSION = 'p1';
/** 이미 저장된 원문 문장 → 공통 핵심 Chunk·Day 통합 대화문 */
export const AI_DAYPACK_PROMPT_VERSION = 'dp1';

export interface AiPackRequest {
  task: 'pack';
  videoId: string;
  title: string;
  seriesKind: SeriesKind;
  dayNumber: number | null;
  /** "MM:SS 문장" 줄들 */
  transcript: string;
  promptVersion: string;
}

export interface AiDayPackSentence {
  number: number;
  text: string;
  meaningKo: string;
  /** 이 문장에서 이미 찾은 Chunk (참고용) */
  chunks: string[];
}

export interface AiDayPackRequest {
  task: 'daypack';
  videoId: string;
  title: string;
  seriesKind: SeriesKind;
  dayNumber: number | null;
  sentences: AiDayPackSentence[];
  promptVersion: string;
}

export type AiTaskRequest = AiExtractRequest | AiContentRequest | AiDialogueRequest | AiPackRequest | AiDayPackRequest;

export const DAYPACK_LIMITS = { minSentences: 1, maxSentences: 20, sentenceChars: 500, chunkChars: 120, maxChunksPerSentence: 8 } as const;

export const CONTENT_LIMITS = { transcriptChars: 60_000, titleChars: 300 } as const;
export const DIALOGUE_LIMITS = { minChunks: 2, maxChunks: 15, textChars: 120, meaningChars: 200, sourceChars: 200, minLines: 4, maxLines: 20 } as const;

export type AiFailureCode =
  /** 우리 서버의 하루 상한 (Gemini 호출 안 함) */
  | 'daily_cap'
  /** 한 번에 처리할 수 있는 길이를 넘음 (Gemini 호출 안 함) */
  | 'too_long'
  /** Gemini 무료 한도 초과 (429, 처리 안 됨) */
  | 'gemini_quota'
  /** Gemini가 요청을 거부 (4xx, 처리 안 됨 — 비공개 영상·잘못된 요청 등) */
  | 'gemini_rejected'
  /** 서버에 Gemini 키가 없거나 키가 거부됨 */
  | 'gemini_not_configured'
  /** Gemini가 처리했지만 실패 상태로 끝남 */
  | 'gemini_failed'
  /** 보냈지만 결과를 알 수 없음 (사용한 것으로 셈) */
  | 'unknown'
  /** 결과 보관 기간(무료 1일)이 지나 조회할 수 없음 */
  | 'expired'
  /** 같은 식별자에 다른 요청 내용 */
  | 'key_conflict'
  | 'bad_request'
  | 'ledger_unavailable';

export type AiExtractResponse =
  | { ok: true; state: 'pending'; requestId: string; interactionId: string | null; retryAfterSec: number }
  | {
      ok: true;
      state: 'succeeded';
      requestId: string;
      interactionId: string;
      model: string | null;
      /** Gemini가 돌려준 JSON 텍스트 (앱이 파싱·검사) */
      resultText: string;
      usage: { inputTokens: number | null; outputTokens: number | null; videoTokens: number | null } | null;
    }
  | {
      ok: false;
      state: 'failed';
      requestId: string | null;
      code: AiFailureCode;
      message: string;
      /** false = Gemini가 처리하지 않은 것이 확실함 (같은 영상을 새 식별자로 다시 해도 됨) */
      consumed: boolean;
      /** 다시 시도해도 되는 시각 (하루 상한 등) */
      retryAt?: string;
    };
