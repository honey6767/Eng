/**
 * Chunk 찾기 — 사이에 부사 등이 끼어도 같은 Chunk로 본다.
 * 예) parts ["could", "use"] 는 "could use", "could seriously use", "could really use" 모두에 맞는다.
 *
 * 단어 단위로 비교한다(대소문자·곡선 따옴표 무시). 한 part 안의 단어들은 붙어 있어야 하고,
 * part와 part 사이에는 단어가 maxGap개까지 끼어도 된다.
 */

export interface WordTok {
  /** 비교용 (소문자, 따옴표 통일) */
  w: string;
  start: number;
  end: number;
}

const WORD = /[A-Za-z0-9]+(?:['’][A-Za-z]+)*/g;
const norm = (s: string) => s.toLowerCase().replace(/’/g, "'");

export function wordsOf(text: string): WordTok[] {
  const out: WordTok[] = [];
  for (const m of text.matchAll(WORD)) out.push({ w: norm(m[0]), start: m.index!, end: m.index! + m[0].length });
  return out;
}

/** Chunk 텍스트·parts → 비교용 단어 묶음 */
export function partWords(parts: string[]): string[][] {
  return parts.map((p) => wordsOf(p).map((t) => t.w)).filter((p) => p.length > 0);
}

/** "could … use" 처럼 보여 줄 패턴 이름 (parts가 하나면 그대로) */
export function patternLabel(parts: string[]): string {
  return parts.map((p) => p.trim()).filter(Boolean).join(' … ');
}

export interface ChunkMatch {
  /** 원문에서 처음부터 끝까지 (사이 낀 단어 포함) */
  start: number;
  end: number;
  /** part별 위치 — 강조·빈칸은 이 부분만 */
  spans: [number, number][];
  /** 원문 그대로의 형태 (예: "could seriously use") */
  surface: string;
}

function matchAt(toks: WordTok[], at: number, words: string[]): boolean {
  if (at + words.length > toks.length) return false;
  for (let i = 0; i < words.length; i++) if (toks[at + i].w !== words[i]) return false;
  return true;
}

/** 원문에서 모든 맞는 위치 (겹치지 않게, 앞에서부터) */
export function matchAllParts(text: string, parts: string[], maxGap = 2): ChunkMatch[] {
  const pw = partWords(parts);
  if (!pw.length) return [];
  const toks = wordsOf(text);
  const out: ChunkMatch[] = [];
  let from = 0;
  while (from < toks.length) {
    let found: ChunkMatch | null = null;
    for (let i = from; i < toks.length && !found; i++) {
      if (!matchAt(toks, i, pw[0])) continue;
      const spans: [number, number][] = [[toks[i].start, toks[i + pw[0].length - 1].end]];
      let next = i + pw[0].length;
      let ok = true;
      for (const words of pw.slice(1)) {
        let k = next;
        while (k <= next + maxGap && k < toks.length && !matchAt(toks, k, words)) k++;
        if (k > next + maxGap || k >= toks.length) {
          ok = false;
          break;
        }
        spans.push([toks[k].start, toks[k + words.length - 1].end]);
        next = k + words.length;
      }
      if (!ok) continue;
      const start = spans[0][0];
      const end = spans[spans.length - 1][1];
      found = { start, end, spans, surface: text.slice(start, end) };
      from = next;
    }
    if (!found) break;
    out.push(found);
  }
  return out;
}

export function matchParts(text: string, parts: string[], maxGap = 2): ChunkMatch | null {
  return matchAllParts(text, parts, maxGap)[0] ?? null;
}

/** AI가 준 parts가 없거나 이상하면 Chunk 텍스트를 그대로 한 part로 */
export function partsFrom(text: string, parts: unknown): string[] {
  const list = Array.isArray(parts) ? parts.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim()) : [];
  if (list.length) {
    // parts를 이어 붙인 것이 Chunk 텍스트와 같은 단어들이어야 한다 (엉뚱한 parts 방지)
    const joined = partWords(list).flat().join(' ');
    if (joined === wordsOf(text).map((t) => t.w).join(' ')) return list;
  }
  return [text.trim()];
}

/** 보여 줄 이름: 실제로 사이에 단어가 끼는 형태가 있을 때만 "could … use", 아니면 붙은 형태 그대로 */
export function chunkLabel(text: string, parts: string[] | undefined, surfaces: (string | undefined)[]): string {
  if (!parts || parts.length < 2) return text;
  const joined = partWords(parts).flat().join(' ');
  const split = surfaces.some((s) => s && wordsOf(s).map((t) => t.w).join(' ') !== joined);
  return split ? patternLabel(parts) : text;
}
