import type { Dialogue, DialogueLine, UsefulPhrase } from '@/types/models';
import { matchAllParts, wordsOf } from '@/utils/chunkMatch';
import { checkPattern, fitPattern, parsePattern, templatePattern, type PatternInfo } from '@/utils/chunkPattern';

/**
 * ✨ 유용한 회화 표현 — 핵심 Chunk와 별도로, 대화문에서 통째로 외우면 좋은 표현
 *
 * 화면에서는 한 분류로 보여 주지만 출처를 구분한다.
 *  - sentence: 원문 문장에서 찾은 추가 표현 (기존 학습 항목·대화문의 chunkUsages kind='extra' 그대로)
 *  - dialogue: 대화문 자체에서 찾은 표현 (새 대화문의 phrases, 또는 기존 대화문을 사용자가 분석한 결과)
 *
 * 선별: 대화문에 실제로 있어야 하고, 핵심 Chunk와 겹치지 않고, 두 단어 이상.
 * 상한: 대화문당 최대 6개(원문 출처 포함), 줄 수의 40%까지, 한 줄에 1개.
 */

export const MAX_USEFUL = 6;
const CATEGORIES = new Set(['phrasal', 'idiom', 'reaction', 'pattern', 'chunk']);
const PLACEHOLDER = /^(someone|something|somebody|sb|sth|~)$/i;

export const lineText = (l: DialogueLine) => l.segments.map((s) => s.text).join(' ');

export interface Span {
  s: number;
  e: number;
}
const overlaps = (a: Span, b: Span) => a.s < b.e && b.s < a.e;

/** 줄마다 핵심 Chunk·원문 출처 추가 표현의 위치 (세그먼트 기준) */
export function chunkSpans(lines: DialogueLine[], extraIds: Set<string>): Map<string, { core: Span[]; extra: (Span & { ref: string })[] }> {
  const out = new Map<string, { core: Span[]; extra: (Span & { ref: string })[] }>();
  for (const l of lines) {
    const v = { core: [] as Span[], extra: [] as (Span & { ref: string })[] };
    let pos = 0;
    l.segments.forEach((seg, i) => {
      if (i > 0) pos += 1;
      if (seg.kind === 'key') {
        const sp = { s: pos, e: pos + seg.text.length };
        if (seg.learningItemId && extraIds.has(seg.learningItemId)) v.extra.push({ ...sp, ref: seg.learningItemId });
        else v.core.push(sp);
      }
      pos += seg.text.length;
    });
    out.set(l.id, v);
  }
  return out;
}

/** 표현이 줄에서 나오는 모든 위치 (실제 형태 → 기본형, 구동사는 사이 단어 허용) */
export function findForms(text: string, forms: string[], base: string): Span[] {
  const found: Span[] = [];
  const add = (sp: Span) => {
    if (!found.some((x) => overlaps(x, sp))) found.push(sp);
  };
  const lower = text.toLowerCase().replace(/’/g, "'");
  for (const f of forms) {
    const needle = f.trim().toLowerCase().replace(/’/g, "'");
    if (needle.length < 2) continue;
    let i = lower.indexOf(needle);
    while (i >= 0) {
      const before = i === 0 || !/[a-z0-9']/.test(lower[i - 1]);
      const after = i + needle.length >= lower.length || !/[a-z0-9']/.test(lower[i + needle.length]);
      if (before && after) add({ s: i, e: i + needle.length });
      i = lower.indexOf(needle, i + 1);
    }
  }
  if (!found.length) {
    // 기본형의 someone/something 자리를 빼고 사이 단어를 허용해 찾기 (take someone up on something → take … up on)
    const parts: string[] = [];
    let cur: string[] = [];
    for (const w of base.split(/\s+/)) {
      if (PLACEHOLDER.test(w)) {
        if (cur.length) parts.push(cur.join(' '));
        cur = [];
      } else cur.push(w);
    }
    if (cur.length) parts.push(cur.join(' '));
    // 자리 표시어가 없는 2~3단어 구동사는 단어마다 나눠 사이 단어 허용 (figure out → figure it out)
    const search = parts.length === 1 && parts[0].split(' ').length >= 2 && parts[0].split(' ').length <= 3 ? parts[0].split(' ') : parts;
    if (search.length) for (const m of matchAllParts(text, search)) add({ s: m.start, e: m.end });
  }
  return found.sort((a, b) => a.s - b.s);
}

const str = (v: unknown, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * AI 결과 검사 → 저장할 ✨ 표현 (대화문 자체 출처).
 * @param coreTexts 핵심 Chunk 기본형 (같거나 포함하면 제외)
 * @param reserved 이미 ✨(원문 출처)·핵심 Chunk가 있는 위치 — 겹치면 제외, 원문 출처가 있는 줄은 이미 1개로 셈
 */
export function validateUsefulPhrases(
  raw: unknown,
  lines: DialogueLine[],
  opts: { coreTexts: string[]; extraIds: Set<string>; newId: () => string },
): UsefulPhrase[] {
  const spans = chunkSpans(lines, opts.extraIds);
  const extraLines = new Set([...spans.entries()].filter(([, v]) => v.extra.length).map(([k]) => k));
  const existing = new Set([...spans.values()].flatMap((v) => v.extra.map((x) => x.ref))).size;
  const cap = Math.max(0, Math.min(MAX_USEFUL, Math.ceil(lines.length * 0.4)) - existing);
  const core = opts.coreTexts.map((t) => wordsOf(t).map((x) => x.w).join(' ')).filter(Boolean);
  const claimed = new Set(extraLines);
  const seen = new Set<string>();
  const out: UsefulPhrase[] = [];
  for (const p of Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []) {
    if (out.length >= cap) break;
    const base = str(p?.base, 120);
    const key = wordsOf(base).map((x) => x.w).join(' ');
    const realWords = base.split(/\s+/).filter((w) => !PLACEHOLDER.test(w));
    if (!base || seen.has(key) || realWords.length < 2) continue;
    // 핵심 Chunk와 같거나 그 활용형이면 제외 (핵심 Chunk로 승격하지 않음)
    if (core.some((c) => key.includes(c) || c.includes(key))) continue;
    const forms = (Array.isArray(p.usedAs) ? p.usedAs : []).map((x) => str(x, 120)).filter(Boolean);
    const occurrences: UsefulPhrase['occurrences'] = [];
    for (const l of lines) {
      const text = lineText(l);
      const reserved = [...(spans.get(l.id)?.core ?? []), ...(spans.get(l.id)?.extra ?? [])];
      for (const sp of findForms(text, forms, base)) {
        if (reserved.some((r) => overlaps(r, sp))) continue;
        const usedAs = text.slice(sp.s, sp.e);
        if (core.some((c) => wordsOf(usedAs).map((x) => x.w).join(' ').includes(c))) continue;
        occurrences.push({ lineId: l.id, usedAs, start: sp.s, end: sp.e });
      }
    }
    // 한 줄에 1개: 아직 ✨가 없는 줄에 나오는 표현만
    const free = occurrences.filter((o) => !claimed.has(o.lineId));
    if (!free.length) continue;
    seen.add(key);
    free.forEach((o) => claimed.add(o.lineId));
    // 교체 패턴 검사: 기본형 → 실제 형태 → 대화문 속 문장(뒤 1~3단어 포함, 예: I'm so ready for the weekend)
    const first = free[0];
    const firstLine = lines.find((l) => l.id === first.lineId);
    const rest = firstLine ? wordsOf(lineText(firstLine).slice(first.start)).map((t) => t.w) : [];
    const n = wordsOf(first.usedAs).length;
    const candidates = [base, ...forms, ...[1, 2, 3].map((k) => rest.slice(0, n + k).join(' '))];
    let pat = null as ReturnType<typeof checkPattern>;
    for (const c of candidates) if (!pat && c) pat = checkPattern(c, p.pattern, p.slotNote, p.swapExamples);
    out.push({
      id: opts.newId(), source: 'dialogue', base, category: (CATEGORIES.has(String(p.category)) ? p.category : 'chunk') as UsefulPhrase['category'],
      meaningKo: str(p.meaningKo, 200), nuance: str(p.nuance), usage: str(p.usage),
      ...(pat ? { pattern: pat.pattern, slotNote: pat.slotNote, swapExamples: pat.examples } : {}),
      occurrences: free,
    });
  }
  return out;
}

/** 빈칸 2순위로 넣을 ✨ 위치 (줄별) */
export function phraseSpansByLine(phrases: UsefulPhrase[]): Record<string, Span[]> {
  const out: Record<string, Span[]> = {};
  for (const p of phrases) for (const o of p.occurrences) (out[o.lineId] ??= []).push({ s: o.start, e: o.end });
  return out;
}

// ─────────────────────────────────────────────
// 화면용: 원문 출처 + 대화문 출처를 한 분류로
// ─────────────────────────────────────────────

export interface UsefulView {
  ref: string;
  source: 'sentence' | 'dialogue';
  base: string;
  forms: string[];
  category: UsefulPhrase['category'] | null;
  meaningKo: string;
  nuance: string;
  usage: string;
  pattern: PatternInfo | null;
  /** 이 표현이 나오는 줄 (순서대로) */
  lineIds: string[];
}

export interface UsefulModel {
  items: UsefulView[];
  /** 줄별 ✨ 위치 (원문 출처는 세그먼트, 대화문 출처는 글자 위치) */
  spans: Map<string, (Span & { ref: string })[]>;
}

/** 대화문의 ✨ 목록 — 새 대화문은 저장된 phrases, 기존 대화문은 사용자가 분석한 결과(annotation) */
export function usefulModelOf(d: Dialogue, annotation?: UsefulPhrase[] | null): UsefulModel {
  const extraUsages = (d.chunkUsages ?? []).filter((u) => u.kind === 'extra');
  const extraIds = new Set(extraUsages.map((u) => u.learningItemId));
  const cs = chunkSpans(d.lines, extraIds);
  const spans = new Map<string, (Span & { ref: string })[]>();
  const items: UsefulView[] = [];
  for (const u of extraUsages) {
    const lineIds = d.lines.filter((l) => cs.get(l.id)?.extra.some((x) => x.ref === u.learningItemId)).map((l) => l.id);
    if (!lineIds.length) continue;
    items.push({ ref: u.learningItemId, source: 'sentence', base: u.text, forms: [u.usedAs], category: null, meaningKo: u.meaningInContext, nuance: u.nuance, usage: u.whyUsed, pattern: templatePattern(u.text), lineIds });
  }
  for (const [lineId, v] of cs) if (v.extra.length) spans.set(lineId, [...v.extra]);
  const phrases = d.phrases ?? annotation ?? [];
  for (const p of phrases) {
    const lineIds: string[] = [];
    for (const o of p.occurrences) {
      const line = d.lines.find((l) => l.id === o.lineId);
      if (!line || lineText(line).slice(o.start, o.end) !== o.usedAs) continue; // 대화문이 바뀌었으면 표시하지 않음
      const taken = [...(cs.get(o.lineId)?.core ?? []), ...(spans.get(o.lineId) ?? [])];
      if (taken.some((t) => overlaps(t, { s: o.start, e: o.end }))) continue;
      spans.set(o.lineId, [...(spans.get(o.lineId) ?? []), { s: o.start, e: o.end, ref: p.id }]);
      lineIds.push(o.lineId);
    }
    if (!lineIds.length) continue;
    // 저장 때 검사를 통과한 패턴만 있으므로, 여기서는 예시가 패턴에 맞는지만 다시 확인
    const pattern = p.pattern && p.swapExamples?.length ? patternFromStored(p) : null;
    items.push({ ref: p.id, source: 'dialogue', base: p.base, forms: [...new Set(p.occurrences.map((o) => o.usedAs))], category: p.category, meaningKo: p.meaningKo, nuance: p.nuance, usage: p.usage, pattern, lineIds: [...new Set(lineIds)] });
  }
  for (const v of spans.values()) v.sort((a, b) => a.s - b.s);
  return { items, spans };
}

function patternFromStored(p: UsefulPhrase): PatternInfo | null {
  const tokens = parsePattern(p.pattern ?? '');
  if (!tokens) return null;
  const examples = (p.swapExamples ?? []).filter((x) => x.ko && fitPattern(x.en, tokens));
  return examples.length ? { pattern: p.pattern!, tokens, slotNote: p.slotNote ?? '', examples } : null;
}

export const CATEGORY_LABEL: Record<UsefulPhrase['category'], string> = { phrasal: '구동사', idiom: '관용 표현', reaction: '공감·반응', pattern: '문장 패턴', chunk: '회화 덩어리' };
