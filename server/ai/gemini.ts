/**
 * Gemini Interactions API 클라이언트 (Worker·Durable Object·개발 서버 공용, 프레임워크 독립)
 *
 * - 공식 SDK를 쓰지 않는다: SDK는 생성 요청을 기본 4번 자동 재시도해 같은 요청이 여러 번 나갈 수 있다.
 *   여기서는 fetch를 정확히 한 번만 부르고, 실패해도 다시 보내지 않는다.
 * - 생성: POST /v1beta/interactions (background: true, store: true) → 몇 초 안에 interaction id
 * - 조회: GET /v1beta/interactions/{id} (새로 생성하지 않음)
 * - 키는 x-goog-api-key 헤더로만 보낸다. 응답·오류 메시지에 키를 넣지 않는다.
 * - YouTube 공개 영상 주소만 넘긴다(Google 공식 기능). 자막 직접 추출·영상 다운로드는 하지 않는다.
 */

import type { AiTaskRequest } from '../../src/types/aiApi.ts';
import { ASK_SCHEMA, buildAskPrompt, buildPhrasesPrompt, PHRASES_SCHEMA, buildContentPrompt, buildDayPackPrompt, buildDialoguePrompt, buildPackPrompt, buildTextCreateBody, CONTENT_SCHEMA, DAYPACK_SCHEMA, DIALOGUE_SCHEMA, PACK_SCHEMA } from './tasks.ts';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
/** 생성·조회 요청 하나의 시간 제한 (백그라운드라 생성은 보통 몇 초) */
export const GEMINI_REQUEST_TIMEOUT_MS = 60_000;

export interface GeminiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  videoTokens: number | null;
}

export type GeminiCreateResult =
  | { kind: 'created'; interactionId: string; status: string }
  /** Gemini가 처리하지 않은 것이 확실한 거절 (4xx) */
  | { kind: 'rejected'; httpStatus: number; reason: 'quota' | 'not_configured' | 'invalid'; message: string }
  /** 결과를 알 수 없음 (네트워크·시간 초과·5xx) — 사용한 것으로 본다 */
  | { kind: 'unknown'; httpStatus: number | null; message: string };

export type GeminiGetResult =
  | { kind: 'running'; status: string }
  | { kind: 'completed'; text: string; model: string | null; usage: GeminiUsage | null }
  | { kind: 'failed'; status: string; message: string }
  /** 보관 기간이 지나 없음 (404) */
  | { kind: 'gone' }
  /** 이번 조회만 실패 (네트워크·5xx·429) — 나중에 다시 조회 */
  | { kind: 'retry_later'; httpStatus: number | null };

export interface GeminiClient {
  create(input: AiTaskRequest): Promise<GeminiCreateResult>;
  get(interactionId: string): Promise<GeminiGetResult>;
}

const RUNNING = new Set(['queued', 'in_progress']);

/** 응답 JSON 스키마 — minItems·maxItems 외의 길이 제한은 강제되지 않으므로 앱이 따로 검사한다 */
export const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    language: { type: 'string', enum: ['ko', 'en', 'mixed'] },
    dayNumber: { type: 'integer' },
    transcript: {
      type: 'array',
      items: {
        type: 'object',
        properties: { start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' } },
        required: ['start', 'end', 'text'],
      },
    },
    keyExpressions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          meaningKo: { type: 'string' },
          sourceSentence: { type: 'string' },
          timestampSec: { type: 'number' },
          onScreen: { type: 'boolean' },
          confidence: { type: 'number' },
        },
        required: ['text', 'meaningKo', 'sourceSentence', 'timestampSec', 'onScreen', 'confidence'],
      },
    },
    introChunks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, meaningKo: { type: 'string' }, timestampSec: { type: 'number' } },
        required: ['text', 'meaningKo', 'timestampSec'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['language', 'dayNumber', 'transcript', 'keyExpressions', 'introChunks', 'notes'],
} as const;

export function buildPrompt(durationSec: number): string {
  const mm = Math.floor(durationSec / 60);
  const ss = String(Math.round(durationSec % 60)).padStart(2, '0');
  return `이 영상은 한국어 설명으로 영어 표현을 가르치는 영어 학습 영상이며, 길이는 정확히 ${durationSec}초(${mm}분 ${ss}초)입니다.
다음을 JSON으로만 답하세요. 설명은 한국어로 씁니다.
1. transcript: 영상에서 들리는 말을 처음부터 끝까지 빠짐없이 그대로 받아 적습니다. 예문을 따라 말하는 연습·반복 구간도 들리는 대로 적습니다. 한국어는 한국어로, 영어는 영어로 적고 번역하지 않습니다. 한 구간은 한두 문장이며, start·end는 영상 시작부터의 초입니다. 모든 시각은 0 이상 ${durationSec} 이하여야 합니다.
2. keyExpressions: 이 영상이 가르치는 핵심 영어 표현만 적습니다(개수를 채우려고 만들지 마세요). text는 영상에서 쓴 형태, meaningKo는 뜻, sourceSentence는 transcript에 있는 문장을 그대로 복사, timestampSec는 그 표현이 처음 설명되는 시각, onScreen은 말로는 안 나오고 화면 글자로만 나오면 true, confidence는 0~1.
3. introChunks: 핵심 표현 설명 전에 영상이 소개한 짧은 영어 덩어리·단어(없으면 빈 배열).
4. dayNumber: 제목이나 화면의 Day 번호(없으면 0). language: ko, en, mixed 중 하나.
5. notes: 잘 안 들렸거나 확신하지 못한 부분. 없으면 빈 문자열.
확신이 없으면 지어내지 말고 confidence와 notes로 표시하세요.`;
}

export function buildCreateBody(model: string, videoId: string, durationSec: number) {
  return {
    model,
    background: true,
    store: true,
    input: [
      { type: 'video', uri: `https://www.youtube.com/watch?v=${videoId}` },
      { type: 'text', text: buildPrompt(durationSec) },
    ],
    response_format: { type: 'text', mime_type: 'application/json', schema: EXTRACTION_SCHEMA },
  };
}

/** 작업 종류별 생성 요청 본문 — 자막 추출만 영상 주소를 보내고, 나머지는 텍스트만 보낸다 */
export function createBodyFor(model: string, input: AiTaskRequest) {
  if (input.task === 'content') return buildTextCreateBody(model, buildContentPrompt(input), CONTENT_SCHEMA);
  if (input.task === 'dialogue') return buildTextCreateBody(model, buildDialoguePrompt(input), DIALOGUE_SCHEMA);
  if (input.task === 'pack') return buildTextCreateBody(model, buildPackPrompt(input), PACK_SCHEMA);
  if (input.task === 'daypack') return buildTextCreateBody(model, buildDayPackPrompt(input), DAYPACK_SCHEMA);
  if (input.task === 'ask') return buildTextCreateBody(model, buildAskPrompt(input), ASK_SCHEMA);
  if (input.task === 'phrases') return buildTextCreateBody(model, buildPhrasesPrompt(input), PHRASES_SCHEMA);
  return buildCreateBody(model, input.videoId, input.durationSec);
}

type Json = Record<string, unknown>;

/** completed 응답에서 model_output 단계의 text 조각을 순서대로 이어 붙인다 (SDK output_text와 같은 규칙) */
export function extractOutputText(interaction: Json): string {
  const steps = Array.isArray(interaction.steps) ? (interaction.steps as Json[]) : [];
  let text = '';
  for (const s of steps) {
    if (s?.type !== 'model_output' || !Array.isArray(s.content)) continue;
    for (const c of s.content as Json[]) if (c?.type === 'text' && typeof c.text === 'string') text += c.text;
  }
  return text;
}

export function extractUsage(interaction: Json): GeminiUsage | null {
  const u = interaction.usage as Json | undefined;
  if (!u || typeof u !== 'object') return null;
  const byModality = Array.isArray(u.input_tokens_by_modality) ? (u.input_tokens_by_modality as Json[]) : [];
  const video = byModality.find((m) => m?.modality === 'video');
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  return { inputTokens: num(u.total_input_tokens), outputTokens: num(u.total_output_tokens), videoTokens: num(video?.tokens) };
}

function errorMessage(json: Json | null): string {
  const e = json?.error as Json | undefined;
  if (typeof e?.message === 'string' && e.message) return e.message.slice(0, 300);
  return [e?.status, errorReason(json)].filter((x) => typeof x === 'string' && x).join(' ').slice(0, 300);
}

/** Google 오류 상세의 reason (예: API_KEY_INVALID) */
function errorReason(json: Json | null): string {
  const details = (json?.error as Json | undefined)?.details;
  if (!Array.isArray(details)) return '';
  for (const d of details as Json[]) if (typeof d?.reason === 'string') return d.reason;
  return '';
}

export function createGeminiClient(opts: { apiKey: string | null; model?: string; fetch: typeof fetch; timeoutMs?: number }): GeminiClient {
  const model = opts.model?.trim() || DEFAULT_GEMINI_MODEL;
  const timeoutMs = opts.timeoutMs ?? GEMINI_REQUEST_TIMEOUT_MS;
  const headers = () => ({ 'x-goog-api-key': opts.apiKey ?? '', 'Content-Type': 'application/json', Accept: 'application/json' });

  return {
    async create(input) {
      if (!opts.apiKey) return { kind: 'rejected', httpStatus: 0, reason: 'not_configured', message: '서버에 Gemini 키가 설정되지 않았어요.' };
      let res: Response;
      try {
        // 정확히 한 번만 보낸다 (재시도 없음)
        res = await opts.fetch(`${GEMINI_BASE}/interactions`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(createBodyFor(model, input)),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { kind: 'unknown', httpStatus: null, message: 'Gemini에 요청을 보낸 뒤 응답을 받지 못했어요.' };
      }
      const json = (await res.json().catch(() => null)) as Json | null;
      if (res.ok && json && typeof json.id === 'string') return { kind: 'created', interactionId: json.id, status: String(json.status ?? '') };
      if (res.status === 429) return { kind: 'rejected', httpStatus: 429, reason: 'quota', message: 'Gemini 무료 사용 한도에 도달했어요.' };
      if (res.status === 401 || res.status === 403) return { kind: 'rejected', httpStatus: res.status, reason: 'not_configured', message: 'Gemini 키가 거부됐어요.' };
      // Google은 잘못된 키를 400(API_KEY_INVALID)으로 돌려준다 — 요청 문제가 아니라 키 설정 문제로 보여 준다
      if (res.status === 400 && /API_KEY/.test(errorReason(json))) return { kind: 'rejected', httpStatus: 400, reason: 'not_configured', message: `Gemini 키가 올바르지 않아요 (${errorReason(json)}).` };
      if (res.status >= 400 && res.status < 500) return { kind: 'rejected', httpStatus: res.status, reason: 'invalid', message: errorMessage(json) || 'Gemini가 요청을 거부했어요.' };
      return { kind: 'unknown', httpStatus: res.status, message: `Gemini 서버 오류(${res.status})` };
    },

    async get(interactionId) {
      let res: Response;
      try {
        res = await opts.fetch(`${GEMINI_BASE}/interactions/${encodeURIComponent(interactionId)}`, { method: 'GET', headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        return { kind: 'retry_later', httpStatus: null };
      }
      if (res.status === 404) return { kind: 'gone' };
      const json = (await res.json().catch(() => null)) as Json | null;
      if (!res.ok || !json) return { kind: 'retry_later', httpStatus: res.status };
      const status = String(json.status ?? '');
      if (RUNNING.has(status)) return { kind: 'running', status };
      if (status === 'completed') {
        return { kind: 'completed', text: extractOutputText(json), model: typeof json.model === 'string' ? json.model : null, usage: extractUsage(json) };
      }
      const errs = Array.isArray(json.errors) ? (json.errors as Json[]) : [];
      const msg = typeof errs[0]?.message === 'string' ? String(errs[0].message).slice(0, 300) : '';
      return { kind: 'failed', status, message: msg || `Gemini 작업이 '${status}' 상태로 끝났어요.` };
    },
  };
}
