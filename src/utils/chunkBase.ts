import { matchParts, partsFrom, wordsOf, type ChunkMatch } from './chunkMatch';

/**
 * 추가 덩어리 표현의 기본형 — 원문 형태와 학습용 기본 Chunk를 나눈다.
 *
 * - 원문에 정도만 강조하는 말(super, really, so …)이 끼어 있으면 뺀 형태를 기본 Chunk로 (look super tired → look tired)
 * - 뜻이 달라지는 말(not, never, too, only …)은 절대 빼지 않는다 (too tired ≠ tired)
 * - 저장된 원문 문장·표현은 바꾸지 않는다. 예전 자료는 보여 줄 때만 기본형을 계산한다.
 */

/** 정도만 강조하는 말 — 빼도 핵심 뜻이 그대로 */
const DEGREE = new Set(['super', 'really', 'so', 'very', 'pretty', 'quite', 'totally', 'extremely', 'incredibly', 'absolutely', 'awfully', 'terribly', 'real', 'truly', 'seriously']);
/** 빼면 뜻이 달라지는 말 */
const NEVER_DROP = new Set(['not', 'never', 'no', 'hardly', 'barely', 'too', 'only', 'almost', 'nearly', 'less', 'least', 'more', 'most', 'even', 'still']);

const ws = (s: string) => wordsOf(s).map((t) => t.w);

/** surface에서 base가 되면서 빠진 단어 (base 단어가 surface에 순서대로 없으면 null) */
export function droppedWords(surface: string, base: string): string[] | null {
  const s = ws(surface);
  const b = ws(base);
  const out: string[] = [];
  let j = 0;
  for (const w of s) {
    if (j < b.length && w === b[j]) j++;
    else out.push(w);
  }
  return j === b.length ? out : null;
}

/** 원문 → 기본형으로 줄여도 되는지: 빠진 말이 뜻을 바꾸지 않아야 하고, 기본형은 두 단어 이상 */
export function isSafeBase(surface: string, base: string): boolean {
  const d = droppedWords(surface, base);
  if (!d) return false;
  if (!d.length) return true;
  if (ws(base).length < 2) return false;
  return d.every((w) => !NEVER_DROP.has(w) && !w.endsWith("n't"));
}

/** 예전 자료용: 사이에 낀 강조 부사만 뺀 기본형 (맨 앞·맨 뒤 단어는 그대로, 뺄 것이 없으면 null) */
export function deriveBase(text: string): { base: string; parts: string[]; dropped: string[] } | null {
  const toks = wordsOf(text);
  if (toks.length < 3) return null;
  const keep = toks.filter((t, i) => !(i > 0 && i < toks.length - 1 && DEGREE.has(t.w)));
  if (keep.length === toks.length || keep.length < 2) return null;
  const base = keep.map((t) => text.slice(t.start, t.end)).join(' ');
  if (!isSafeBase(text, base)) return null;
  return { base, parts: keep.map((t) => text.slice(t.start, t.end)), dropped: droppedWords(text, base) ?? [] };
}

/** 연결동사 + 형용사 틀 (예전 자료용, 강조 부사가 형용사 앞에 있었을 때만) */
const LINKING: Record<string, { forms: string[]; swaps: string[] }> = {
  look: { forms: ['look', 'looks', 'looked', 'looking'], swaps: ['look happy', 'look familiar', 'look busy', 'look great'] },
  feel: { forms: ['feel', 'feels', 'felt', 'feeling'], swaps: ['feel better', 'feel sick', 'feel tired', 'feel great'] },
  seem: { forms: ['seem', 'seems', 'seemed', 'seeming'], swaps: ['seem busy', 'seem nice', 'seem tired', 'seem happy'] },
  sound: { forms: ['sound', 'sounds', 'sounded', 'sounding'], swaps: ['sound good', 'sound great', 'sound familiar', 'sound tired'] },
};

export function derivePattern(base: string, dropped: string[]): { pattern: string; swaps: string[] } | null {
  const b = ws(base);
  if (b.length !== 2 || !dropped.length) return null;
  const lemma = Object.keys(LINKING).find((k) => LINKING[k].forms.includes(b[0]));
  if (!lemma) return null;
  const self = `${lemma} ${b[1]}`;
  return { pattern: `${lemma} + 형용사`, swaps: LINKING[lemma].swaps.filter((s) => s !== self).slice(0, 3) };
}

/** AI가 준 바꿔 쓰기 틀·활용 예 */
export function parsePatternFields(c: Record<string, unknown>, base: string): { pattern: string; swaps: string[] } | null {
  if (typeof c.pattern !== 'string' && !Array.isArray(c.swaps)) return null;
  const pattern = typeof c.pattern === 'string' ? c.pattern.trim().slice(0, 60) : '';
  const key = ws(base).join(' ');
  const swaps = [...new Set((Array.isArray(c.swaps) ? c.swaps : []).filter((s): s is string => typeof s === 'string').map((s) => s.trim().slice(0, 60)).filter((s) => s && ws(s).join(' ') !== key))].slice(0, 4);
  return { pattern, swaps };
}

/**
 * 원문 문장에서 Chunk 찾기 — 붙어 있으면 그대로, 아니면 parts(사이 단어 허용).
 * AI가 parts를 나누지 않았어도 2~4단어 기본형이면 단어마다 나눠 다시 찾는다 (look tired → look super tired).
 */
export function locateChunk(sentence: string, text: string, rawParts: unknown): { parts: string[]; m: ChunkMatch } | null {
  let parts = partsFrom(text, rawParts);
  let m = matchParts(sentence, parts);
  if (!m) {
    const words = text.trim().split(/\s+/);
    if (words.length >= 2 && words.length <= 4) {
      parts = words;
      m = matchParts(sentence, parts);
    }
  }
  return m ? { parts, m } : null;
}
