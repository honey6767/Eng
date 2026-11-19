/**
 * 핵심 문장 안에서 핵심 표현의 위치를 찾는다 (3단계).
 *
 * - 원문은 절대 바꾸지 않고, 원문 기준 글자 위치(start, end)만 계산한다.
 * - 정확히 같은 글자가 있으면 그 위치를 쓰고, 없으면 단어 단위로 형태 변화(slip → slipped,
 *   take → took, my ↔ your 등)를 허용해 찾는다. 그래도 못 찾으면 null — 화면에서 직접 지정한다.
 */

export interface TextSpan {
  start: number;
  end: number;
}

export interface Token {
  text: string;
  start: number;
  end: number;
}

/** 단어(아포스트로피 포함) 단위 토큰 — 구두점은 제외 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return tokens;
}

const norm = (w: string) => w.toLowerCase().replace(/’/g, "'");

const POSSESSIVES = new Set(["my", "your", "his", "her", "its", "our", "their", "one's", "someone's", "somebody's"]);
const OBJECTS = new Set(['me', 'you', 'him', 'her', 'it', 'us', 'them', 'someone', 'somebody']);
/** 표현 사전형에 쓰이는 자리표시자 — 한 단어 이상 아무 말과 맞춘다 */
const PLACEHOLDERS = new Set(['someone', 'somebody', 'something', 'sb', 'sth', 'sb.', 'sth.', 'somewhere']);

const IRREGULAR: Record<string, string[]> = {
  be: ['am', 'is', 'are', 'was', 'were', 'been', 'being', "i'm", "you're", "he's", "she's", "it's", "we're", "they're"],
  have: ['has', 'had', 'having', "i've", "you've", "we've", "they've"],
  do: ['does', 'did', 'done', 'doing'],
  go: ['goes', 'went', 'gone', 'going'],
  take: ['took', 'taken', 'taking', 'takes'],
  get: ['got', 'gotten', 'getting', 'gets'],
  make: ['made', 'making', 'makes'],
  come: ['came', 'coming', 'comes'],
  give: ['gave', 'given', 'giving', 'gives'],
  run: ['ran', 'running', 'runs'],
  keep: ['kept'],
  say: ['said'],
  tell: ['told'],
  know: ['knew', 'known'],
  think: ['thought'],
  see: ['saw', 'seen'],
  find: ['found'],
  feel: ['felt'],
  leave: ['left'],
  bring: ['brought'],
  buy: ['bought'],
  catch: ['caught'],
  hold: ['held'],
  mean: ['meant'],
  meet: ['met'],
  sit: ['sat'],
  stand: ['stood'],
  lose: ['lost'],
  pay: ['paid'],
  send: ['sent'],
  spend: ['spent'],
  win: ['won'],
  break: ['broke', 'broken'],
  speak: ['spoke', 'spoken'],
  fall: ['fell', 'fallen'],
  grab: ['grabbed', 'grabbing'],
  slip: ['slipped', 'slipping'],
};
const IRREGULAR_REVERSE = new Map<string, string>();
for (const [base, forms] of Object.entries(IRREGULAR)) for (const f of forms) IRREGULAR_REVERSE.set(f, base);

/** 규칙 변화형 후보 (사전형 → 변화형) */
function regularForms(base: string): string[] {
  const forms = [base, `${base}s`, `${base}es`, `${base}ed`, `${base}d`, `${base}ing`];
  if (base.endsWith('e')) forms.push(`${base.slice(0, -1)}ing`);
  if (base.endsWith('y')) forms.push(`${base.slice(0, -1)}ies`, `${base.slice(0, -1)}ied`);
  // 단모음 + 단자음: stop → stopped, stopping
  if (/[^aeiou][aeiou][bdgklmnprt]$/.test(base)) {
    const last = base[base.length - 1];
    forms.push(`${base}${last}ed`, `${base}${last}ing`);
  }
  return forms;
}

/** 표현의 한 단어(pattern)가 문장의 한 단어(word)와 같은 말로 볼 수 있는지 */
export function wordMatches(pattern: string, word: string): boolean {
  const p = norm(pattern);
  const w = norm(word);
  if (p === w) return true;
  if (POSSESSIVES.has(p) && POSSESSIVES.has(w)) return true;
  if (OBJECTS.has(p) && OBJECTS.has(w)) return true;
  if (IRREGULAR[p]?.includes(w)) return true;
  if (IRREGULAR_REVERSE.get(w) === p) return true;
  if (p.length >= 2 && regularForms(p).includes(w)) return true;
  return false;
}

export function findExpressionSpan(sentence: string, expression: string): TextSpan | null {
  const expr = expression.trim().replace(/[.!?,;:]+$/, '');
  if (!expr) return null;

  // 1) 대소문자·곡선 따옴표만 무시한 정확 일치
  const hay = norm(sentence);
  const needle = norm(expr);
  const idx = hay.indexOf(needle);
  if (idx >= 0) return { start: idx, end: idx + needle.length };

  // 2) 단어 단위 비교 (형태 변화·자리표시자 허용, 연속된 단어만)
  const sTokens = tokenize(sentence);
  const eTokens = tokenize(expr).map((t) => t.text);
  if (eTokens.length === 0) return null;

  const matchFrom = (si: number, ei: number): number | null => {
    if (ei === eTokens.length) return si; // 끝 위치(다음 토큰 인덱스)
    const pat = eTokens[ei];
    if (PLACEHOLDERS.has(norm(pat))) {
      for (let n = 1; n <= 3 && si + n <= sTokens.length; n++) {
        const r = matchFrom(si + n, ei + 1);
        if (r != null) return r;
      }
      return null;
    }
    if (si >= sTokens.length || !wordMatches(pat, sTokens[si].text)) return null;
    return matchFrom(si + 1, ei + 1);
  };

  for (let i = 0; i < sTokens.length; i++) {
    const endIdx = matchFrom(i, 0);
    if (endIdx != null && endIdx > i) return { start: sTokens[i].start, end: sTokens[endIdx - 1].end };
  }
  return null;
}

/** 토큰 범위(첫 토큰~마지막 토큰, 포함) → 글자 위치 */
export function spanFromTokens(tokens: Token[], first: number, last: number): TextSpan {
  const a = Math.min(first, last);
  const b = Math.max(first, last);
  return { start: tokens[a].start, end: tokens[b].end };
}

/** 겹치지 않게 정렬된 강조 구간으로 문장을 나눈다 (화면 표시용) */
export function splitBySpans<T extends TextSpan>(text: string, spans: T[]): { text: string; span: T | null }[] {
  const sorted = [...spans].filter((s) => s.start < s.end && s.end <= text.length).sort((a, b) => a.start - b.start);
  const parts: { text: string; span: T | null }[] = [];
  let pos = 0;
  for (const s of sorted) {
    if (s.start < pos) continue; // 겹치는 구간은 건너뜀
    if (s.start > pos) parts.push({ text: text.slice(pos, s.start), span: null });
    parts.push({ text: text.slice(s.start, s.end), span: s });
    pos = s.end;
  }
  if (pos < text.length) parts.push({ text: text.slice(pos), span: null });
  return parts;
}
