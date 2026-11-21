import {
  CONTENT_LIMITS,
  DAYPACK_LIMITS,
  DIALOGUE_LIMITS,
  type AiContentRequest,
  type AiDayPackRequest,
  type AiDialogueRequest,
  type AiExtractRequest,
  type AiPackRequest,
  type AiTaskRequest,
  PHRASES_LIMITS,
  type AiPhrasesRequest,
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

export type TaskKind = 'extract' | 'content' | 'dialogue' | 'pack' | 'daypack' | 'phrases';
export const taskOf = (r: AiTaskRequest): TaskKind => r.task ?? 'extract';

const str = (v: unknown, max: number, min = 1): v is string => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const REF = /^[A-Za-z0-9_:.-]{1,160}$/;

export function validateTaskRequest(raw: unknown): AiTaskRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.promptVersion !== 'string' || r.promptVersion.length > 20) return null;
  if (r.task === undefined || r.task === 'extract') {
    if (typeof r.videoId !== 'string' || !isValidVideoId(r.videoId)) return null;
    if (typeof r.durationSec !== 'number' || !Number.isInteger(r.durationSec) || r.durationSec < 1 || r.durationSec > 24 * 3600) return null;
    if (r.variant !== undefined && !(typeof r.variant === 'number' && Number.isInteger(r.variant) && r.variant >= 2 && r.variant <= 99)) return null;
    return { videoId: r.videoId, durationSec: r.durationSec, promptVersion: r.promptVersion, ...(r.variant ? { variant: r.variant as number } : {}) } satisfies AiExtractRequest;
  }
  if (r.task === 'content') {
    if (typeof r.videoId !== 'string' || !isValidVideoId(r.videoId)) return null;
    if (!str(r.title, CONTENT_LIMITS.titleChars, 0)) return null;
    if (r.seriesKind !== 'day' && r.seriesKind !== 'general') return null;
    if (r.dayNumber !== null && !(typeof r.dayNumber === 'number' && Number.isInteger(r.dayNumber) && r.dayNumber > 0 && r.dayNumber < 10_000)) return null;
    if (!str(r.transcript, CONTENT_LIMITS.transcriptChars, 20)) return null;
    return { task: 'content', videoId: r.videoId, title: r.title, seriesKind: r.seriesKind, dayNumber: r.dayNumber as number | null, transcript: r.transcript, promptVersion: r.promptVersion } satisfies AiContentRequest;
  }
  if (r.task === 'pack') {
    if (typeof r.videoId !== 'string' || !isValidVideoId(r.videoId)) return null;
    if (!str(r.title, CONTENT_LIMITS.titleChars, 0)) return null;
    if (r.seriesKind !== 'day' && r.seriesKind !== 'general') return null;
    if (r.dayNumber !== null && !(typeof r.dayNumber === 'number' && Number.isInteger(r.dayNumber) && r.dayNumber > 0 && r.dayNumber < 10_000)) return null;
    if (!str(r.transcript, CONTENT_LIMITS.transcriptChars, 20)) return null;
    return { task: 'pack', videoId: r.videoId, title: r.title, seriesKind: r.seriesKind, dayNumber: r.dayNumber as number | null, transcript: r.transcript, promptVersion: r.promptVersion } satisfies AiPackRequest;
  }
  if (r.task === 'phrases') {
    const L = PHRASES_LIMITS;
    if (typeof r.dialogueId !== 'string' || !REF.test(r.dialogueId)) return null;
    if (!Array.isArray(r.lines) || r.lines.length < L.minLines || r.lines.length > L.maxLines) return null;
    const lines = r.lines as Record<string, unknown>[];
    if (!lines.every((x) => x && (x.speaker === 'A' || x.speaker === 'B') && str(x.en, L.lineChars))) return null;
    if (!Array.isArray(r.exclude) || r.exclude.length > L.maxExclude || !r.exclude.every((x) => str(x, L.excludeChars))) return null;
    return { task: 'phrases', dialogueId: r.dialogueId, lines: lines.map((x) => ({ speaker: x.speaker as 'A' | 'B', en: x.en as string })), exclude: r.exclude as string[], promptVersion: r.promptVersion as string } satisfies AiPhrasesRequest;
  }
  if (r.task === 'daypack') {
    const L = DAYPACK_LIMITS;
    if (typeof r.videoId !== 'string' || !isValidVideoId(r.videoId)) return null;
    if (!str(r.title, CONTENT_LIMITS.titleChars, 0)) return null;
    if (r.seriesKind !== 'day' && r.seriesKind !== 'general') return null;
    if (r.dayNumber !== null && !(typeof r.dayNumber === 'number' && Number.isInteger(r.dayNumber) && r.dayNumber > 0 && r.dayNumber < 10_000)) return null;
    if (!Array.isArray(r.sentences) || r.sentences.length < L.minSentences || r.sentences.length > L.maxSentences) return null;
    const sentences = [];
    for (const x of r.sentences as Record<string, unknown>[]) {
      if (!x || typeof x !== 'object') return null;
      if (typeof x.number !== 'number' || !Number.isInteger(x.number) || x.number < 1 || x.number > 999) return null;
      if (!str(x.text, L.sentenceChars) || !str(x.meaningKo, L.sentenceChars, 0)) return null;
      if (!Array.isArray(x.chunks) || x.chunks.length > L.maxChunksPerSentence || !x.chunks.every((c) => str(c, L.chunkChars))) return null;
      sentences.push({ number: x.number, text: x.text, meaningKo: x.meaningKo, chunks: x.chunks as string[] });
    }
    if (r.transcript !== undefined && !str(r.transcript, CONTENT_LIMITS.transcriptChars, 0)) return null;
    if (r.taughtHints !== undefined && !(Array.isArray(r.taughtHints) && r.taughtHints.length <= 10 && r.taughtHints.every((h) => str(h, L.chunkChars)))) return null;
    if (r.variant !== undefined && !(typeof r.variant === 'number' && Number.isInteger(r.variant) && r.variant >= 2 && r.variant <= 99)) return null;
    return {
      task: 'daypack', videoId: r.videoId, title: r.title, seriesKind: r.seriesKind, dayNumber: r.dayNumber as number | null, sentences,
      ...(typeof r.transcript === 'string' && r.transcript.trim() ? { transcript: r.transcript } : {}),
      ...(Array.isArray(r.taughtHints) && r.taughtHints.length ? { taughtHints: r.taughtHints as string[] } : {}),
      promptVersion: r.promptVersion,
      // variant가 없는 예전 요청은 작업 키(본문 해시)가 그대로
      ...(typeof r.variant === 'number' ? { variant: r.variant } : {}),
    } satisfies AiDayPackRequest;
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
  if (r.task) return JSON.stringify(r);
  return `${r.videoId}|${r.durationSec}|${r.promptVersion}${r.variant ? `|v${r.variant}` : ''}`;
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

/** ✨ 유용한 회화 표현 — 대화문 안에서 통째로 외워 다른 상황에도 쓸 수 있는 표현 (핵심 Chunk와 별도) */
export const USEFUL_RULES = `usefulPhrases(✨ 유용한 회화 표현): 대화문 안에서, 학습자가 통째로 외워 두면 실제 회화의 다른 상황에도 자연스럽게 쓸 수 있는 표현만 고릅니다.
- 대상: 구동사(take someone up on something, figure out, run into), 관용·회화 덩어리(that rings a bell, I'm all for it), 공감·반응 표현(I can imagine, I know what you mean), 자주 쓰는 문장 패턴(I'm so ready for ~).
- 제외: 핵심 Chunk와 그 활용형, 어려운 단어 하나, 문법 포인트, 너무 평범한 말. 강사가 가르친 것처럼 쓰지 않습니다.
- 학습 가치가 높은 순서로 최대 6개, 한 줄에 1개까지. 많이 표시하지 않습니다. 확신이 없으면 넣지 않습니다.
- base: 기본형 (구동사는 someone/something 자리를 넣은 형태, 예: take someone up on something)
- usedAs: 대화문에 실제로 쓰인 형태 그대로 (en에 그대로 있는 부분, 여러 번 나오면 모두)
- category: phrasal(구동사) / idiom(관용·회화 덩어리) / reaction(공감·반응) / pattern(문장 패턴) / chunk(그 밖의 덩어리)
- meaningKo(한국어 뜻), nuance(이 대화 문맥의 뉘앙스), usage(어떤 상황에서 쓰는지)
- pattern·slotNote·swapExamples: 단어를 바꿔 쓸 수 있을 때만 (자리 이름은 명사, 불가산명사, 형용사, 동사원형, 동사-ing, 사람, 장소 중 하나, 예: "I'm so ready for + 명사"), 활용 예시 0~3개(en, ko, note). 없으면 "", "", []`;

export const USEFUL_PHRASE_SCHEMA = {
  type: 'object',
  properties: {
    base: { type: 'string' },
    usedAs: { type: 'array', items: { type: 'string' } },
    category: { type: 'string', enum: ['phrasal', 'idiom', 'reaction', 'pattern', 'chunk'] },
    meaningKo: { type: 'string' },
    nuance: { type: 'string' },
    usage: { type: 'string' },
    pattern: { type: 'string' },
    slotNote: { type: 'string' },
    swapExamples: {
      type: 'array',
      items: { type: 'object', properties: { en: { type: 'string' }, ko: { type: 'string' }, note: { type: 'string' } }, required: ['en', 'ko', 'note'] },
    },
  },
  required: ['base', 'usedAs', 'category', 'meaningKo', 'nuance', 'usage', 'pattern', 'slotNote', 'swapExamples'],
} as const;

export const PHRASES_SCHEMA = {
  type: 'object',
  properties: { usefulPhrases: { type: 'array', items: USEFUL_PHRASE_SCHEMA } },
  required: ['usefulPhrases'],
} as const;

export function buildPhrasesPrompt(r: AiPhrasesRequest): string {
  const lines = r.lines.map((l, i) => `${i + 1}. ${l.speaker}: ${l.en}`).join('\n');
  const exclude = r.exclude.length ? r.exclude.map((x) => `- ${x}`).join('\n') : '- (없음)';
  return `당신은 한국인 학습자를 돕는 영어 회화 튜터입니다. 아래 대화문에서 ✨ 유용한 회화 표현을 골라 주세요. 한국어로 설명합니다.

[대화문]
${lines}

[제외할 핵심 Chunk — 강사가 가르친 표현, 이것과 그 활용형은 고르지 않음]
${exclude}

${USEFUL_RULES}`;
}

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
    usefulPhrases: { type: 'array', items: USEFUL_PHRASE_SCHEMA },
    notes: { type: 'string' },
  },
  required: ['title', 'situation', 'lines', 'chunkNotes', 'unusedRefs', 'usefulPhrases', 'notes'],
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

${USEFUL_RULES}
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

// ─────────────────────────────────────────────
// pack / daypack — 공통 핵심 Chunk + Day 통합 대화문
// ─────────────────────────────────────────────

const EXAMPLES = { type: 'array', items: { type: 'object', properties: { en: { type: 'string' }, ko: { type: 'string' } }, required: ['en', 'ko'] } } as const;

/** 문장별 Chunk — parts: 문장에서 순서대로 나오는 구성 단어 (사이에 낀 부사 등은 빼고) */
const PACK_CHUNK_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    parts: { type: 'array', items: { type: 'string' } },
    surface: { type: 'string' },
    pattern: { type: 'string' },
    slotNote: { type: 'string' },
    swapExamples: {
      type: 'array',
      items: { type: 'object', properties: { en: { type: 'string' }, ko: { type: 'string' }, note: { type: 'string' } }, required: ['en', 'ko', 'note'] },
    },
    meaningKo: { type: 'string' },
    meaningInSentence: { type: 'string' },
    nuance: { type: 'string' },
    usage: { type: 'string' },
    comparison: { type: 'string' },
    examples: EXAMPLES,
  },
  required: ['text', 'parts', 'surface', 'pattern', 'slotNote', 'swapExamples', 'meaningKo', 'meaningInSentence', 'nuance', 'usage', 'comparison', 'examples'],
} as const;

const CORE_CHUNK_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    parts: { type: 'array', items: { type: 'string' } },
    meaningKo: { type: 'string' },
    nuance: { type: 'string' },
    usage: { type: 'string' },
    comparison: { type: 'string' },
    examples: EXAMPLES,
    sentenceNumbers: { type: 'array', items: { type: 'integer' } },
    taughtEvidence: { type: 'string' },
  },
  required: ['text', 'parts', 'meaningKo', 'nuance', 'usage', 'comparison', 'examples', 'sentenceNumbers', 'taughtEvidence'],
} as const;

const DAY_DIALOGUE_SCHEMA = {
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
          sourceSentenceNumber: { type: 'integer' },
          chunkTexts: { type: 'array', items: { type: 'string' } },
        },
        required: ['speaker', 'en', 'ko', 'sourceSentenceNumber', 'chunkTexts'],
      },
    },
    chunkNotes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          kind: { type: 'string', enum: ['core', 'extra'] },
          usedAs: { type: 'array', items: { type: 'string' } },
          meaningInContext: { type: 'string' },
          nuance: { type: 'string' },
          whyUsed: { type: 'string' },
          example: { type: 'object', properties: { en: { type: 'string' }, ko: { type: 'string' } }, required: ['en', 'ko'] },
        },
        required: ['text', 'kind', 'usedAs', 'meaningInContext', 'nuance', 'whyUsed', 'example'],
      },
    },
    usefulPhrases: { type: 'array', items: USEFUL_PHRASE_SCHEMA },
  },
  required: ['title', 'situation', 'lines', 'chunkNotes', 'usefulPhrases'],
} as const;

export const PACK_SCHEMA = {
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
          chunks: { type: 'array', items: PACK_CHUNK_SCHEMA },
        },
        required: ['number', 'text', 'meaningKo', 'timestampSec', 'chunks'],
      },
    },
    coreChunks: { type: 'array', items: CORE_CHUNK_SCHEMA },
    dialogue: DAY_DIALOGUE_SCHEMA,
    notes: { type: 'string' },
  },
  required: ['sentences', 'coreChunks', 'dialogue', 'notes'],
} as const;

const EXTRA_CHUNK_SCHEMA = {
  type: 'object',
  properties: { sentenceNumber: { type: 'integer' }, ...PACK_CHUNK_SCHEMA.properties },
  required: ['sentenceNumber', ...PACK_CHUNK_SCHEMA.required],
} as const;

export const DAYPACK_SCHEMA = {
  type: 'object',
  properties: { coreChunks: { type: 'array', items: CORE_CHUNK_SCHEMA }, extraChunks: { type: 'array', items: EXTRA_CHUNK_SCHEMA }, dialogue: DAY_DIALOGUE_SCHEMA, notes: { type: 'string' } },
  required: ['coreChunks', 'extraChunks', 'dialogue', 'notes'],
} as const;

const PARTS_RULE = `- parts: 그 표현을 이루는 단어를 문장에 나오는 순서대로 적습니다. 사이에 부사 등이 끼어 있으면 낀 단어는 빼고 적습니다.
  예) "I could seriously use a cup of coffee." → text "could use", parts ["could", "use"]`;

const CORE_RULES = `핵심 Chunk(coreChunks): 강사가 영상에서 직접 소개하고 설명한(가르친) 표현만 고릅니다.
- 자막의 강의 부분(예: "오늘 배울 표현은 …", "…는 이런 뜻이에요", 한국어 설명)을 근거로 판단합니다. 강사가 가르친 것이 아니면 핵심 Chunk에 넣지 않습니다.
- 강사가 설명한 핵심 범위만 적습니다. 예) 강사가 could use를 가르쳤다면 핵심 Chunk는 "could use" 하나뿐입니다.
  could use some rest, could use some help, could seriously use 같은 활용형은 별도 항목으로 만들지 않습니다(같은 Chunk의 활용 사례로 연결됩니다).
- 보통 1~2개. 강의 설명을 찾을 수 없으면 원문 문장에 반복되는 표현 하나를 고르고 taughtEvidence는 빈 문자열로 둡니다.
- taughtEvidence: 강사가 그 표현을 설명한 부분을 자막에서 짧게 그대로 인용(없으면 빈 문자열)
- meaningKo·nuance는 강의에서 강사가 설명한 의미와 뉘앙스를 먼저 반영하고, 부족한 부분만 보충합니다.
- usage(쓰는 상황), comparison(비슷한 표현과의 차이, 강사가 비교했다면 그 내용), examples(짧은 응용 예문 2개)
- sentenceNumbers: 그 표현(사이에 부사가 낀 변형 포함)이 실제로 나오는 원문 문장 번호만. 모든 문장에 있다고 가정하지 않습니다.
- 중간에 부사가 끼어도(could seriously use, could really use) 같은 Chunk입니다. text는 기본형, parts는 구성 단어.`;

const EXTRA_RULES = `추가 덩어리 표현: 강사가 가르치지는 않았지만 원문 문장에서 발견되는, 통째로 익히면 유용한 자연스러운 회화 덩어리(구동사·연어·관용 표현 등, 예: get much sleep).
- 핵심 Chunk와 그 활용형(could use some rest, could seriously use 등)은 넣지 않습니다. 너무 평범한 단어, 고유명사는 제외합니다.
- 문장마다 0~2개. 없으면 넣지 않습니다. 강사가 가르친 것처럼 쓰지 않습니다.
- 실제 원어민이 일상 회화에서 반복해서 쓰는 자연스러운 덩어리만 고릅니다.
- 기본형 규칙: 문장에 정도만 강조하는 말(super, really, so, very, pretty, totally 등)이 끼어 있고 빼도 핵심 뜻이 그대로면, 뺀 형태를 학습용 기본 Chunk로 적습니다.
  예) look super tired → look tired, look really happy → look happy, look so familiar → look familiar
- 무조건 짧게 줄이지 않습니다. 빼면 뜻이나 자연스러움이 달라지는 말(not, never, too, only, almost 등, 예: too tired ≠ tired)이나 덩어리의 일부인 말(get much sleep의 much 등)은 그대로 둡니다.
- text: 학습용 기본 Chunk — 실제 회화에서 그대로 쓰는 완성된 표현. 억지로 줄이지 않습니다 (which car to buy는 그대로).
- parts: text를 원문에서 찾을 수 있게 나눈 조각. 원문에서 사이에 뺀 말이 있으면 그 앞뒤로 나눕니다 (look tired ← look super tired: ["look", "tired"]). 붙어 있으면 [text]
- surface: 원문 문장에 실제로 쓰인 형태 그대로 (예: look super tired)
- 교체 패턴은 기본 Chunk와 다른 정보입니다. 기본 Chunk의 일부 단어를 바꿔 새 표현을 만들 수 있을 때만 적습니다.
- pattern: "고정 부분 + 자리 + 고정 부분" 형식. 자리 이름은 명사, 불가산명사, 형용사, 동사원형, 동사-ing, 사람, 장소 중 하나만 씁니다. 고정 부분은 text에 있는 단어 그대로·같은 순서입니다.
  예) which car to buy → "which + 명사 + to buy", didn't get much sleep → "didn't get much + 불가산명사", look tired → "look + 형용사", a cup of coffee → "a cup of + 명사"
  자연스러운 교체 자리를 확신할 수 없거나 고정된 관용 표현이면 ""
- slotNote: 자리에 무엇이 들어가는지 짧게 (예: "명사 자리: 사려는 물건", "명사 자리: 음료"). pattern이 ""이면 ""
- swapExamples: pattern의 자리만 바꾼, 원어민이 실제로 자주 쓰는 활용 예시 0~3개. 문법상 pattern과 정확히 맞아야 합니다. text와 같은 것은 넣지 않습니다. pattern이 ""이면 []
  · en: 활용 예시 (예: which phone to buy) · ko: 자연스러운 한국어 뜻 (예: 어떤 폰을 살지)
  · note: text와 뜻이 달라지면 그 차이 (예: rest는 잠보다 넓게 쉬는 것 전반). 차이가 없으면 ""
- meaningKo(뜻), meaningInSentence(이 문장 문맥에서의 의미), nuance, usage, comparison, examples(짧은 응용 예문 2개)`;

/** sentenceRule·lineRule을 주면 원문 문장 사용·줄 수 규칙만 바꾼다 (Day 1~100 Day 자료: 넣은 문장 모두 원문 그대로 포함) */
const DIALOGUE_RULES = (dayLabel: string, opts: { sentenceRule?: string; lineRule?: string } = {}) => `Day 통합 대화문(dialogue): 이 영상의 원문 문장과 핵심 Chunk로, 학습자가 통째로 외울 자연스러운 대화문 1개를 만듭니다.
- 대화의 흐름과 상황이 우선입니다. 실제 원어민이 일상에서 주고받을 법한 대화로 만듭니다.
${opts.sentenceRule ?? '- 원문 문장을 그대로 넣어도 되고, 자연스럽게 잇기 위해 새 문장을 더해도 됩니다. 원문 문장을 그대로(또는 거의 그대로) 쓴 줄은 sourceSentenceNumber에 그 번호를, 새로 만든 줄은 0을 적습니다.'}
- 핵심 Chunk의 의미와 뉘앙스를 유지하고, 가능하면 대화 안에서 여러 번 자연스럽게 씁니다(억지로 반복하지 않음). 추가 덩어리 표현은 자연스러울 때만 일부 씁니다.
${opts.lineRule ?? '- 화자 A와 B가 번갈아 8~14줄.'} 모든 줄에 자연스러운 한국어 번역(ko).
- chunkTexts: 그 줄에 들어간 핵심 Chunk·추가 덩어리 표현의 text (없으면 빈 배열)
- chunkNotes: 대화에 쓴 표현마다 하나. kind는 핵심 Chunk면 "core", 추가 덩어리 표현이면 "extra". usedAs(대화에 실제로 쓴 형태들, en에 그대로 있는 부분), meaningInContext(이 대화에서의 의미), nuance, whyUsed(대화 속에서 쓴 이유), example(다른 상황 응용 예문 en·ko)
- title은 짧은 한국어 제목(${dayLabel} 포함), situation은 상황과 맥락(한국어 2~3문장).
- ${USEFUL_RULES}`;

const dayLabelOf = (r: { seriesKind: string; dayNumber: number | null; title: string }) => (r.seriesKind === 'day' && r.dayNumber ? `Day ${r.dayNumber}` : '이 영상');

export function buildPackPrompt(r: AiPackRequest): string {
  const sentenceRule =
    r.seriesKind === 'day'
      ? `1. sentences: 영상에서 번호를 붙여 제시한 영어 문장을 영상에 나온 번호와 순서 그대로, 원문 그대로 적습니다(고치지 않음).
- 개수는 영상에 실제로 나온 만큼만(4개든 6개든). number는 영상의 번호, 불분명하면 가르친 순서대로 1부터.
- 인사, 구독 안내, 한국어 설명 문장은 넣지 않습니다.`
      : `1. sentences: Day 시리즈가 아니므로 번호가 붙었다고 무조건 고르지 않습니다. 원어민이 일상회화에서 자주 쓰는, 통째로 익혀 응용할 수 있는 표현이 들어 있는 문장을 자막에서 원문 그대로 3~10개 고릅니다(단순 발췌·평범한 문장·고유명사 위주 문장 제외). number는 나온 순서대로 1부터.`;
  return `아래는 영어 학습 영상${r.seriesKind === 'day' && r.dayNumber ? ` "Day ${r.dayNumber}"` : ''}(제목: ${r.title})의 전체 자막입니다. 강사가 한국어로 영어 표현을 설명하는 부분이 들어 있습니다.

${sentenceRule}
- text는 자막에 있는 영어 문장을 그대로 복사합니다. 자막에 없는 문장을 지어내지 않습니다.
- meaningKo는 자연스러운 한국어 뜻, timestampSec는 그 문장이 처음 나오는 시각(초, 모르면 -1).
- 각 문장의 chunks에는 아래 3번의 "추가 덩어리 표현"만 적습니다(핵심 Chunk와 그 활용형은 넣지 않음).

2. ${CORE_RULES}
${PARTS_RULE}

3. ${EXTRA_RULES}
${PARTS_RULE}

4. ${DIALOGUE_RULES(dayLabelOf(r))}

5. notes: 확신하지 못한 부분. 없으면 빈 문자열.
설명은 모두 한국어로 씁니다. JSON으로만 답하세요.

[자막]
${r.transcript}`;
}

/** Day 1~100 시리즈 (앱의 src/services/days/daySeries.ts와 같은 범위) — Day 자료 문장(영상 원문 후보 + 사용자가 직접 넣은 문장, 뺀 문장 제외)으로 만든다 */
const isDayUserPack = (r: AiDayPackRequest) => r.seriesKind === 'day' && typeof r.dayNumber === 'number' && r.dayNumber >= 1 && r.dayNumber <= 100;

/** 앱이 보낸 Day 자료 문장 n개를 모두 원문 그대로 넣는 대화문 규칙 (줄이거나 고르지 않음, 나열하지 않음) */
function dayUserDialogueRules(n: number): { sentenceRule: string; lineRule: string } {
  const min = Math.max(8, n + 4);
  const max = Math.min(30, Math.max(14, n * 2 + 4));
  return {
    sentenceRule: `- 아래 원문 핵심 문장 ${n}개는 학습자가 직접 고른 문장입니다. ${n}개 모두 빠짐없이 대화에 넣습니다. 일부만 고르거나 줄이거나 합치지 않습니다.
- 각 원문 문장은 원문 그대로(단어·어순·표현을 바꾸지 않고) 한 줄 안에 통째로 넣고, 그 줄의 sourceSentenceNumber에 그 번호를 적습니다. 자연스럽게 잇기 위해 원문 앞뒤에 짧은 말(예: "Honestly, ", ", right?")을 붙이는 것은 괜찮지만 원문 부분은 그대로 둡니다.
- 원문 문장들을 순서대로 나열하지 않습니다. 하나의 상황 안에서 대화의 맥락과 흐름에 맞게 배치하고(순서는 바꿔도 됩니다), 그 사이를 새 줄로 자연스럽게 잇습니다. 새로 만든 줄은 sourceSentenceNumber에 0을 적습니다.`,
    lineRule: `- 화자 A와 B가 번갈아 ${min}~${max}줄 (원문 문장 ${n}개가 모두 들어가도록).`,
  };
}

export function buildDayPackPrompt(r: AiDayPackRequest): string {
  const list = r.sentences.map((x) => `${x.number}. ${x.text}${x.meaningKo ? ` (뜻: ${x.meaningKo})` : ''}`).join('\n');
  const hints = r.taughtHints?.length ? `\n[이 영상 자막 분석에서 강사가 가르친 표현으로 찾은 것 — 참고]\n${r.taughtHints.join(', ')}\n` : '';
  const transcript = r.transcript ? `\n[강의 자막 — 강사가 무엇을 가르쳤는지 판단하는 근거]\n${r.transcript}\n` : '';
  return `아래는 영어 학습 영상(${dayLabelOf(r)}, 제목: ${r.title})의 원문 핵심 문장입니다. 원문 문장은 고치지 않습니다.

1. ${CORE_RULES}
${PARTS_RULE}

2. extraChunks — ${EXTRA_RULES}
- sentenceNumber: 그 표현이 들어 있는 원문 문장 번호
${PARTS_RULE}

3. ${DIALOGUE_RULES(dayLabelOf(r), isDayUserPack(r) ? dayUserDialogueRules(r.sentences.length) : {})}

4. notes: 확신하지 못한 부분. 없으면 빈 문자열.
설명은 모두 한국어로 씁니다. JSON으로만 답하세요.

[원문 핵심 문장]
${list}
${hints}${transcript}`;
}
