import {
  CONTENT_LIMITS,
  DIALOGUE_LIMITS,
  type AiContentRequest,
  type AiDialogueRequest,
  type AiExtractRequest,
  type AiTaskRequest,
} from '../../src/types/aiApi.ts';
import { isValidVideoId } from '../../src/utils/youtubeUrl.ts';

/**
 * AI 작업 종류별 요청 검사·프롬프트·응답 형식 (서버 공용)
 *
 * - extract : 영상 주소 → 자막 (기존)
 * - content : 저장된 자막 텍스트 → 원문 문장 + 문장 속 Chunk (영상은 다시 보내지 않음)
 * - dialogue: 사용자가 고른 여러 Day의 Chunk → 통합 실전 대화문
 *
 * 프롬프트는 서버만 가진다(앱은 재료만 보낸다). 키·비밀정보는 여기 없다.
 */

export type TaskKind = 'extract' | 'content' | 'dialogue';
export const taskOf = (r: AiTaskRequest): TaskKind => (r.task === 'content' ? 'content' : r.task === 'dialogue' ? 'dialogue' : 'extract');

const str = (v: unknown, max: number, min = 1): v is string => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const REF = /^[A-Za-z0-9_:.-]{1,160}$/;

export function validateTaskRequest(raw: unknown): AiTaskRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.promptVersion !== 'string' || r.promptVersion.length > 20) return null;
  if (r.task === undefined || r.task === 'extract') {
    if (typeof r.videoId !== 'string' || !isValidVideoId(r.videoId)) return null;
    if (typeof r.durationSec !== 'number' || !Number.isInteger(r.durationSec) || r.durationSec < 1 || r.durationSec > 24 * 3600) return null;
    return { videoId: r.videoId, durationSec: r.durationSec, promptVersion: r.promptVersion } satisfies AiExtractRequest;
  }
  if (r.task === 'content') {
    if (typeof r.videoId !== 'string' || !isValidVideoId(r.videoId)) return null;
    if (!str(r.title, CONTENT_LIMITS.titleChars, 0)) return null;
    if (r.seriesKind !== 'day' && r.seriesKind !== 'general') return null;
    if (r.dayNumber !== null && !(typeof r.dayNumber === 'number' && Number.isInteger(r.dayNumber) && r.dayNumber > 0 && r.dayNumber < 10_000)) return null;
    if (!str(r.transcript, CONTENT_LIMITS.transcriptChars, 20)) return null;
    return { task: 'content', videoId: r.videoId, title: r.title, seriesKind: r.seriesKind, dayNumber: r.dayNumber as number | null, transcript: r.transcript, promptVersion: r.promptVersion } satisfies AiContentRequest;
  }
  if (r.task === 'dialogue') {
    const L = DIALOGUE_LIMITS;
    if (!Array.isArray(r.chunks) || r.chunks.length < L.minChunks || r.chunks.length > L.maxChunks) return null;
    const chunks = [];
    const refs = new Set<string>();
    for (const c of r.chunks as Record<string, unknown>[]) {
      if (!c || typeof c !== 'object') return null;
      if (typeof c.ref !== 'string' || !REF.test(c.ref) || refs.has(c.ref)) return null;
      if (!str(c.text, L.textChars) || !str(c.meaningKo, L.meaningChars, 0) || !str(c.source, L.sourceChars, 0)) return null;
      if (c.day !== null && !(typeof c.day === 'number' && Number.isInteger(c.day) && c.day > 0 && c.day < 10_000)) return null;
      refs.add(c.ref);
      chunks.push({ ref: c.ref, text: c.text, meaningKo: c.meaningKo, day: c.day as number | null, source: c.source });
    }
    if (typeof r.lineCount !== 'number' || !Number.isInteger(r.lineCount) || r.lineCount < L.minLines || r.lineCount > L.maxLines) return null;
    return { task: 'dialogue', chunks, lineCount: r.lineCount, promptVersion: r.promptVersion } satisfies AiDialogueRequest;
  }
  return null;
}

/** 같은 식별자에 같은 내용이 왔는지 비교할 문자열 (기존 자막 추출은 예전 형식 그대로 유지) */
export function bodyHashSource(r: AiTaskRequest): string {
  if (r.task === 'content' || r.task === 'dialogue') return JSON.stringify(r);
  return `${r.videoId}|${r.durationSec}|${r.promptVersion}`;
}

// ─────────────────────────────────────────────
// content — 원문 문장 + Chunk
// ─────────────────────────────────────────────

const CHUNK_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    meaningKo: { type: 'string' },
    meaningInSentence: { type: 'string' },
    nuance: { type: 'string' },
    usage: { type: 'string' },
    comparison: { type: 'string' },
    examples: {
      type: 'array',
      items: { type: 'object', properties: { en: { type: 'string' }, ko: { type: 'string' } }, required: ['en', 'ko'] },
    },
  },
  required: ['text', 'meaningKo', 'meaningInSentence', 'nuance', 'usage', 'comparison', 'examples'],
} as const;

export const CONTENT_SCHEMA = {
  type: 'object',
  properties: {
    sentences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer' },
          text: { type: 'string' },
          meaningKo: { type: 'string' },
          timestampSec: { type: 'number' },
          chunks: { type: 'array', items: CHUNK_SCHEMA },
        },
        required: ['number', 'text', 'meaningKo', 'timestampSec', 'chunks'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['sentences', 'notes'],
} as const;

const CHUNK_RULES = `각 문장의 chunks: 그 문장 안에서 통째로 익혀 두면 다른 상황에도 응용할 수 있는 표현 단위(구동사, 연어, 관용 표현, 자연스러운 연결 표현, 자주 쓰는 덩어리)를 1~4개 고릅니다.
- text는 그 문장에 실제로 있는 형태 그대로 적습니다(문장에 없는 말을 만들지 않음). 너무 평범한 단어 하나, 고유명사, 학습 가치가 낮은 부분은 제외합니다.
- 문장 전체를 그대로 chunk로 쓰지 않습니다. 문장과 chunk는 따로 학습하는 별개 항목입니다.
- meaningKo: 한국어 뜻 / meaningInSentence: 이 문장에서의 뜻 / nuance: 원어민이 쓸 때의 뉘앙스·말투(격식, 부드러움 등) / usage: 어떤 상황에서 쓰는지 / comparison: 비슷한 표현과의 차이(예: "need와 비교하면 …") / examples: 짧은 응용 예문 2개(en, ko).`;

export function buildContentPrompt(r: AiContentRequest): string {
  const head =
    r.seriesKind === 'day'
      ? `아래는 영어 학습 시리즈 영상${r.dayNumber ? ` "Day ${r.dayNumber}"` : ''}(제목: ${r.title})의 전체 자막입니다. 이 시리즈는 영상마다 번호를 붙인 오늘의 영어 문장들을 가르칩니다.

1. sentences: 영상에서 번호를 붙여 제시한 영어 문장을 영상에 나온 번호와 순서 그대로, 원문 그대로 적습니다(고치거나 바꾸지 않음).
- 개수는 영상에 실제로 나온 만큼만 적습니다(4개든 6개든). 개수를 채우려고 만들지 않습니다.
- number는 영상에 나온 번호입니다. 번호가 명확하지 않으면 영상에서 가르친 순서대로 1부터 매기고 notes에 적습니다.
- 인사, 구독 안내, 한국어 설명 문장은 넣지 않습니다.`
      : `아래는 일반 영어 영상(제목: ${r.title})의 전체 자막입니다. Day 시리즈가 아니므로 번호가 붙은 문장이라고 무조건 고르지 않습니다. 전체 맥락을 보고 고릅니다.

1. sentences: 원어민이 일상회화에서 자주 쓰는, 통째로 익혀 다른 상황에 응용할 수 있는 자연스러운 표현이 들어 있는 문장을 자막에서 원문 그대로 3~10개 고릅니다.
- 문맥에 따라 의미나 뉘앙스가 달라지는 표현, 구동사, 관용 표현, 자연스러운 연결 표현이 들어 있는 문장을 우선합니다.
- 단순한 문장 발췌, 너무 평범한 문장, 고유명사 위주 문장, 학습 가치가 낮은 문장은 제외합니다.
- number는 영상에 나온 순서대로 1부터 매깁니다.`;
  return `${head}
- text는 자막에 있는 영어 문장을 그대로 복사합니다. 자막에 없는 문장을 지어내지 않습니다.
- meaningKo는 자연스러운 한국어 뜻, timestampSec는 그 문장이 자막에 처음 나오는 시각(초, 모르면 -1)입니다.

2. ${CHUNK_RULES}

3. notes: 확신하지 못한 부분(번호가 불분명함, 자막이 잘못 들린 것 같음 등). 없으면 빈 문자열.
설명은 모두 한국어로 씁니다. JSON으로만 답하세요.

[자막]
${r.transcript}`;
}

// ─────────────────────────────────────────────
// dialogue — 여러 Day의 Chunk로 통합 대화문
// ─────────────────────────────────────────────

export const DIALOGUE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    situation: { type: 'string' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          speaker: { type: 'string', enum: ['A', 'B'] },
          en: { type: 'string' },
          ko: { type: 'string' },
          chunkRefs: { type: 'array', items: { type: 'string' } },
        },
        required: ['speaker', 'en', 'ko', 'chunkRefs'],
      },
    },
    chunkNotes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          usedAs: { type: 'string' },
          meaningInContext: { type: 'string' },
          nuance: { type: 'string' },
          whyUsed: { type: 'string' },
          example: { type: 'object', properties: { en: { type: 'string' }, ko: { type: 'string' } }, required: ['en', 'ko'] },
        },
        required: ['ref', 'usedAs', 'meaningInContext', 'nuance', 'whyUsed', 'example'],
      },
    },
    unusedRefs: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['title', 'situation', 'lines', 'chunkNotes', 'unusedRefs', 'notes'],
} as const;

export function buildDialoguePrompt(r: AiDialogueRequest): string {
  const list = r.chunks.map((c) => `- ref=${c.ref} | ${c.text} | 뜻: ${c.meaningKo || '-'} | 출처: ${c.source}`).join('\n');
  return `아래는 사용자가 이미 학습한(또는 직접 고른) 영어 Chunk 목록입니다. 여러 Day에서 배운 표현이 섞여 있습니다.
이 Chunk들을 활용해 원어민이 실제로 주고받을 법한 자연스러운 일상 대화문 1개를 만드세요.

원칙
- 대화의 흐름과 상황이 우선입니다. 서로 다른 Day의 표현이 한 상황 안에서 자연스럽게 이어지게 하고, 표현을 나열하거나 억지로 끼워 넣지 않습니다.
- 자연스럽게 넣기 어려운 Chunk는 쓰지 말고 unusedRefs에 적습니다. 가능하면 서로 다른 출처의 Chunk를 고루 씁니다.
- 같은 Chunk를 반복해서 넣지 않습니다(각 Chunk는 한 번, 꼭 필요할 때만 두 번).
- 목록에 없는 표현을 배운 표현으로 표시하지 않습니다. chunkRefs에는 그 줄에 실제로 쓴 목록의 ref만 적습니다.
- Chunk는 목록의 형태 그대로 쓰되, 문법상 필요한 시제·인칭·수 변화만 허용합니다.
- 화자 A와 B가 번갈아 말하며 ${r.lineCount}줄 안팎으로 만듭니다. 문법적으로 정확하고 자연스러운 구어체로 씁니다.

출력
- title: 짧은 한국어 제목
- situation: 대화 상황과 맥락(한국어 2~3문장, 누가 어디서 무슨 이야기를 하는지)
- lines: speaker(A/B), en(영어 대사), ko(자연스러운 한국어 번역), chunkRefs
- chunkNotes: 실제로 쓴 Chunk마다 하나. usedAs(대화 속 실제 형태, en 문장에 그대로 있는 부분), meaningInContext(이 상황에서의 의미), nuance(뉘앙스), whyUsed(대화 속에서 이 표현을 쓴 이유), example(다른 상황에 응용한 짧은 예문 en·ko)
- unusedRefs: 쓰지 않은 ref
- notes: 참고할 점(없으면 빈 문자열)
설명은 모두 한국어로 씁니다. JSON으로만 답하세요.

[Chunk 목록]
${list}`;
}

export function buildTextCreateBody(model: string, prompt: string, schema: unknown) {
  return {
    model,
    background: true,
    store: true,
    input: [{ type: 'text', text: prompt }],
    response_format: { type: 'text', mime_type: 'application/json', schema },
  };
}
