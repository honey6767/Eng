import { parseDayNumber } from '@/db/upgradeV2toV3';
import { AI_CONTENT_PROMPT_VERSION, CONTENT_LIMITS, type AiContentRequest, type SeriesKind } from '@/types/aiApi';
import type { ChunkDetail, DayAssignment, Expression, KeySentence, LearningItem, Transcript, Video } from '@/types/models';
import { normalizeExpressionKey } from '@/utils/text';
import { partsFrom } from '@/utils/chunkMatch';
import { isSafeBase, locateChunk, parsePatternFields } from '@/utils/chunkBase';

/**
 * AI 학습 콘텐츠 — 저장된 자막에서 ① 원문 문장 ② 문장 속 Chunk 를 만든다.
 *
 * - Day 시리즈: 영상에 나온 번호와 원문 문장을 그대로 보존 (개수는 영상에 있는 만큼)
 * - 일반 영상: 전체 맥락에서 일상회화에 유용한 문장·Chunk를 선별
 * - 문장과 Chunk는 따로 저장·학습한다 (Chunk는 원본 문장·영상·Day와 연결)
 * - 쓰기는 추가만: 기존 핵심 문장·표현·학습 기록은 바꾸지 않는다
 */

export interface ContentChunk extends ChunkDetail {
  text: string;
  meaningKo: string;
}

export interface ContentSentence {
  number: number;
  text: string;
  meaningKo: string;
  timestampSec: number | null;
  chunks: ContentChunk[];
}

export interface ContentResult {
  sentences: ContentSentence[];
  notes: string;
}

/** Day 시리즈인지: Day 정리에서 정한 번호 → 제목의 Day 번호 순으로 본다 */
export function seriesOf(video: Video, day: DayAssignment | undefined): { seriesKind: SeriesKind; dayNumber: number | null } {
  const n = day?.dayNumber ?? parseDayNumber(video.title);
  return n ? { seriesKind: 'day', dayNumber: n } : { seriesKind: 'general', dayNumber: null };
}

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** 자막을 "MM:SS 문장" 줄로 (너무 길면 뒤를 자른다) */
export function transcriptText(t: Transcript): string {
  const text = t.segments.length ? t.segments.map((s) => (s.startSec != null ? `${mmss(s.startSec)} ${s.text}` : s.text)).join('\n') : t.rawText;
  return text.length > CONTENT_LIMITS.transcriptChars ? text.slice(0, CONTENT_LIMITS.transcriptChars) : text;
}

export function buildContentRequest(video: Video, transcript: Transcript, day: DayAssignment | undefined): AiContentRequest {
  const s = seriesOf(video, day);
  return {
    task: 'content',
    videoId: video.youtubeVideoId!,
    title: video.title.slice(0, CONTENT_LIMITS.titleChars),
    seriesKind: s.seriesKind,
    dayNumber: s.dayNumber,
    transcript: transcriptText(transcript),
    promptVersion: AI_CONTENT_PROMPT_VERSION,
  };
}

// ─────────────────────────────────────────────
// 응답 검사
// ─────────────────────────────────────────────

/** 비교용: 대소문자·따옴표·공백 차이 무시 */
const loose = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const txt = (v: unknown, max = 600) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export type ContentValidation = { ok: true; result: ContentResult; issues: string[] } | { ok: false; error: string };

export function validateContent(text: string, durationSec: number | null): ContentValidation {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'JSON 형식이 아니에요.' };
  }
  const r = raw as { sentences?: unknown; notes?: unknown };
  if (!Array.isArray(r?.sentences)) return { ok: false, error: '문장 목록이 없어요.' };
  const issues: string[] = [];
  const seen = new Set<string>();
  const sentences: ContentSentence[] = [];
  for (const s of r.sentences as Record<string, unknown>[]) {
    const en = txt(s?.text, 500);
    if (!en || !/[A-Za-z]/.test(en)) continue;
    const key = normalizeExpressionKey(en);
    if (seen.has(key)) {
      issues.push(`같은 문장이 두 번 나와 하나만 남겼어요: ${en}`);
      continue;
    }
    seen.add(key);
    const number = typeof s.number === 'number' && Number.isInteger(s.number) && s.number > 0 ? s.number : sentences.length + 1;
    let ts = typeof s.timestampSec === 'number' && Number.isFinite(s.timestampSec) && s.timestampSec >= 0 ? s.timestampSec : null;
    if (ts !== null && durationSec && ts > durationSec) {
      issues.push(`문장 ${number}의 시각이 영상 길이를 넘어 비워 뒀어요.`);
      ts = null;
    }
    const chunks: ContentChunk[] = [];
    const chunkSeen = new Set<string>();
    for (const c of Array.isArray(s.chunks) ? (s.chunks as Record<string, unknown>[]) : []) {
      let ct = txt(c?.text, 120);
      if (!ct) continue;
      let lk = loose(ct);
      // 붙어 있는 형태 → 그대로, 아니면 parts로 떨어진 형태(could … use, look … tired) 확인
      const found = loose(en).includes(lk) ? null : locateChunk(en, ct, c.parts);
      if (!loose(en).includes(lk) && !found) {
        issues.push(`문장 ${number}: '${ct}'는 문장에 없어서 뺐어요.`);
        continue;
      }
      let parts = found?.parts ?? partsFrom(ct, c.parts);
      let m = found?.m ?? null;
      // 기본형으로 줄이면서 뜻이 바뀌는 말(not, too …)을 뺐다면 원문 형태 그대로 둔다
      if (m && !isSafeBase(m.surface, ct)) {
        issues.push(`문장 ${number}: '${ct}'로 줄이면 뜻이 달라져 원문 형태 '${m.surface}'로 뒀어요.`);
        ct = m.surface;
        lk = loose(ct);
        parts = [ct];
        m = null;
      }
      const pat = parsePatternFields(c, ct);
      if (normalizeExpressionKey(ct) === key || lk.split(' ').length > 10) continue; // 문장 전체는 Chunk가 아님
      if (chunkSeen.has(lk)) continue;
      chunkSeen.add(lk);
      const examples = (Array.isArray(c.examples) ? (c.examples as Record<string, unknown>[]) : [])
        .map((e) => ({ en: txt(e?.en, 300), ko: txt(e?.ko, 300) }))
        .filter((e) => e.en)
        .slice(0, 3);
      chunks.push({
        text: ct,
        meaningKo: txt(c.meaningKo, 200),
        meaningInSentence: txt(c.meaningInSentence),
        nuance: txt(c.nuance),
        usage: txt(c.usage),
        comparison: txt(c.comparison),
        examples,
        ...(m && parts.length > 1 ? { parts } : {}),
        ...(m ? { surface: m.surface } : {}),
        ...(pat ? { pattern: pat.pattern, swaps: pat.swaps } : {}),
      });
    }
    sentences.push({ number, text: en, meaningKo: txt(s.meaningKo, 500), timestampSec: ts, chunks });
  }
  if (sentences.length === 0) return { ok: false, error: '학습할 문장을 찾지 못했어요.' };
  return { ok: true, result: { sentences, notes: txt(r.notes, 1000) }, issues };
}

// ─────────────────────────────────────────────
// 저장 계획 (추가만)
// ─────────────────────────────────────────────

export interface ContentContext {
  video: Video;
  dayNumber: number | null;
  result: ContentResult;
  requestId: string;
  /** 이 영상의 기존 핵심 문장 (그대로 둔다) */
  existingSentences: KeySentence[];
  /** 이 영상의 기존 학습 항목 */
  existingItems: LearningItem[];
  /** normalizedKey → 표현 id */
  expressionIdByKey: Map<string, string>;
  now: string;
  newId: () => string;
  /** 새로 만드는 문장별 Chunk를 '추가 덩어리 표현'으로 표시 (학습 자료 생성) */
  chunkRole?: 'extra';
}

export interface ContentPlan {
  sentences: KeySentence[];
  expressions: Expression[];
  items: LearningItem[];
  /** 기존 핵심 문장과 같아서 새로 만들지 않고 연결만 한 문장 수 */
  reusedSentences: number;
  /** 같은 영상에 이미 있는 Chunk라 다시 만들지 않은 수 */
  skippedChunks: number;
  /** 영상 번호 → 핵심 문장 id (새로 만든 것과 기존 문장에 연결한 것 모두) */
  sentenceIdByNumber: Map<number, string>;
  /** 새로 만든 표현까지 포함한 normalizedKey → 표현 id */
  expressionIdByKey: Map<string, string>;
}

export const contentSentenceId = (requestId: string, number: number, i: number) => `ks-ai-${requestId}-${number}-${i}`;
export const contentChunkId = (requestId: string, expressionId: string) => `li-chunk-${requestId}-${expressionId}`;

/** 이미 이 영상에 AI 문장·Chunk가 저장돼 있으면 true (다시 만들지 않음) */
export function hasContent(sentences: KeySentence[], items: LearningItem[]): boolean {
  return sentences.some((s) => s.origin === 'ai_extracted') || items.some((i) => i.kind === 'chunk');
}

export function planContent(ctx: ContentContext): ContentPlan {
  const { video, result, requestId, now } = ctx;
  const sourceType = ctx.dayNumber ? 'day' : 'other';
  const usedOrders = new Set(ctx.existingSentences.map((s) => s.order));
  let nextOrder = Math.max(0, ...usedOrders);
  const byText = new Map(ctx.existingSentences.map((s) => [normalizeExpressionKey(s.english), s]));
  const byKey = new Map(ctx.expressionIdByKey);
  const chunkExpr = new Set(ctx.existingItems.filter((i) => i.kind === 'chunk').map((i) => i.expressionId));

  const sentences: KeySentence[] = [];
  const expressions: Expression[] = [];
  const items: LearningItem[] = [];
  let reused = 0;
  let skipped = 0;
  const sentenceIdByNumber = new Map<number, string>();

  result.sentences.forEach((s, i) => {
    let sentenceId: string;
    const same = byText.get(normalizeExpressionKey(s.text));
    const exprIds: string[] = [];
    // Chunk → 표현 (같은 표현은 다시 만들지 않고 연결)
    const chunkRows: { exprId: string; c: ContentChunk }[] = [];
    for (const c of s.chunks) {
      const key = normalizeExpressionKey(c.text);
      if (!key) continue;
      let exprId = byKey.get(key);
      if (!exprId) {
        exprId = ctx.newId();
        expressions.push({ id: exprId, createdAt: now, updatedAt: now, normalizedKey: key, text: c.text.trim(), meaningKo: c.meaningKo, sourceRefs: [{ videoId: video.id }], isFavorite: false, isMarkedDifficult: false, origin: 'ai_extracted' });
        byKey.set(key, exprId);
      }
      exprIds.push(exprId);
      chunkRows.push({ exprId, c });
    }
    if (same) {
      sentenceId = same.id;
      reused++;
    } else {
      // 영상 번호를 그대로 정렬 순서로 쓰되, 기존 문장과 겹치면 뒤로 (백업 복원 시 같은 영상·같은 순서 충돌 방지)
      let order = s.number;
      if (usedOrders.has(order)) order = ++nextOrder;
      usedOrders.add(order);
      nextOrder = Math.max(nextOrder, order);
      sentenceId = contentSentenceId(requestId, s.number, i);
      sentences.push({
        id: sentenceId, createdAt: now, updatedAt: now, videoId: video.id, order, english: s.text, korean: s.meaningKo, expressionIds: [...new Set(exprIds)],
        situation: '', timestampSec: s.timestampSec, status: 'not_started', correctCount: 0, wrongCount: 0, origin: 'ai_extracted', aiNumber: s.number,
        selected: false, contentRequestId: requestId,
      });
    }
    if (!sentenceIdByNumber.has(s.number)) sentenceIdByNumber.set(s.number, sentenceId);
    for (const { exprId, c } of chunkRows) {
      // 같은 영상·같은 표현의 Chunk는 하나만 (처음 나온 문장에 연결)
      if (chunkExpr.has(exprId)) {
        skipped++;
        continue;
      }
      chunkExpr.add(exprId);
      items.push({
        id: contentChunkId(requestId, exprId), createdAt: now, updatedAt: now, expressionId: exprId, videoId: video.id, sourceType, dayNumber: ctx.dayNumber,
        kind: 'chunk', dialogueId: null, sourceText: s.text, timestampSec: s.timestampSec, onScreen: false, origin: 'ai_extracted', status: 'confirmed',
        extractionDraftId: null, legacyKeySentenceId: null, sentenceId,
        chunk: { meaningInSentence: c.meaningInSentence, nuance: c.nuance, usage: c.usage, comparison: c.comparison, examples: c.examples, ...(c.parts ? { parts: c.parts } : {}), ...(c.surface ? { surface: c.surface } : {}), ...(c.pattern !== undefined ? { pattern: c.pattern, swaps: c.swaps ?? [] } : {}) },
        selected: false, contentRequestId: requestId,
        ...(ctx.chunkRole ? { chunkRole: ctx.chunkRole } : {}),
      });
    }
  });
  return { sentences, expressions, items, reusedSentences: reused, skippedChunks: skipped, sentenceIdByNumber, expressionIdByKey: byKey };
}
