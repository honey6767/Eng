import {
  AI_DAYPACK_PROMPT_VERSION,
  AI_PACK_PROMPT_VERSION,
  CONTENT_LIMITS,
  DAYPACK_LIMITS,
  type AiDayPackRequest,
  type AiPackRequest,
} from '@/types/aiApi';
import type { BlankPlan, DayAssignment, Dialogue, DialogueChunkUsage, DialogueLine, DialogueSegment, Expression, KeySentence, LearningItem, Transcript, Video } from '@/types/models';
import { normalizeExpressionKey } from '@/utils/text';
import { chunkLabel, matchAllParts, matchParts, partsFrom, wordsOf } from '@/utils/chunkMatch';
import { isSafeBase, locateChunk, parsePatternFields, patternDetail } from '@/utils/chunkBase';
import { phraseSpansByLine, validateUsefulPhrases } from '@/services/phrases/usefulPhrases';
import { includedDaySentences } from '@/services/days/daySeries';
import { contentChunkId, planContent, seriesOf, transcriptText, validateContent, type ContentChunk, type ContentResult } from '@/services/content/contentService';

/**
 * 학습 자료(Day 하나) — 원문 문장 · 문장별 Chunk · 공통 핵심 Chunk · Day 통합 대화문 · 빈칸 자료
 *
 * - pack: 저장된 자막 → 전부 (Gemini 1회)
 * - daypack: 이미 저장된 원문 문장 → 공통 핵심 Chunk + Day 통합 대화문 (Gemini 1회, 자막은 보내지 않음)
 * - 저장은 추가만. 원문 문장은 고치지 않는다. 빈칸 자료는 AI 없이 기기에서 계산한다.
 */

// ─────────────────────────────────────────────
// 요청
// ─────────────────────────────────────────────

export function buildPackRequest(video: Video, transcript: Transcript, day: DayAssignment | undefined): AiPackRequest {
  const s = seriesOf(video, day);
  return { task: 'pack', videoId: video.youtubeVideoId!, title: video.title.slice(0, CONTENT_LIMITS.titleChars), seriesKind: s.seriesKind, dayNumber: s.dayNumber, transcript: transcriptText(transcript), promptVersion: AI_PACK_PROMPT_VERSION };
}

/** 이 영상의 AI 원문 문장 (번호순) — daypack 재료 */
export function aiSentencesOf(sentences: KeySentence[]): KeySentence[] {
  return sentences.filter((s) => s.origin === 'ai_extracted').sort((a, b) => (a.aiNumber ?? a.order) - (b.aiNumber ?? b.order));
}

export function buildDayPackRequest(video: Video, day: DayAssignment | undefined, sentences: KeySentence[], items: LearningItem[], expressions: Map<string, Expression>, transcript?: Transcript): AiDayPackRequest {
  const s = seriesOf(video, day);
  const L = DAYPACK_LIMITS;
  // 자막 추출 때 '이 영상이 가르치는 핵심 표현'으로 찾은 것 (강사가 가르친 표현의 참고)
  const taughtHints = [...new Set(items.filter((i) => i.kind === 'key').map((i) => expressions.get(i.expressionId)?.text ?? '').filter(Boolean))].map((t) => t.slice(0, L.chunkChars)).slice(0, 10);
  const transcriptBody = transcript ? transcriptText(transcript) : '';
  return {
    task: 'daypack',
    videoId: video.youtubeVideoId!,
    title: video.title.slice(0, CONTENT_LIMITS.titleChars),
    seriesKind: s.seriesKind,
    dayNumber: s.dayNumber,
    sentences: aiSentencesOf(sentences)
      .slice(0, L.maxSentences)
      .map((x) => ({
        number: x.aiNumber ?? x.order,
        text: x.english.slice(0, L.sentenceChars),
        meaningKo: x.korean.slice(0, L.sentenceChars),
        // 예전 기준의 문장별 Chunk(활용형이 섞여 있음)는 보내지 않는다 — 핵심/추가를 새 기준으로 다시 판단
        chunks: [],
      })),
    ...(transcriptBody.trim() ? { transcript: transcriptBody } : {}),
    ...(taughtHints.length ? { taughtHints } : {}),
    promptVersion: AI_DAYPACK_PROMPT_VERSION,
  };
}

/**
 * Day 1~100 영상의 Day 자료 요청 — 사용자가 직접 입력하거나 자막에서 고른 핵심 문장만 (사용자가 정한 순서, 1번부터)
 * - AI가 뽑은 문장·저장된 자막·자막 분석 힌트는 보내지 않는다
 * - 영어 원문은 자르거나 고치지 않는다 (길면 보내기 전에 거절 — daySentenceProblem)
 */
export function buildDayUserRequest(video: Video, day: DayAssignment | undefined, sentences: KeySentence[], excluded: ReadonlySet<string> = new Set()): AiDayPackRequest {
  const s = seriesOf(video, day);
  const L = DAYPACK_LIMITS;
  return {
    task: 'daypack',
    videoId: video.youtubeVideoId!,
    title: video.title.slice(0, CONTENT_LIMITS.titleChars),
    seriesKind: s.seriesKind,
    dayNumber: s.dayNumber,
    // Day 자료에서 뺀 문장은 보내지 않는다 (번호도 건너뜀)
    sentences: includedDaySentences(sentences, excluded).map((x, i) => ({ number: i + 1, text: x.english, meaningKo: (x.korean ?? '').slice(0, L.sentenceChars), chunks: [] })),
    promptVersion: AI_DAYPACK_PROMPT_VERSION,
  };
}

/** 요청 때 보낸 문장 번호 → 지금의 사용자 문장 id. 그 사이 문장이 바뀌었으면(추가·삭제·수정·순서·빼기/다시 넣기) null */
export function daySentenceMap(sent: { number: number; text: string }[], sentences: KeySentence[], excluded: ReadonlySet<string> = new Set()): Map<number, string> | null {
  const now = includedDaySentences(sentences, excluded);
  if (now.length !== sent.length) return null;
  const map = new Map<number, string>();
  for (const [i, x] of now.entries()) {
    const s = sent[i];
    if (!s || s.number !== i + 1 || s.text !== x.english) return null;
    map.set(s.number, x.id);
  }
  return map;
}

// ─────────────────────────────────────────────
// 응답 검사
// ─────────────────────────────────────────────

const txt = (v: unknown, max = 600) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const examplesOf = (v: unknown) =>
  (Array.isArray(v) ? (v as Record<string, unknown>[]) : [])
    .map((e) => ({ en: txt(e?.en, 300), ko: txt(e?.ko, 300) }))
    .filter((e) => e.en)
    .slice(0, 3);

export interface CoreChunk {
  text: string;
  parts: string[];
  /** 강사가 설명한 부분 (자막 인용, 없으면 빈 문자열) */
  taught: string;
  meaningKo: string;
  nuance: string;
  usage: string;
  comparison: string;
  examples: { en: string; ko: string }[];
}

export interface DayDialogueLine {
  speaker: 'A' | 'B';
  en: string;
  ko: string;
  /** 원문 문장 번호 (새로 만든 줄은 null) */
  sourceNumber: number | null;
}

export interface ChunkNote {
  meaningInContext: string;
  nuance: string;
  whyUsed: string;
  example: { en: string; ko: string };
}

export interface ExtraChunk {
  sentenceNumber: number;
  chunk: ContentChunk;
}

export interface DayPackResult {
  core: CoreChunk[];
  /** daypack의 추가 덩어리 표현 (pack은 문장별 chunks에 들어 있음) */
  extras: ExtraChunk[];
  /** 공통 Chunk의 normalizedKey → 대화 속 설명 */
  notes: Map<string, ChunkNote>;
  title: string;
  situation: string;
  lines: DayDialogueLine[];
  extraNotes: string;
  /** 대화문의 ✨ 유용한 회화 표현 (AI 원본, 저장 때 검사) */
  usefulRaw?: unknown;
}

export type PackValidation = { ok: true; content: ContentResult | null; pack: DayPackResult; issues: string[] } | { ok: false; error: string };

/** 표현이 핵심 Chunk 자체이거나 그 활용형(could use some rest, could seriously use)인지 */
export function isCoreVariant(text: string, core: { parts: string[] }[]): boolean {
  return core.some((c) => !!matchParts(text, c.parts));
}

/** 비교용 단어 목록 */
const wordList = (s: string) => wordsOf(s).map((t) => t.w);

/** 줄이 원문 문장을 그대로(또는 거의 그대로) 썼는지 — 원문 단어의 80% 이상이 순서대로 들어 있으면 */
export function usesSentence(line: string, sentence: string): boolean {
  const a = wordList(sentence);
  const b = wordList(line);
  if (!a.length) return false;
  let j = 0;
  let hit = 0;
  for (const w of a) {
    const k = b.indexOf(w, j);
    if (k >= 0) {
      hit++;
      j = k + 1;
    }
  }
  return hit / a.length >= 0.8;
}

function validateDayPackObject(raw: Record<string, unknown>, sentences: { number: number; text: string }[], issues: string[]): DayPackResult | string {
  const core: CoreChunk[] = [];
  const seen = new Set<string>();
  for (const c of Array.isArray(raw.coreChunks) ? (raw.coreChunks as Record<string, unknown>[]) : []) {
    const text = txt(c?.text, 120);
    const key = normalizeExpressionKey(text);
    if (!text || !key || seen.has(key)) continue;
    const parts = partsFrom(text, c.parts);
    // 실제로 원문 문장에 나오는 공통 Chunk만 (모든 문장에 있다고 가정하지 않음)
    if (!sentences.some((s) => matchParts(s.text, parts))) {
      issues.push(`공통 Chunk '${text}'는 원문 문장에서 찾지 못해 뺐어요.`);
      continue;
    }
    seen.add(key);
    core.push({ text, parts, taught: txt(c.taughtEvidence, 400), meaningKo: txt(c.meaningKo, 200), nuance: txt(c.nuance), usage: txt(c.usage), comparison: txt(c.comparison), examples: examplesOf(c.examples) });
  }
  // 추가 덩어리 표현 (daypack): 원문 문장에 실제로 있고, 핵심 Chunk(또는 그 활용형)가 아닌 것만
  const extras: ExtraChunk[] = [];
  const extraSeen = new Set<string>();
  for (const x of Array.isArray(raw.extraChunks) ? (raw.extraChunks as Record<string, unknown>[]) : []) {
    let text = txt(x?.text, 120);
    const sentence = sentences.find((s) => s.number === x?.sentenceNumber);
    if (!text || !sentence) continue;
    const found = locateChunk(sentence.text, text, x.parts);
    if (!found) {
      issues.push(`추가 표현 '${text}'는 ${sentence.number}번 문장에서 찾지 못해 뺐어요.`);
      continue;
    }
    let { parts } = found;
    const { m } = found;
    // 기본형으로 줄이면서 뜻이 바뀌는 말(not, too …)을 뺐다면 원문 형태 그대로
    if (!isSafeBase(m.surface, text)) {
      issues.push(`'${text}'로 줄이면 뜻이 달라져 원문 형태 '${m.surface}'로 뒀어요.`);
      text = m.surface;
      parts = [text];
    }
    const key = normalizeExpressionKey(text);
    if (!key || extraSeen.has(key)) continue;
    if (isCoreVariant(text, core)) {
      issues.push(`'${text}'는 핵심 Chunk의 활용형이라 추가 표현에서 뺐어요.`);
      continue;
    }
    extraSeen.add(key);
    extras.push({
      sentenceNumber: sentence.number,
      chunk: {
        text, meaningKo: txt(x.meaningKo, 200), meaningInSentence: txt(x.meaningInSentence), nuance: txt(x.nuance), usage: txt(x.usage), comparison: txt(x.comparison), examples: examplesOf(x.examples),
        ...(parts.length > 1 && m.surface.toLowerCase() !== text.toLowerCase() ? { parts, surface: m.surface } : {}),
        ...(parsePatternFields(x, text) ?? {}),
      },
    });
  }
  const d = (raw.dialogue ?? {}) as Record<string, unknown>;
  const numbers = new Map(sentences.map((s) => [s.number, s.text]));
  const lines: DayDialogueLine[] = [];
  for (const l of Array.isArray(d.lines) ? (d.lines as Record<string, unknown>[]) : []) {
    const en = txt(l?.en, 500);
    if (!en) continue;
    let sourceNumber: number | null = typeof l.sourceSentenceNumber === 'number' && l.sourceSentenceNumber > 0 ? l.sourceSentenceNumber : null;
    if (sourceNumber !== null && !(numbers.has(sourceNumber) && usesSentence(en, numbers.get(sourceNumber)!))) {
      issues.push(`대화 ${lines.length + 1}번째 줄의 원문 출처(${sourceNumber}번)가 실제 문장과 달라 연결하지 않았어요.`);
      sourceNumber = null;
    }
    lines.push({ speaker: l.speaker === 'B' ? 'B' : 'A', en, ko: txt(l.ko, 500), sourceNumber });
  }
  if (lines.length < 2) return '대화 줄이 너무 적어요.';
  if (lines.some((l) => !l.ko)) issues.push('한국어 번역이 빠진 줄이 있어요.');
  const notes = new Map<string, ChunkNote>();
  for (const n of Array.isArray(d.chunkNotes) ? (d.chunkNotes as Record<string, unknown>[]) : []) {
    const key = normalizeExpressionKey(txt(n?.text, 120));
    if (!key || notes.has(key)) continue;
    const ex = (n.example ?? {}) as Record<string, unknown>;
    notes.set(key, { meaningInContext: txt(n.meaningInContext), nuance: txt(n.nuance), whyUsed: txt(n.whyUsed), example: { en: txt(ex.en, 300), ko: txt(ex.ko, 300) } });
  }
  return { core, extras, notes, title: txt(d.title, 100), situation: txt(d.situation, 800), lines, extraNotes: txt(raw.notes, 1000), usefulRaw: d.usefulPhrases };
}

export function validatePack(text: string, durationSec: number | null): PackValidation {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'JSON 형식이 아니에요.' };
  }
  const c = validateContent(JSON.stringify({ sentences: raw.sentences, notes: raw.notes }), durationSec);
  if (!c.ok) return c;
  const issues = [...c.issues];
  const pack = validateDayPackObject(raw, c.result.sentences, issues);
  if (typeof pack === 'string') return { ok: false, error: pack };
  // 문장별 chunks = 추가 덩어리 표현: 핵심 Chunk와 그 활용형은 빼고 (핵심 Chunk 아래 활용 사례로 보임)
  const content: ContentResult = {
    ...c.result,
    sentences: c.result.sentences.map((s) => ({
      ...s,
      chunks: s.chunks.filter((ch) => {
        const variant = isCoreVariant(ch.text, pack.core);
        if (variant) issues.push(`'${ch.text}'는 핵심 Chunk의 활용형이라 추가 표현에서 뺐어요.`);
        return !variant;
      }),
    })),
  };
  return { ok: true, content, pack, issues };
}

export function validateDayPack(text: string, sentences: { number: number; text: string }[]): PackValidation {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'JSON 형식이 아니에요.' };
  }
  const issues: string[] = [];
  const pack = validateDayPackObject(raw, sentences, issues);
  if (typeof pack === 'string') return { ok: false, error: pack };
  return { ok: true, content: null, pack, issues };
}

// ─────────────────────────────────────────────
// 빈칸 자료 (AI 없음)
// ─────────────────────────────────────────────

const STOP = new Set(
  "a an the and or but so of to in on at by for with from up as is am are was were be been being i you he she it we they me him her us them my your his its our their this that these those do does did have has had will would can could shall should may might must not no yes oh ok okay just very really too also then there here what who how when where why which if than well".split(
    ' ',
  ),
);

/**
 * 줄마다 단어별 빈칸 순위
 * - coreIds를 주면 version 2: 1 = 핵심 Chunk, 2 = 추가 덩어리 표현, 3 = 주요 단어, 4 = 나머지
 * - 없으면 version 1(예전 형식): 1 = Chunk 부분, 2 = 주요 단어, 3 = 나머지
 */
export function buildBlankPlan(lines: DialogueLine[], coreIds?: Set<string>, usefulSpans?: Record<string, { s: number; e: number }[]>): BlankPlan {
  const v2 = !!coreIds;
  const out: BlankPlan = { version: v2 ? 2 : 1, lines: {} };
  for (const line of lines) {
    const en = line.segments.map((s) => s.text).join(' ');
    // 세그먼트를 이어 붙인 문장에서 Chunk 위치
    const spans: { s: number; e: number; core: boolean }[] = [];
    let pos = 0;
    line.segments.forEach((seg, i) => {
      if (i > 0) pos += 1;
      if (seg.kind === 'key' && seg.learningItemId) spans.push({ s: pos, e: pos + seg.text.length, core: !v2 || coreIds!.has(seg.learningItemId) });
      pos += seg.text.length;
    });
    // ✨ 유용한 회화 표현(대화문 출처)은 추가 표현과 같은 2순위
    for (const u of usefulSpans?.[line.id] ?? []) spans.push({ s: u.s, e: u.e, core: false });
    out.lines[line.id] = wordsOf(en).map((t) => {
      const sp = spans.find((x) => t.start >= x.s && t.end <= x.e);
      const content = t.w.length >= 3 && !STOP.has(t.w);
      if (!v2) return sp ? 1 : content ? 2 : 3;
      return sp ? (sp.core ? 1 : 2) : content ? 3 : 4;
    });
  }
  return out;
}

// ─────────────────────────────────────────────
// 저장 계획 (추가만)
// ─────────────────────────────────────────────

export interface PackContext {
  video: Video;
  dayNumber: number | null;
  /** pack이면 원문 문장·Chunk 결과 (이미 저장돼 있으면 null) */
  content: ContentResult | null;
  pack: DayPackResult;
  requestId: string;
  existingSentences: KeySentence[];
  existingItems: LearningItem[];
  existingDialogues: Dialogue[];
  expressionIdByKey: Map<string, string>;
  now: string;
  newId: () => string;
  /** Day 자료(사용자 문장): 요청 문장 번호 → 사용자 문장 id. 있으면 AI 문장 대신 이것으로 연결 */
  sentenceIdByNumber?: Map<number, string>;
}

export interface PackPlan {
  sentences: KeySentence[];
  expressions: Expression[];
  items: LearningItem[];
  dialogue: Dialogue | null;
  /** 공통 Chunk 수 · 대화문 줄 수 · 원문을 쓴 줄 수 */
  summary: { sentences: number; chunks: number; core: number; lines: number; sourcedLines: number };
}

export const coreItemId = (requestId: string, expressionId: string) => `li-core-${requestId}-${expressionId}`;
export const dayDialogueId = (requestId: string) => `dlg-day-${requestId}`;

/** 이 영상의 AI Day 통합 대화문이 이미 있는지 */
export function hasDayDialogue(dialogues: Dialogue[], videoId: string): boolean {
  return dialogues.some((d) => d.videoId === videoId && d.kind === 'original' && d.generatedBy === 'ai');
}

/** 영어 문장을 Chunk 부분(key)과 나머지(connector)로 나눈다 */
function segmentBySpans(en: string, spans: { s: number; e: number; id: string }[]): DialogueSegment[] {
  const sorted = [...spans].sort((a, b) => a.s - b.s).filter((x, i, arr) => i === 0 || x.s >= arr[i - 1].e);
  const out: DialogueSegment[] = [];
  let pos = 0;
  for (const sp of sorted) {
    const before = en.slice(pos, sp.s).trim();
    if (before) out.push({ kind: 'connector', text: before });
    out.push({ kind: 'key', text: en.slice(sp.s, sp.e), learningItemId: sp.id });
    pos = sp.e;
  }
  const rest = en.slice(pos).trim();
  if (rest) out.push({ kind: 'connector', text: rest });
  return out.length ? out : [{ kind: 'connector', text: en }];
}

export function planPack(ctx: PackContext): PackPlan {
  const { video, pack, requestId, now } = ctx;
  const sourceType = ctx.dayNumber ? 'day' : 'other';
  let sentences: KeySentence[] = [];
  let expressions: Expression[] = [];
  let items: LearningItem[] = [];
  let byKey = new Map(ctx.expressionIdByKey);
  const allSentences = [...ctx.existingSentences];
  let idByNumber = new Map<number, string>();

  if (ctx.content) {
    // pack의 문장별 chunks는 '추가 덩어리 표현'으로 저장 (핵심 Chunk와 그 활용형은 이미 빠져 있음)
    const c = planContent({ video, dayNumber: ctx.dayNumber, result: ctx.content, requestId, existingSentences: ctx.existingSentences, existingItems: ctx.existingItems, expressionIdByKey: byKey, now, newId: ctx.newId, chunkRole: 'extra' });
    sentences = c.sentences;
    expressions = c.expressions;
    items = c.items;
    byKey = c.expressionIdByKey;
    idByNumber = c.sentenceIdByNumber;
    allSentences.push(...c.sentences);
  } else if (ctx.sentenceIdByNumber) {
    idByNumber = new Map(ctx.sentenceIdByNumber);
  } else {
    for (const s of aiSentencesOf(ctx.existingSentences)) if (!idByNumber.has(s.aiNumber ?? s.order)) idByNumber.set(s.aiNumber ?? s.order, s.id);
  }
  const sentenceById = new Map(allSentences.map((s) => [s.id, s]));
  const ordered = [...idByNumber.entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => sentenceById.get(id)).filter((s): s is KeySentence => !!s);

  // 공통 핵심 Chunk
  const existingCore = new Set(ctx.existingItems.filter((i) => i.kind === 'core').map((i) => i.expressionId));
  const coreItems: { item: LearningItem; core: CoreChunk }[] = [];
  for (const core of pack.core) {
    const key = normalizeExpressionKey(core.text);
    let exprId = byKey.get(key);
    if (!exprId) {
      exprId = ctx.newId();
      expressions.push({ id: exprId, createdAt: now, updatedAt: now, normalizedKey: key, text: core.text, meaningKo: core.meaningKo, sourceRefs: [{ videoId: video.id }], isFavorite: false, isMarkedDifficult: false, origin: 'ai_extracted' });
      byKey.set(key, exprId);
    }
    if (existingCore.has(exprId)) continue;
    existingCore.add(exprId);
    const occurrences = ordered.flatMap((s) => {
      const m = matchParts(s.english, core.parts);
      return m ? [{ sentenceId: s.id, surface: m.surface }] : [];
    });
    const first = occurrences[0];
    const item: LearningItem = {
      id: coreItemId(requestId, exprId), createdAt: now, updatedAt: now, expressionId: exprId, videoId: video.id, sourceType, dayNumber: ctx.dayNumber,
      kind: 'core', dialogueId: null, sourceText: first ? (sentenceById.get(first.sentenceId)?.english ?? null) : null, timestampSec: first ? (sentenceById.get(first.sentenceId)?.timestampSec ?? null) : null,
      onScreen: false, origin: 'ai_extracted', status: 'confirmed', extractionDraftId: null, legacyKeySentenceId: null, sentenceId: first?.sentenceId ?? null,
      chunk: { meaningInSentence: core.meaningKo, nuance: core.nuance, usage: core.usage, comparison: core.comparison, examples: core.examples, parts: core.parts, surface: first?.surface, ...(core.taught ? { taught: core.taught } : {}) },
      occurrences, selected: false, contentRequestId: requestId,
    };
    items.push(item);
    coreItems.push({ item, core });
  }

  // 추가 덩어리 표현 (daypack): 원문 문장에 연결, 같은 영상·같은 표현은 한 번만
  const chunkExpr = new Set([...ctx.existingItems, ...items].filter((i) => i.kind === 'chunk').map((i) => i.expressionId));
  for (const x of pack.extras) {
    const sentenceId = idByNumber.get(x.sentenceNumber);
    const sentence = sentenceId ? sentenceById.get(sentenceId) : undefined;
    if (!sentenceId || !sentence) continue;
    const key = normalizeExpressionKey(x.chunk.text);
    let exprId = byKey.get(key);
    if (!exprId) {
      exprId = ctx.newId();
      expressions.push({ id: exprId, createdAt: now, updatedAt: now, normalizedKey: key, text: x.chunk.text, meaningKo: x.chunk.meaningKo, sourceRefs: [{ videoId: video.id }], isFavorite: false, isMarkedDifficult: false, origin: 'ai_extracted' });
      byKey.set(key, exprId);
    }
    if (chunkExpr.has(exprId)) continue;
    chunkExpr.add(exprId);
    items.push({
      id: contentChunkId(requestId, exprId), createdAt: now, updatedAt: now, expressionId: exprId, videoId: video.id, sourceType, dayNumber: ctx.dayNumber, kind: 'chunk', dialogueId: null,
      sourceText: sentence.english, timestampSec: sentence.timestampSec, onScreen: false, origin: 'ai_extracted', status: 'confirmed', extractionDraftId: null, legacyKeySentenceId: null, sentenceId,
      chunk: { meaningInSentence: x.chunk.meaningInSentence, nuance: x.chunk.nuance, usage: x.chunk.usage, comparison: x.chunk.comparison, examples: x.chunk.examples, ...(x.chunk.parts ? { parts: x.chunk.parts } : {}), ...(x.chunk.surface ? { surface: x.chunk.surface } : {}), ...patternDetail(x.chunk) },
      chunkRole: 'extra', selected: false, contentRequestId: requestId,
    });
  }
  // 대화문에 표시할 추가 덩어리 표현: 새로 만든 것 + 이 영상에 이미 있는 '추가' 표시 항목
  const exprText = new Map([...expressions.map((e) => [e.id, e.text] as const)]);
  const extraItems = [...ctx.existingItems, ...items].filter((i) => i.kind === 'chunk' && i.chunkRole === 'extra');
  const extraParts = (i: LearningItem) => i.chunk?.parts ?? [exprText.get(i.expressionId) ?? ([...byKey.entries()].find(([, id]) => id === i.expressionId)?.[0] ?? '')];

  // Day 통합 대화문
  let dialogue: Dialogue | null = null;
  if (!hasDayDialogue(ctx.existingDialogues, video.id)) {
    const usedForms = new Map<string, string[]>();
    const lines: DialogueLine[] = pack.lines.map((l, i) => {
      const spans = [
        ...coreItems.flatMap(({ item, core }) =>
          matchAllParts(l.en, core.parts).flatMap((m) => {
            usedForms.set(item.id, [...(usedForms.get(item.id) ?? []), m.surface]);
            return m.spans.map(([s, e]) => ({ s, e, id: item.id }));
          }),
        ),
        ...extraItems.flatMap((item) =>
          matchAllParts(l.en, extraParts(item).filter(Boolean)).flatMap((m) => {
            usedForms.set(item.id, [...(usedForms.get(item.id) ?? []), m.surface]);
            return m.spans.map(([s, e]) => ({ s, e, id: item.id }));
          }),
        ),
      ];
      const sourceSentenceId = l.sourceNumber !== null ? idByNumber.get(l.sourceNumber) : undefined;
      return { id: `line-${requestId}-${i}`, order: i + 1, speaker: l.speaker, segments: segmentBySpans(l.en, spans), korean: l.ko, ...(sourceSentenceId ? { sourceSentenceId } : {}) };
    });
    const usages: DialogueChunkUsage[] = [
      ...coreItems
        .filter(({ item }) => usedForms.has(item.id))
        .map(({ item, core }) => {
          const n = pack.notes.get(normalizeExpressionKey(core.text));
          const forms = [...new Set(usedForms.get(item.id))];
          return {
            learningItemId: item.id, kind: 'core' as const, expressionId: item.expressionId, text: chunkLabel(core.text, core.parts, [...forms, ...(item.occurrences ?? []).map((o) => o.surface)]), usedAs: forms.join(' / '),
            dayNumber: ctx.dayNumber, videoId: video.id, meaningInContext: n?.meaningInContext || core.meaningKo, nuance: n?.nuance || core.nuance, whyUsed: n?.whyUsed ?? '', example: n?.example ?? core.examples[0] ?? { en: '', ko: '' },
          };
        }),
      ...extraItems
        .filter((item) => usedForms.has(item.id))
        .map((item) => {
          const text = exprText.get(item.expressionId) ?? item.chunk?.surface ?? '';
          const n = pack.notes.get(normalizeExpressionKey(text));
          const forms = [...new Set(usedForms.get(item.id))];
          return {
            learningItemId: item.id, kind: 'extra' as const, expressionId: item.expressionId, text, usedAs: forms.join(' / '), dayNumber: ctx.dayNumber, videoId: video.id,
            meaningInContext: n?.meaningInContext || item.chunk?.meaningInSentence || '', nuance: n?.nuance || item.chunk?.nuance || '', whyUsed: n?.whyUsed ?? '', example: n?.example ?? item.chunk?.examples[0] ?? { en: '', ko: '' },
          };
        }),
    ];
    // ✨ 유용한 회화 표현 (대화문 자체 출처) — 핵심 Chunk·원문 출처 표현과 겹치지 않게, 상한 안에서
    const extraIds = new Set(usages.filter((u) => u.kind === 'extra').map((u) => u.learningItemId));
    const phrases = validateUsefulPhrases(pack.usefulRaw, lines, { coreTexts: coreItems.map((c) => c.core.text), extraIds, newId: ctx.newId });
    const sourced = lines.filter((l) => l.sourceSentenceId).length;
    const order = Math.max(0, ...ctx.existingDialogues.filter((d) => d.videoId === video.id).map((d) => d.orderInVideo)) + 1;
    const label = ctx.dayNumber ? `Day ${ctx.dayNumber}` : '이 영상';
    dialogue = {
      id: dayDialogueId(requestId), createdAt: now, updatedAt: now, kind: 'original', videoId: video.id, sourceVideoIds: [video.id], orderInVideo: order,
      title: pack.title || `${label} 통합 대화문`, situation: pack.situation, lines, expressionIds: usages.map((u) => u.expressionId), generatedBy: 'ai',
      compositionNote: [
        `${label} 원문 문장 ${ordered.length}개 중 ${new Set(lines.map((l) => l.sourceSentenceId).filter(Boolean)).size}개를 그대로 사용`,
        `핵심 Chunk ${usages.filter((u) => u.kind === 'core').map((u) => `${u.text} ×${usedForms.get(u.learningItemId)?.length ?? 0}`).join(', ') || '없음'}`,
        usages.some((u) => u.kind === 'extra') || phrases.length ? `✨ 유용한 회화 표현 ${[...usages.filter((u) => u.kind === 'extra').map((u) => u.text), ...phrases.map((p) => p.base)].join(', ')}` : '',
        pack.extraNotes,
      ].filter(Boolean).join(' · '),
      isFavorite: false, chunkUsages: usages, sourceDays: ctx.dayNumber ? [ctx.dayNumber] : [], aiRequestId: requestId,
      ...(phrases.length ? { phrases } : {}),
      blankPlan: buildBlankPlan(lines, new Set(coreItems.map((c) => c.item.id)), phraseSpansByLine(phrases)),
    };
    return { sentences, expressions, items, dialogue, summary: { sentences: ordered.length, chunks: items.filter((i) => i.kind === 'chunk').length, core: coreItems.length, lines: lines.length, sourcedLines: sourced } };
  }
  return { sentences, expressions, items, dialogue, summary: { sentences: ordered.length, chunks: items.filter((i) => i.kind === 'chunk').length, core: coreItems.length, lines: 0, sourcedLines: 0 } };
}
