import type { Expression, LearningItem } from '@/types/models';
import { matchParts } from '@/utils/chunkMatch';

/**
 * 영상(Day)의 Chunk 분류 — 저장된 기록은 바꾸지 않고 보여 줄 때만 나눈다.
 *
 * - 핵심 Chunk: kind='core' (강사가 가르친 표현)
 * - 추가 덩어리 표현: kind='chunk' 중 chunkRole='extra'(새 기준) 또는, 예전 기준 항목 중 핵심 Chunk의 활용형이 아닌 것
 * - 활용 사례: 예전 기준 항목 중 핵심 Chunk의 활용형(could seriously use, could use some rest 등) → 별도 Chunk로 보이지 않고 핵심 Chunk 아래로
 * - 핵심 Chunk가 아직 없는 영상(예전 기준 자료만 있음)은 분류하지 않고 '문장 속 Chunk'로 둔다
 */

export interface ChunkView {
  cores: LearningItem[];
  extras: LearningItem[];
  /** 핵심 Chunk id → 그 활용형으로 분류된 예전 항목 */
  variantsByCore: Map<string, LearningItem[]>;
  /** 핵심 Chunk가 없어 분류하지 않은 예전 항목 */
  unclassified: LearningItem[];
}

export const partsOfItem = (li: LearningItem, e: Expression | undefined) => li.chunk?.parts ?? (e ? [e.text] : []);

export function classifyChunks(items: LearningItem[], exprById: Map<string, Expression>): ChunkView {
  const cores = items.filter((i) => i.kind === 'core');
  const chunks = items.filter((i) => i.kind === 'chunk');
  const view: ChunkView = { cores, extras: [], variantsByCore: new Map(), unclassified: [] };
  for (const c of chunks) {
    if (c.chunkRole === 'extra') {
      view.extras.push(c);
      continue;
    }
    if (!cores.length) {
      view.unclassified.push(c);
      continue;
    }
    const text = exprById.get(c.expressionId)?.text ?? c.chunk?.surface ?? '';
    const core = cores.find((k) => matchParts(text, partsOfItem(k, exprById.get(k.expressionId))));
    if (core) view.variantsByCore.set(core.id, [...(view.variantsByCore.get(core.id) ?? []), c]);
    else view.extras.push(c);
  }
  return view;
}

/** 핵심 Chunk의 활용형인지 (다른 화면에서 예전 항목을 가릴 때) */
export function isVariantOfCore(item: LearningItem, cores: LearningItem[], exprById: Map<string, Expression>): boolean {
  if (item.kind !== 'chunk' || item.chunkRole === 'extra') return false;
  const text = exprById.get(item.expressionId)?.text ?? item.chunk?.surface ?? '';
  return cores.some((k) => k.videoId === item.videoId && !!matchParts(text, partsOfItem(k, exprById.get(k.expressionId))));
}
