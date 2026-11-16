import { parseDayNumber } from '@/db/upgradeV2toV3';
import { AI_DIALOGUE_PROMPT_VERSION, DIALOGUE_LIMITS, type AiDialogueRequest } from '@/types/aiApi';
import type { Dialogue, DialogueChunkUsage, DialogueLine, DialogueSegment, Expression, LearningItem, Video } from '@/types/models';
import type { CombineContext } from '@/repositories/contentStore';

/**
 * 여러 Day의 Chunk를 결합한 통합 대화문
 *
 * - 후보: 학습 항목 중 문장 속 Chunk(kind=chunk)와 핵심 표현(kind=key). 출처(Day·영상)별로 묶는다
 * - 기본 추천: 최근 학습한 Day 2~3개, 그 안에서 '학습함(복습 기록 있음)' 또는 '선택함'인 Chunk만 미리 체크
 * - 생성: 사용자가 체크한 Chunk만 보낸다. 응답에서 실제로 대화에 들어간 Chunk만 '사용한 Chunk'로 기록한다
 *   (목록에 없는 표현이나, 대사에 실제로 없는 표현은 배운 표현으로 표시하지 않음)
 */

export interface ChunkCandidate {
  item: LearningItem;
  expression: Expression;
  /** 원본 문장 */
  sentence: string | null;
  /** 복습 기록이 있음 */
  learned: boolean;
  selected: boolean;
}

export interface CandidateGroup {
  /** day-11 또는 video-<id> */
  key: string;
  label: string;
  dayNumber: number | null;
  videoIds: string[];
  /** 최근 학습 시각 (없으면 null) */
  lastStudiedAt: string | null;
  chunks: ChunkCandidate[];
}

const videoStudiedAt = (v: Video) => (v.status === 'new' ? null : (v.completedAt ?? v.startedAt ?? v.updatedAt ?? null));

export function buildCandidateGroups(ctx: CombineContext): CandidateGroup[] {
  const videoById = new Map(ctx.videos.map((v) => [v.id, v]));
  const exprById = new Map(ctx.expressions.map((e) => [e.id, e]));
  const sentenceById = new Map(ctx.sentences.map((s) => [s.id, s]));
  const dayByVideo = new Map(ctx.days.map((d) => [d.videoId, d.dayNumber]));
  const learned = new Set(ctx.expressionReviews.map((r) => r.itemId));
  const groups = new Map<string, CandidateGroup>();
  // Chunk를 먼저, 같은 묶음 안에서 같은 표현은 하나만
  // 공통 핵심 Chunk → 문장별 Chunk → 핵심 표현 순으로, 같은 묶음 안에서 같은 표현은 하나만
  const rank = (k: string) => (k === 'core' ? 0 : k === 'chunk' ? 1 : 2);
  const items = [...ctx.items].filter((i) => i.kind === 'core' || i.kind === 'chunk' || i.kind === 'key').sort((a, b) => rank(a.kind) - rank(b.kind));
  for (const item of items) {
    const expression = exprById.get(item.expressionId);
    const video = item.videoId ? videoById.get(item.videoId) : undefined;
    if (!expression || !video || video.isSample) continue;
    const day = item.dayNumber ?? dayByVideo.get(video.id) ?? parseDayNumber(video.title);
    const key = day ? `day-${day}` : `video-${video.id}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, label: day ? `Day ${day}` : video.title, dayNumber: day ?? null, videoIds: [], lastStudiedAt: null, chunks: [] };
      groups.set(key, g);
    }
    if (!g.videoIds.includes(video.id)) g.videoIds.push(video.id);
    const at = videoStudiedAt(video);
    if (at && (!g.lastStudiedAt || at > g.lastStudiedAt)) g.lastStudiedAt = at;
    if (g.chunks.some((c) => c.expression.id === expression.id)) continue;
    const sentence = item.sentenceId ? (sentenceById.get(item.sentenceId)?.english ?? item.sourceText) : item.sourceText;
    g.chunks.push({ item, expression, sentence: sentence ?? null, learned: learned.has(expression.id), selected: !!item.selected });
  }
  return [...groups.values()].sort((a, b) => (a.dayNumber ?? 1e6) - (b.dayNumber ?? 1e6) || a.label.localeCompare(b.label));
}

/** 최근 학습한 묶음 2~3개 (학습 기록이 없으면 Chunk를 고른 묶음 → 가장 최근 Day 번호 순) */
export function recommendGroups(groups: CandidateGroup[], max = 3): string[] {
  const score = (g: CandidateGroup) => [g.lastStudiedAt ?? '', g.chunks.some((c) => c.selected || c.learned) ? 1 : 0, g.dayNumber ?? 0] as const;
  return [...groups]
    .filter((g) => g.chunks.length > 0)
    .sort((a, b) => {
      const x = score(a);
      const y = score(b);
      return x[0] !== y[0] ? (x[0] < y[0] ? 1 : -1) : y[1] - x[1] || y[2] - x[2];
    })
    .slice(0, max)
    .map((g) => g.key);
}

/** 미리 체크할 Chunk: 학습함 또는 선택함 */
export function defaultChecked(groups: CandidateGroup[], groupKeys: string[]): string[] {
  return groups.filter((g) => groupKeys.includes(g.key)).flatMap((g) => g.chunks.filter((c) => c.learned || c.selected).map((c) => c.item.id));
}

export function buildDialogueRequest(groups: CandidateGroup[], checkedItemIds: string[], lineCount = 10): AiDialogueRequest | { error: string } {
  const picked: { c: ChunkCandidate; g: CandidateGroup }[] = [];
  for (const g of groups) for (const c of g.chunks) if (checkedItemIds.includes(c.item.id)) picked.push({ c, g });
  if (picked.length < DIALOGUE_LIMITS.minChunks) return { error: `Chunk를 ${DIALOGUE_LIMITS.minChunks}개 이상 골라 주세요.` };
  if (picked.length > DIALOGUE_LIMITS.maxChunks) return { error: `Chunk는 한 번에 ${DIALOGUE_LIMITS.maxChunks}개까지 고를 수 있어요.` };
  return {
    task: 'dialogue',
    chunks: picked.map(({ c, g }) => ({
      ref: c.item.id,
      text: c.expression.text.slice(0, DIALOGUE_LIMITS.textChars),
      meaningKo: (c.expression.meaningKo ?? '').slice(0, DIALOGUE_LIMITS.meaningChars),
      day: g.dayNumber,
      source: (g.dayNumber ? `Day ${g.dayNumber}` : g.label).slice(0, DIALOGUE_LIMITS.sourceChars),
    })),
    lineCount: Math.min(Math.max(lineCount, DIALOGUE_LIMITS.minLines), DIALOGUE_LIMITS.maxLines),
    promptVersion: AI_DIALOGUE_PROMPT_VERSION,
  };
}

// ─────────────────────────────────────────────
// 응답 검사 → 대화문 레코드
// ─────────────────────────────────────────────

const loose = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"');
const txt = (v: unknown, max = 600) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** en 문장에서 phrase가 들어 있는 위치 (대소문자·따옴표 무시) */
function findSpan(en: string, phrase: string): [number, number] | null {
  if (!phrase) return null;
  const i = loose(en).indexOf(loose(phrase));
  return i < 0 ? null : [i, i + phrase.length];
}

/** 한 줄을 Chunk 부분(key)과 나머지(connector)로 나눈다 */
export function segmentLine(en: string, uses: { learningItemId: string; usedAs: string }[]): DialogueSegment[] {
  const spans: { s: number; e: number; id: string }[] = [];
  for (const u of uses) {
    const sp = findSpan(en, u.usedAs);
    if (sp && !spans.some((x) => sp[0] < x.e && x.s < sp[1])) spans.push({ s: sp[0], e: sp[1], id: u.learningItemId });
  }
  spans.sort((a, b) => a.s - b.s);
  const out: DialogueSegment[] = [];
  let pos = 0;
  for (const sp of spans) {
    const before = en.slice(pos, sp.s).trim();
    if (before) out.push({ kind: 'connector', text: before });
    out.push({ kind: 'key', text: en.slice(sp.s, sp.e), learningItemId: sp.id });
    pos = sp.e;
  }
  const rest = en.slice(pos).trim();
  if (rest) out.push({ kind: 'connector', text: rest });
  return out.length ? out : [{ kind: 'connector', text: en }];
}

export type DialogueValidation = { ok: true; dialogue: Dialogue; issues: string[] } | { ok: false; error: string };

export function buildDialogueRecord(text: string, req: AiDialogueRequest, groups: CandidateGroup[], requestId: string, now: string): DialogueValidation {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'JSON 형식이 아니에요.' };
  }
  const sentRefs = new Set(req.chunks.map((c) => c.ref));
  const cand = new Map(groups.flatMap((g) => g.chunks.map((c) => [c.item.id, { c, g }] as const)));
  const issues: string[] = [];
  const rawLines = (Array.isArray(raw.lines) ? (raw.lines as Record<string, unknown>[]) : [])
    .map((l) => ({ speaker: l?.speaker === 'B' ? ('B' as const) : ('A' as const), en: txt(l?.en, 500), ko: txt(l?.ko, 500), refs: (Array.isArray(l?.chunkRefs) ? (l.chunkRefs as unknown[]) : []).filter((x): x is string => typeof x === 'string' && sentRefs.has(x)) }))
    .filter((l) => l.en);
  if (rawLines.length < 2) return { ok: false, error: '대화 줄이 너무 적어요.' };

  const notes = new Map<string, Record<string, unknown>>();
  for (const n of Array.isArray(raw.chunkNotes) ? (raw.chunkNotes as Record<string, unknown>[]) : []) if (typeof n?.ref === 'string' && sentRefs.has(n.ref) && !notes.has(n.ref)) notes.set(n.ref, n);

  // 실제로 대사에 들어 있는 Chunk만 '사용함'으로 (표시 형태 usedAs → 학습 형태 순으로 찾음)
  const usages: DialogueChunkUsage[] = [];
  const usedAsById = new Map<string, string>();
  for (const ref of sentRefs) {
    const found = cand.get(ref);
    if (!found) continue;
    const n = notes.get(ref);
    const forms = [txt(n?.usedAs, 120), found.c.expression.text].filter(Boolean);
    const form = forms.find((f) => rawLines.some((l) => findSpan(l.en, f)));
    if (!form) {
      if (rawLines.some((l) => l.refs.includes(ref)) || n) issues.push(`'${found.c.expression.text}'는 대사에서 찾지 못해 사용한 Chunk로 표시하지 않았어요.`);
      continue;
    }
    usedAsById.set(ref, form);
    const ex = (n?.example ?? {}) as Record<string, unknown>;
    usages.push({
      learningItemId: ref, expressionId: found.c.expression.id, text: found.c.expression.text, usedAs: form, dayNumber: found.g.dayNumber, videoId: found.c.item.videoId,
      meaningInContext: txt(n?.meaningInContext), nuance: txt(n?.nuance), whyUsed: txt(n?.whyUsed), example: { en: txt(ex.en, 300), ko: txt(ex.ko, 300) },
    });
  }
  if (usages.length === 0) return { ok: false, error: '고른 Chunk가 대화에 들어가지 않았어요.' };

  const lines: DialogueLine[] = rawLines.map((l, i) => {
    // 이 줄에 실제로 있는 사용 Chunk만 표시
    const uses = usages.filter((u) => findSpan(l.en, u.usedAs)).map((u) => ({ learningItemId: u.learningItemId, usedAs: u.usedAs }));
    return { id: `line-${requestId}-${i}`, order: i + 1, speaker: l.speaker, segments: segmentLine(l.en, uses), korean: l.ko };
  });
  const sourceDays = [...new Set(usages.map((u) => u.dayNumber).filter((d): d is number => d != null))].sort((a, b) => a - b);
  const sourceVideoIds = [...new Set(usages.map((u) => u.videoId).filter((v): v is string => !!v))];
  const unused = [...sentRefs].filter((r) => !usedAsById.has(r));
  const note = txt(raw.notes, 500);
  const dialogue: Dialogue = {
    id: `dlg-ai-${requestId}`, createdAt: now, updatedAt: now, kind: 'combined', videoId: null, sourceVideoIds, orderInVideo: 0,
    title: txt(raw.title, 100) || '통합 대화문', situation: txt(raw.situation, 800), lines, expressionIds: [...new Set(usages.map((u) => u.expressionId))], generatedBy: 'ai',
    compositionNote: [`${sourceDays.length ? `Day ${sourceDays.join(', ')}` : '일반 영상'}의 Chunk ${usages.length}개로 만든 대화문`, note].filter(Boolean).join(' · '),
    isFavorite: false, chunkUsages: usages, sourceDays, unusedLearningItemIds: unused, aiRequestId: requestId,
  };
  return { ok: true, dialogue, issues };
}
