import type { BlankPlan, Dialogue, MemorizeStep } from '@/types/models';
import { wordsOf } from '@/utils/chunkMatch';
import { buildBlankPlan } from './packService';

/** 단계별 기본 빈칸 양(전체 단어 중 %) — 2단계는 Chunk 전부, 5단계는 영어 전체를 가림 */
export const DEFAULT_BLANK_LEVELS: Record<3 | 4, number> = { 3: 30, 4: 70 };

/** 빈칸 순위를 version 2 기준(1 핵심 Chunk · 2 추가 표현 · 3 주요 단어 · 4 나머지)으로 맞춘다 */
export function normalizedRanks(plan: BlankPlan, lineId: string): number[] {
  const ranks = plan.lines[lineId] ?? [];
  return plan.version === 2 ? ranks : ranks.map((r) => (r === 1 ? 1 : r === 2 ? 3 : 4));
}

/** 저장된 빈칸 자료 (예전 대화문은 핵심 부분을 1순위로 계산) */
export function blankPlanOf(d: Dialogue): BlankPlan {
  if (d.blankPlan) return d.blankPlan;
  // 예전(수동·샘플) 대화문: 핵심 문장 부분을 Chunk처럼 다룬다
  return buildBlankPlan(d.lines.map((l) => ({ ...l, segments: l.segments.map((s) => (s.kind === 'key' ? { ...s, learningItemId: s.learningItemId ?? s.keySentenceId ?? 'key' } : s)) })));
}

/** 같은 대화문은 매번 같은 자리가 빈칸이 되도록 고정된 순서 */
const stable = (lineId: string, i: number) => {
  let h = 2166136261;
  for (const c of `${lineId}:${i}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};

/**
 * 줄의 단어 중 빈칸으로 만들 위치 (ranks는 version 2 기준: 1 핵심 Chunk · 2 추가 덩어리 표현 · 3 주요 단어 · 4 나머지)
 * - 1단계: 없음 / 2단계: 핵심 Chunk 단어 전부
 * - 3단계: 핵심 Chunk + 추가 덩어리 표현 → 주요 단어 순으로 전체의 level%까지 (나머지 단어는 가리지 않음)
 * - 4단계: 핵심 Chunk → 추가 표현 → 주요 단어 → 나머지 순으로 전체의 level%까지
 * - 5단계: 전부
 */
export function blankIndexes(ranks: number[], lineId: string, step: MemorizeStep, level: number): Set<number> {
  const all = ranks.map((r, i) => ({ r, i }));
  if (step === 1) return new Set();
  if (step === 5) return new Set(all.map((x) => x.i));
  const chunk = all.filter((x) => x.r === 1).map((x) => x.i);
  if (step === 2) return new Set(chunk);
  const target = Math.max(chunk.length, Math.round((ranks.length * Math.min(100, Math.max(0, level))) / 100));
  const pool = all
    .filter((x) => x.r !== 1 && (step === 4 || x.r <= 3))
    .sort((a, b) => a.r - b.r || stable(lineId, a.i) - stable(lineId, b.i))
    .map((x) => x.i);
  return new Set([...chunk, ...pool.slice(0, Math.max(0, target - chunk.length))]);
}

/** 화면용: 줄의 영어 문장을 단어·사이 글자로 나눔 */
export function tokensOf(en: string): { text: string; word: boolean; index: number }[] {
  const toks = wordsOf(en);
  const out: { text: string; word: boolean; index: number }[] = [];
  let pos = 0;
  toks.forEach((t, i) => {
    if (t.start > pos) out.push({ text: en.slice(pos, t.start), word: false, index: -1 });
    out.push({ text: en.slice(t.start, t.end), word: true, index: i });
    pos = t.end;
  });
  if (pos < en.length) out.push({ text: en.slice(pos), word: false, index: -1 });
  return out;
}
