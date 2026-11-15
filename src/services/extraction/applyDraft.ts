import type { DayAssignment, Expression, ExtractionDraft, LearningItem, Transcript, Video } from '@/types/models';
import { normalizeExpressionKey } from '@/utils/text';
import type { ExtractionResult, IssueCode, ValidationIssue } from './validateResult';

/**
 * B1-d — AI 초안을 학습 자료로 연결
 *
 * 품질 판정
 * - 자동 적용: 전사가 있고, 영상의 절반 이상을 덮고, 핵심 표현이 1개 이상 → 사용자 확인 없이 학습 자료로 추가
 *   (공백·끝부분 누락·시간 초과 구간 제거 같은 경고가 있으면 '확인 권장' 표시를 붙여 추가)
 * - 확인 필요: 전사가 비었거나 절반도 덮지 못함, 핵심 표현이 없음 → 'AI 자막 관리'의 확인 필요 목록으로
 *
 * 쓰기 규칙 (기존 데이터 덮어쓰기 없음, 추가만)
 * - 자막: 그 영상에 자막 기록이 하나도 없을 때만 새 기록 추가 (source = ai_transcription)
 * - 표현: 같은 표현(normalizedKey)이 이미 있으면 기존 표현을 그대로 쓰고 고치지 않음, 없을 때만 새로 추가
 * - 영상·표현 연결: 새 테이블 learningItems에 추가 (핵심 표현 = key, 영상 속 Chunk = intro_chunk)
 * - Day: 그 영상에 Day 기록이 없고 AI가 Day 번호를 찾았으면 '제안'으로 추가
 */

export const BLOCKING_ISSUES: IssueCode[] = ['empty_transcript', 'low_coverage'];

export interface DraftAssessment {
  autoApply: boolean;
  blocking: string[];
  warnings: IssueCode[];
}

export function assessDraft(draft: Pick<ExtractionDraft, 'result' | 'validation'>): DraftAssessment {
  const result = draft.result as ExtractionResult | null;
  const issues = (draft.validation ?? []) as ValidationIssue[];
  const blocking: string[] = issues.filter((i) => BLOCKING_ISSUES.includes(i.code)).map((i) => i.code);
  if (!result?.keyExpressions?.length) blocking.push('no_key_expressions');
  const warnings = issues.map((i) => i.code).filter((c) => !BLOCKING_ISSUES.includes(c));
  return { autoApply: blocking.length === 0, blocking, warnings };
}

export interface ApplyContext {
  draft: ExtractionDraft;
  video: Video;
  /** 이 영상에 자막 기록이 이미 있는지 (상태와 무관) */
  hasTranscript: boolean;
  /** normalizedKey → 기존 표현 id */
  expressionIdByKey: Map<string, string>;
  existingLearningItemIds: Set<string>;
  dayAssignment: DayAssignment | null;
  now: string;
  newId: () => string;
  /** 사용자가 뺀 핵심 표현·Chunk 순번 */
  excludeKeyIdx?: number[];
  excludeChunkIdx?: number[];
}

export interface ApplyPlan {
  transcript: Transcript | null;
  expressions: Expression[];
  learningItems: LearningItem[];
  dayAssignment: DayAssignment | null;
  /** 이 초안으로 만들어진(또는 연결된) 레코드 id */
  approvedRefs: string[];
  status: 'approved' | 'partially_approved';
  /** 경고가 있어 '확인 권장'으로 표시했는지 */
  needsReview: boolean;
}

export const aiTranscriptId = (draftId: string) => `tr-ai-${draftId}`;
export const aiLearningItemId = (draftId: string, kind: 'key' | 'intro_chunk', expressionId: string) => `li-ai-${draftId}-${kind}-${expressionId}`;

const fmtTs = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function planApplication(ctx: ApplyContext): ApplyPlan {
  const { draft, video, now } = ctx;
  const result = draft.result as ExtractionResult;
  const assessment = assessDraft(draft);
  const needsReview = assessment.warnings.length > 0 || !assessment.autoApply;
  const refs: string[] = [];

  let transcript: Transcript | null = null;
  if (!ctx.hasTranscript && result.transcript.length) {
    transcript = {
      id: aiTranscriptId(draft.id), createdAt: now, updatedAt: now, videoId: video.id, source: 'ai_transcription', status: 'success',
      rawText: result.transcript.map((s) => `${fmtTs(s.start)} ${s.text}`).join('\n'),
      segments: result.transcript.map((s) => ({ startSec: s.start, endSec: s.end, text: s.text })),
      format: 'timestamped', verification: needsReview ? 'needs_review' : 'ai_unverified', extractionDraftId: draft.id,
    };
    refs.push(transcript.id);
  }

  const expressions: Expression[] = [];
  const byKey = new Map(ctx.expressionIdByKey);
  const items: LearningItem[] = [];
  const ensureExpression = (text: string, meaningKo: string) => {
    const key = normalizeExpressionKey(text);
    if (!key) return null;
    const found = byKey.get(key);
    if (found) return found;
    const e: Expression = { id: ctx.newId(), createdAt: now, updatedAt: now, normalizedKey: key, text: text.trim(), meaningKo, sourceRefs: [{ videoId: video.id }], isFavorite: false, isMarkedDifficult: false, origin: 'ai_extracted' };
    expressions.push(e);
    byKey.set(key, e.id);
    return e.id;
  };
  const day = ctx.dayAssignment?.status === 'confirmed' ? ctx.dayAssignment.dayNumber : null;
  const addItem = (kind: 'key' | 'intro_chunk', expressionId: string, sourceText: string | null, ts: number | null, onScreen: boolean) => {
    const id = aiLearningItemId(draft.id, kind, expressionId);
    if (ctx.existingLearningItemIds.has(id) || items.some((i) => i.id === id)) return;
    items.push({
      id, createdAt: now, updatedAt: now, expressionId, videoId: video.id, sourceType: day ? 'day' : 'other', dayNumber: day, kind, dialogueId: null,
      sourceText, timestampSec: ts, onScreen, origin: 'ai_extracted', status: needsReview ? 'needs_review' : 'confirmed', extractionDraftId: draft.id, legacyKeySentenceId: null,
    });
  };
  const exKey = new Set(ctx.excludeKeyIdx ?? []);
  const exChunk = new Set(ctx.excludeChunkIdx ?? []);
  result.keyExpressions.forEach((k, i) => {
    if (exKey.has(i)) return;
    const id = ensureExpression(k.text, k.meaningKo);
    if (id) addItem('key', id, k.sourceSentence || null, k.timestampSec, k.onScreen);
  });
  (result.introChunks ?? []).forEach((c, i) => {
    if (exChunk.has(i)) return;
    const id = ensureExpression(c.text, c.meaningKo);
    if (id) addItem('intro_chunk', id, null, c.timestampSec, false);
  });
  refs.push(...expressions.map((e) => e.id), ...items.map((i) => i.id));

  let dayAssignment: DayAssignment | null = null;
  if (!ctx.dayAssignment && result.dayNumber && result.dayNumber > 0) {
    dayAssignment = { id: `day-${video.id}`, videoId: video.id, dayNumber: result.dayNumber, status: 'suggested', source: 'ai', createdAt: now, updatedAt: now };
  }
  const partial = exKey.size > 0 || exChunk.size > 0;
  return { transcript, expressions, learningItems: items, dayAssignment, approvedRefs: refs, status: partial ? 'partially_approved' : 'approved', needsReview };
}
