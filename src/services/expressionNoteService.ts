import type { Repositories } from '@/repositories/types';
import type { ContentOrigin, ExpressionNote, KeySentence, SimilarExpression, Video } from '@/types/models';
import { createId } from '@/utils/id';
import { nowISO } from '@/utils/date';
import { normalizeExpressionKey } from '@/utils/text';

/**
 * 3단계 — 주요(핵심) 표현 노트
 *
 * - 뜻·뉘앙스·사용 상황·예문·비슷한 표현을 저장한다.
 * - 영상에서 확인한 내용(video)과 AI 보충(ai_supplement), 직접 입력(user)을 구분한다.
 * - AI 도움은 유료 API를 쓰지 않는다: 앱이 요청문을 만들어 주면 사용자가 이미 쓰는 AI 채팅에 붙여넣고,
 *   결과(JSON)를 다시 붙여넣어 검사 후 저장한다.
 */

export interface NoteInput {
  expression: string;
  meaningKo: string;
  usageContext: string;
  nuance: string;
  examples: { en: string; ko: string }[];
  similar: SimilarExpression[];
  sourceTimestampSec: number | null;
  origin: ContentOrigin;
  /** 영상에서 확인한 내용인지 — 확인하지 못했다면 needs_check */
  verification: ExpressionNote['verification'];
}

export class NoteError extends Error {}

const cleanExamples = (items: NoteInput['examples']) =>
  items.map((e) => ({ en: e.en.trim(), ko: e.ko.trim() })).filter((e) => e.en);
const cleanSimilar = (items: SimilarExpression[]) =>
  items.map((e) => ({ expression: e.expression.trim(), difference: e.difference.trim() })).filter((e) => e.expression);

/** 노트 저장 (새로 만들기 또는 수정). 표현 레코드는 중복 없이 연결한다. */
export async function saveExpressionNote(repos: Repositories, videoId: string, input: NoteInput, existingId?: string): Promise<ExpressionNote> {
  const video = await repos.videos.get(videoId);
  if (!video) throw new NoteError('영상을 찾을 수 없습니다.');
  const expressionText = input.expression.trim();
  if (!expressionText) throw new NoteError('표현을 입력해 주세요.');
  if (!input.meaningKo.trim()) throw new NoteError('뜻을 입력해 주세요.');

  const expression = await repos.expressions.upsert({
    text: expressionText,
    meaningKo: input.meaningKo.trim(),
    sourceRef: { videoId },
    isSample: video.isSample === true,
  });
  const fields = {
    expressionId: expression.id,
    expression: expressionText,
    meaningKo: input.meaningKo.trim(),
    usageContext: input.usageContext.trim(),
    nuance: input.nuance.trim(),
    examples: cleanExamples(input.examples),
    similar: cleanSimilar(input.similar),
    sourceTimestampSec: input.sourceTimestampSec,
    origin: input.origin,
    // AI 보충은 영상에서 확인한 내용이 아니므로 항상 '확인 필요'
    verification: input.origin === 'ai_supplement' ? ('needs_check' as const) : input.verification,
  };

  if (existingId) {
    const existing = await repos.expressionNotes.get(existingId);
    if (!existing) throw new NoteError('노트를 찾을 수 없습니다.');
    await repos.expressionNotes.update(existingId, fields);
    return { ...existing, ...fields };
  }

  const notes = await repos.expressionNotes.listByVideo(videoId);
  const now = nowISO();
  const note: ExpressionNote = {
    id: createId(),
    createdAt: now,
    updatedAt: now,
    videoId,
    order: notes.reduce((m, n) => Math.max(m, n.order), -1) + 1,
    ...fields,
    ...(video.isSample ? { isSample: true } : {}),
  };
  await repos.expressionNotes.add(note);
  return note;
}

// ─────────────────────────────────────────────
// AI 도움 (무료: 요청문 복사 → 결과 붙여넣기)
// ─────────────────────────────────────────────

/** 핵심 문장 + 연결된 핵심 표현으로 요청문을 만든다 */
export function buildNotesPrompt(
  video: Pick<Video, 'title'>,
  sentences: Pick<KeySentence, 'order' | 'english' | 'korean' | 'situation' | 'expressionIds'>[],
  expressionText: (id: string) => string | undefined,
): string {
  const lines = [...sentences]
    .sort((a, b) => a.order - b.order)
    .map((s) => {
      const exprs = s.expressionIds.map(expressionText).filter(Boolean) as string[];
      return `${s.order}. "${s.english}"${exprs.length ? `  — 핵심 표현: ${exprs.map((e) => `"${e}"`).join(', ')}` : ''}`;
    })
    .join('\n');

  return `당신은 한국인 영어 학습자를 돕는 영어 회화 선생님입니다.
아래는 YouTube 영어 학습 영상 "${video.title}"에서 고른 핵심 문장입니다.

${lines}

[규칙]
- 영어 문장은 영상 원문이므로 절대 바꾸거나 다시 쓰지 마세요.
- 핵심 표현이 적혀 있으면 그 표현을, 없으면 문장에서 가장 중요한 표현 하나를 골라 설명하세요.
- 설명은 한국어로, 예문은 원어민이 일상에서 실제로 쓰는 자연스러운 영어로 써 주세요.
- 아래 JSON 형식으로만 답하세요. 설명 문장이나 다른 글은 붙이지 마세요.

{
  "sentences": [
    { "order": 1, "korean": "문장 번역", "situation": "이 문장을 쓰는 상황" }
  ],
  "notes": [
    {
      "expression": "표현 (예: running behind)",
      "meaningKo": "뜻",
      "nuance": "뉘앙스 (비슷한 말과 느낌 차이)",
      "usageContext": "사용 상황",
      "examples": [{ "en": "예문", "ko": "번역" }],
      "similar": [{ "expression": "비슷한 표현", "difference": "차이" }]
    }
  ]
}`;
}

export interface AiSentenceSuggestion {
  order: number;
  korean: string;
  situation: string;
}

export interface AiNotesResult {
  sentences: AiSentenceSuggestion[];
  notes: NoteInput[];
  /** 저장할 수 없는 항목 설명 */
  problems: string[];
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** AI 답변에서 JSON만 꺼낸다 (```json 코드 블록, 앞뒤 설명 글 허용) */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.search(/[[{]/);
  if (start < 0) throw new NoteError('붙여넣은 내용에서 JSON을 찾지 못했습니다.');
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  if (end <= start) throw new NoteError('JSON 형식이 끝까지 완성되지 않았습니다.');
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new NoteError('JSON 형식이 올바르지 않습니다. AI 답변 전체를 다시 복사해 붙여넣어 주세요.');
  }
}

/** AI 답변 해석 + 검사. 형식이 틀린 항목은 problems에 담고 나머지만 돌려준다. */
export function parseAiNotesResponse(text: string): AiNotesResult {
  const data = extractJson(text);
  const obj = (Array.isArray(data) ? { notes: data } : data) as { sentences?: unknown; notes?: unknown };
  const problems: string[] = [];

  const sentences: AiSentenceSuggestion[] = [];
  if (Array.isArray(obj.sentences)) {
    obj.sentences.forEach((raw, i) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const order = Number(r.order);
      if (!Number.isInteger(order) || order < 1 || order > 5) {
        problems.push(`문장 ${i + 1}: 번호(order)가 1~5가 아닙니다.`);
        return;
      }
      sentences.push({ order, korean: str(r.korean), situation: str(r.situation) });
    });
  }

  const notes: NoteInput[] = [];
  if (Array.isArray(obj.notes)) {
    obj.notes.forEach((raw, i) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const expression = str(r.expression);
      const meaningKo = str(r.meaningKo);
      if (!expression || !meaningKo) {
        problems.push(`표현 ${i + 1}: 표현(expression)과 뜻(meaningKo)이 모두 있어야 합니다.`);
        return;
      }
      const examples = Array.isArray(r.examples)
        ? r.examples.map((e) => ({ en: str((e as Record<string, unknown>)?.en), ko: str((e as Record<string, unknown>)?.ko) })).filter((e) => e.en)
        : [];
      const similar = Array.isArray(r.similar)
        ? r.similar
            .map((e) => ({ expression: str((e as Record<string, unknown>)?.expression), difference: str((e as Record<string, unknown>)?.difference) }))
            .filter((e) => e.expression)
        : [];
      notes.push({
        expression,
        meaningKo,
        nuance: str(r.nuance),
        usageContext: str(r.usageContext),
        examples,
        similar,
        sourceTimestampSec: null,
        origin: 'ai_supplement',
        verification: 'needs_check',
      });
    });
  }

  if (sentences.length === 0 && notes.length === 0 && problems.length === 0) {
    problems.push('저장할 내용(sentences 또는 notes)이 없습니다.');
  }
  return { sentences, notes, problems };
}

export interface ApplyAiResultSummary {
  filledKorean: number;
  filledSituation: number;
  /** 이미 내용이 있어 덮어쓰지 않은 칸 */
  keptExisting: number;
  notesAdded: number;
  /** 같은 표현의 AI 보충 노트가 이미 있어 건너뜀 */
  notesSkipped: number;
}

/**
 * AI 결과 반영
 * - 번역·상황은 비어 있는 칸만 채운다 (사용자가 입력한 내용은 덮어쓰지 않음)
 * - 노트는 'AI 보충 · 확인 필요'로 저장한다. 같은 표현의 AI 보충 노트가 이미 있으면 건너뛴다.
 * - 영어 원문은 건드리지 않는다.
 */
export async function applyAiNotesResult(repos: Repositories, videoId: string, result: AiNotesResult): Promise<ApplyAiResultSummary> {
  const summary: ApplyAiResultSummary = { filledKorean: 0, filledSituation: 0, keptExisting: 0, notesAdded: 0, notesSkipped: 0 };
  const sentences = await repos.keySentences.listByVideo(videoId);
  for (const sug of result.sentences) {
    const s = sentences.find((x) => x.order === sug.order);
    if (!s) continue;
    const patch: { korean?: string; situation?: string } = {};
    if (sug.korean) {
      if (s.korean.trim()) summary.keptExisting++;
      else {
        patch.korean = sug.korean;
        summary.filledKorean++;
      }
    }
    if (sug.situation) {
      if (s.situation.trim()) summary.keptExisting++;
      else {
        patch.situation = sug.situation;
        summary.filledSituation++;
      }
    }
    if (patch.korean || patch.situation) await repos.keySentences.update(s.id, patch);
  }

  const existing = await repos.expressionNotes.listByVideo(videoId);
  const aiKeys = new Set(existing.filter((n) => n.origin === 'ai_supplement').map((n) => normalizeExpressionKey(n.expression)));
  for (const note of result.notes) {
    const key = normalizeExpressionKey(note.expression);
    if (aiKeys.has(key)) {
      summary.notesSkipped++;
      continue;
    }
    await saveExpressionNote(repos, videoId, note);
    aiKeys.add(key);
    summary.notesAdded++;
  }
  return summary;
}
