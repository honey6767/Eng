import type { Expression, LearningItem } from '@/types/models';
import { matchParts, wordsOf } from '@/utils/chunkMatch';

/**
 * 영상(Day)의 Chunk 분류 — 저장된 기록은 바꾸지 않고 보여 줄 때만 나눈다 (읽기 전용).
 *
 * - 핵심 Chunk: kind='core' (강사가 가르친 표현, 새 기준 자료)
 * - 추가 덩어리 표현: kind='chunk' 중 chunkRole='extra'(새 기준) 또는, 예전 기준 항목 중 핵심 Chunk의 활용형이 아닌 것
 * - 활용 사례: 예전 기준 항목 중 핵심 Chunk의 활용형(could seriously use, could use some rest 등) → 핵심 Chunk 아래로
 *
 * 예전 기준 자료만 있어 핵심 Chunk 기록이 없는 영상(예: Day 11 — could use some help, could seriously use …)은
 * 화면에서만 핵심 Chunk를 추론한다. 새 레코드를 만들지도, 기존 레코드를 고치지도 않는다.
 *   1) 자막 추출 때 강사 설명에서 찾은 주요 표현(kind='key')이 기존 Chunk의 공통 부분이면 그것을 핵심 Chunk로
 *   2) 그런 기록이 없으면 여러 Chunk에 공통으로 들어 있는 두 단어 패턴(사이 2단어까지)을 핵심 Chunk로 추정
 *   둘 다 없으면 분류하지 않고 '문장 속 Chunk'로 둔다.
 */

export interface CorePattern {
  /** 핵심 Chunk 기록 id, 또는 화면에서만 쓰는 id(inferred:…) */
  id: string;
  /** core = 저장된 핵심 Chunk · key = 강사가 소개한 주요 표현으로 추론 · common = 여러 Chunk의 공통 부분으로 추정 */
  basis: 'core' | 'key' | 'common';
  text: string;
  parts: string[];
  /** core 기록 또는 근거가 된 주요 표현 기록 (common이면 없음) */
  item: LearningItem | null;
  meaningKo: string;
  /** 강의 설명 인용 */
  taught: string | null;
}

export interface ChunkView {
  /** 저장된 핵심 Chunk 기록 */
  cores: LearningItem[];
  /** 핵심 Chunk 기록이 없어 화면에서만 추론한 핵심 Chunk */
  inferred: CorePattern[];
  extras: LearningItem[];
  /** 핵심 Chunk(기록 id 또는 추론 id) → 그 활용형으로 분류된 예전 항목 */
  variantsByCore: Map<string, LearningItem[]>;
  /** 핵심 Chunk를 정할 수 없어 분류하지 않은 예전 항목 */
  unclassified: LearningItem[];
}

export const partsOfItem = (li: LearningItem, e: Expression | undefined) => li.chunk?.parts ?? (e ? [e.text] : []);

const textOf = (li: LearningItem, exprById: Map<string, Expression>) => exprById.get(li.expressionId)?.text ?? li.chunk?.surface ?? '';
const lower = (s: string) => wordsOf(s).map((t) => t.w).join(' ');

/** 강사 표현을 패턴으로: 2~3단어면 단어마다 나눠 사이에 부사 등이 끼어도 맞게 (could use → could … use) */
export function patternParts(text: string): string[] {
  const ws = wordsOf(text).map((t) => t.w);
  return ws.length >= 2 && ws.length <= 3 ? ws : [text.trim()];
}

const STOP = new Set(
  'a an the of to in on at for from with by as and or but so if is am are was were be been being it its this that these those i me my you your he him his she her we us our they them their some any not no do does did have has had will would can just very really'.split(' '),
);

/** 여러 Chunk에 공통으로 들어 있는 두 단어 패턴 (둘 다 의미 있는 단어, 사이 2단어까지) */
export function commonPattern(texts: string[]): string[] | null {
  const uniq = [...new Set(texts.map(lower).filter(Boolean))];
  if (uniq.length < 2) return null;
  const seen = new Set<string>();
  let best: { parts: string[]; count: number } | null = null;
  for (const t of uniq) {
    const ws = t.split(' ');
    for (let i = 0; i < ws.length; i++)
      for (let j = i + 1; j <= Math.min(i + 3, ws.length - 1); j++) {
        if (STOP.has(ws[i]) || STOP.has(ws[j]) || ws[i] === ws[j]) continue;
        const k = `${ws[i]} ${ws[j]}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const count = uniq.filter((u) => matchParts(u, [ws[i], ws[j]])).length;
        if (!best || count > best.count) best = { parts: [ws[i], ws[j]], count };
      }
  }
  if (!best) return null;
  // 우연히 겹친 것은 제외: 3개 이상, 또는 2개이면서 절반 이상
  return best.count >= 3 || (best.count >= 2 && best.count * 2 >= uniq.length) ? best.parts : null;
}

/** 핵심 Chunk 패턴 — 저장된 핵심 Chunk가 있으면 그것만, 없으면 예전 Chunk에서 추론 (한 영상 단위) */
export function corePatterns(items: LearningItem[], exprById: Map<string, Expression>): CorePattern[] {
  const cores = items.filter((i) => i.kind === 'core');
  if (cores.length)
    return cores.map((c) => {
      const e = exprById.get(c.expressionId);
      return { id: c.id, basis: 'core', text: e?.text ?? c.chunk?.surface ?? '', parts: partsOfItem(c, e), item: c, meaningKo: c.chunk?.meaningInSentence || e?.meaningKo || '', taught: c.chunk?.taught ?? null };
    });
  const legacy = items.filter((i) => i.kind === 'chunk' && i.chunkRole !== 'extra');
  if (!legacy.length) return [];
  const videoKey = items[0]?.videoId ?? 'video';
  const out: CorePattern[] = [];
  for (const k of items.filter((i) => i.kind === 'key')) {
    const e = exprById.get(k.expressionId);
    if (!e || out.some((p) => lower(p.text) === lower(e.text))) continue;
    const parts = patternParts(e.text);
    if (!legacy.some((c) => matchParts(textOf(c, exprById), parts))) continue;
    out.push({ id: `inferred:${videoKey}:${lower(e.text)}`, basis: 'key', text: e.text, parts, item: k, meaningKo: e.meaningKo ?? '', taught: k.sourceText ?? null });
  }
  if (out.length) return out;
  const parts = commonPattern(legacy.map((c) => textOf(c, exprById)));
  if (!parts) return [];
  const text = parts.join(' ');
  const same = [...exprById.values()].find((e) => lower(e.text) === text);
  return [{ id: `inferred:${videoKey}:${text}`, basis: 'common', text, parts, item: null, meaningKo: same?.meaningKo ?? '', taught: null }];
}

export function classifyChunks(items: LearningItem[], exprById: Map<string, Expression>): ChunkView {
  const cores = items.filter((i) => i.kind === 'core');
  const patterns = corePatterns(items, exprById);
  const view: ChunkView = { cores, inferred: patterns.filter((p) => p.basis !== 'core'), extras: [], variantsByCore: new Map(), unclassified: [] };
  for (const c of items.filter((i) => i.kind === 'chunk')) {
    if (c.chunkRole === 'extra') {
      view.extras.push(c);
      continue;
    }
    if (!patterns.length) {
      view.unclassified.push(c);
      continue;
    }
    const text = textOf(c, exprById);
    const p = patterns.find((k) => matchParts(text, k.parts));
    if (p) view.variantsByCore.set(p.id, [...(view.variantsByCore.get(p.id) ?? []), c]);
    else view.extras.push(c);
  }
  return view;
}

/**
 * 여러 영상의 항목을 영상별로 분류 (통합 대화문 후보용).
 * 반환: 항목 id → 역할. variantOf는 활용형이 묶일 핵심 Chunk 패턴.
 */
export function rolesByItem(items: LearningItem[], exprById: Map<string, Expression>): Map<string, { role: 'core' | 'extra' | 'chunk'; variantOf?: CorePattern }> {
  const byVideo = new Map<string, LearningItem[]>();
  for (const i of items) byVideo.set(i.videoId ?? '', [...(byVideo.get(i.videoId ?? '') ?? []), i]);
  const out = new Map<string, { role: 'core' | 'extra' | 'chunk'; variantOf?: CorePattern }>();
  for (const list of byVideo.values()) {
    const view = classifyChunks(list, exprById);
    const all = [...corePatterns(list, exprById)];
    for (const c of view.cores) out.set(c.id, { role: 'core' });
    for (const c of view.extras) out.set(c.id, { role: 'extra' });
    for (const c of view.unclassified) out.set(c.id, { role: 'chunk' });
    for (const [pid, vs] of view.variantsByCore) for (const v of vs) out.set(v.id, { role: 'core', variantOf: all.find((p) => p.id === pid) });
  }
  return out;
}
