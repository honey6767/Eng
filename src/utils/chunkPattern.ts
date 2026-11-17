/**
 * 추가 덩어리 표현의 교체 패턴 (예: which + 명사 + to buy)
 *
 * - 기본 Chunk(실제로 쓰는 완성된 표현)와 교체 패턴(일부를 바꿔 새 표현을 만드는 틀)은 다른 정보다.
 * - 교체 자리는 정해진 이름만 쓴다. 패턴의 고정 부분은 기본 Chunk에 같은 순서로 있어야 한다.
 * - 활용 예시는 패턴에 맞아야 하고, 한국어 뜻이 있어야 하며, 기본 Chunk와 같으면 뺀다. 최대 3개.
 * - 확인할 수 없으면 패턴을 보여 주지 않는다 (기본 Chunk만).
 * - 예전 자료는 아래 검토된 틀(TEMPLATES)에 맞을 때만 화면에서 보완한다. 저장값은 바꾸지 않는다.
 */

export const SLOT_LABELS = ['명사', '불가산명사', '형용사', '동사원형', '동사-ing', '사람', '장소'] as const;
export type SlotLabel = (typeof SLOT_LABELS)[number];

export interface SwapExample {
  en: string;
  ko: string;
  /** 기본 Chunk와 뜻이 달라지면 그 차이 */
  note?: string;
}

export interface PatternToken {
  text: string;
  slot: boolean;
}

export interface PatternInfo {
  pattern: string;
  tokens: PatternToken[];
  /** 자리에 무엇이 들어가는지 (예: 명사 자리: 사려는 물건) */
  slotNote: string;
  examples: SwapExample[];
}

const MAX_EXAMPLES = 3;
const WORD = "[a-z0-9]+(?:['-][a-z0-9]+)*";

/** 비교용: 소문자, 곡선 따옴표 통일, 문장부호 제거 */
export const normPhrase = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const isSlot = (t: string): t is SlotLabel => (SLOT_LABELS as readonly string[]).includes(t);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "which + 명사 + to buy" → 조각. 자리 1개 이상, 고정 부분 1개 이상, 자리끼리 붙어 있으면 안 됨 */
export function parsePattern(pattern: string): PatternToken[] | null {
  const raw = pattern.split('+').map((t) => t.trim());
  if (raw.length < 2 || raw.some((t) => !t)) return null;
  const tokens = raw.map((t) => (isSlot(t) ? { text: t, slot: true } : { text: normPhrase(t), slot: false }));
  if (!tokens.some((t) => t.slot) || !tokens.some((t) => !t.slot)) return null;
  if (tokens.some((t) => !t.slot && !new RegExp(`^${WORD}(?: ${WORD})*$`).test(t.text))) return null;
  for (let i = 1; i < tokens.length; i++) if (tokens[i].slot && tokens[i - 1].slot) return null;
  return tokens;
}

/** 표현이 패턴에 맞으면 자리마다 들어간 말 (자리 하나에 1~3단어) */
export function fitPattern(text: string, tokens: PatternToken[]): string[] | null {
  const re = new RegExp(`^${tokens.map((t) => (t.slot ? `(${WORD}(?: ${WORD}){0,2})` : escape(t.text))).join(' ')}$`);
  const m = re.exec(normPhrase(text));
  return m ? m.slice(1) : null;
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** 패턴·활용 예시 검사 — 맞지 않는 예시는 빼고, 남는 예시가 없으면 패턴도 보여 주지 않는다 */
export function checkPattern(base: string, pattern: unknown, slotNote: unknown, examples: unknown): PatternInfo | null {
  const p = clean(pattern, 80);
  const tokens = p ? parsePattern(p) : null;
  if (!tokens || !fitPattern(base, tokens)) return null;
  const baseKey = normPhrase(base);
  const seen = new Set<string>([baseKey]);
  const out: SwapExample[] = [];
  for (const x of Array.isArray(examples) ? (examples as Record<string, unknown>[]) : []) {
    const en = clean(x?.en, 80);
    const ko = clean(x?.ko, 80);
    const note = clean(x?.note, 160);
    const key = normPhrase(en);
    if (!en || !ko || seen.has(key) || !fitPattern(en, tokens)) continue;
    seen.add(key);
    out.push({ en, ko, ...(note ? { note } : {}) });
    if (out.length >= MAX_EXAMPLES) break;
  }
  if (!out.length) return null;
  return { pattern: tokens.map((t) => t.text).join(' + '), tokens, slotNote: clean(slotNote, 80), examples: out };
}

// ─────────────────────────────────────────────
// 예전 자료용 검토된 틀 (화면에서만 보완, 영어 예시·한국어 뜻은 미리 검토한 것만)
// ─────────────────────────────────────────────

type Ex = [string, string, string?];
interface Template {
  match: RegExp;
  build: (m: RegExpExecArray) => { pattern: string; slotNote: string; examples: Ex[] } | null;
}

const ADJECTIVES = new Set(
  'tired happy busy familiar great good sick nice better sad upset sleepy excited nervous bored worried fine okay angry different delicious interesting weird strange amazing perfect fun easy hard serious young old hungry cold hot healthy pale exhausted stressed calm confused surprised'.split(' '),
);

const LINKING: Record<string, { note: string; examples: Ex[] }> = {
  look: { note: '형용사 자리: 겉으로 보이는 상태', examples: [['look happy', '행복해 보이다'], ['look familiar', '낯익어 보이다'], ['look busy', '바빠 보이다'], ['look tired', '피곤해 보이다']] },
  feel: { note: '형용사 자리: 몸이나 기분 상태', examples: [['feel better', '몸(기분)이 나아지다'], ['feel sick', '몸이 안 좋다'], ['feel great', '기분이 아주 좋다'], ['feel tired', '피곤하다']] },
  seem: { note: '형용사 자리: 그렇게 느껴지는 상태', examples: [['seem busy', '바빠 보이다'], ['seem nice', '좋은 사람 같다'], ['seem happy', '행복해 보이다'], ['seem tired', '피곤해 보이다']] },
  sound: { note: '형용사 자리: 들은 말에 대한 느낌', examples: [['sound good', '좋은 생각 같다'], ['sound great', '아주 좋다'], ['sound familiar', '들어 본 것 같다']] },
};

const WHICH_TO: Record<string, { note: string; examples: Ex[] }> = {
  buy: { note: '명사 자리: 사려는 물건', examples: [['which phone to buy', '어떤 폰을 살지'], ['which laptop to buy', '어떤 노트북을 살지'], ['which one to buy', '어떤 것을 살지']] },
  choose: { note: '명사 자리: 고르려는 것', examples: [['which one to choose', '어떤 것을 고를지'], ['which color to choose', '어떤 색을 고를지'], ['which option to choose', '어떤 옵션을 고를지']] },
  wear: { note: '명사 자리: 입거나 신을 것', examples: [['which jacket to wear', '어떤 재킷을 입을지'], ['which shoes to wear', '어떤 신발을 신을지'], ['which dress to wear', '어떤 원피스를 입을지']] },
  order: { note: '명사 자리: 주문하려는 것', examples: [['which pizza to order', '어떤 피자를 시킬지'], ['which drink to order', '어떤 음료를 시킬지'], ['which one to order', '어떤 것을 시킬지']] },
};

const GET_MUCH: Ex[] = [
  ["didn't get much sleep", '잠을 별로 못 잤다', 'sleep은 잠 자체를 말해요'],
  ["didn't get much rest", '휴식을 별로 취하지 못했다', 'sleep(잠)보다 넓게, 잠을 포함해 쉬는 것 전반을 말해요'],
  ["didn't get much exercise", '운동을 별로 하지 못했다', '잠·휴식이 아니라 몸을 움직인 양이 적었다는 뜻이에요'],
];
const UNCOUNTABLE = new Set(['sleep', 'rest', 'exercise', 'time', 'help', 'sunlight', 'fresh air']);

const CONTAINER: Record<string, { note: string; examples: Ex[] }> = {
  cup: { note: '명사 자리: 음료 (컵으로 마시는 것)', examples: [['a cup of tea', '차 한 잔'], ['a cup of hot chocolate', '핫초코 한 잔'], ['a cup of coffee', '커피 한 잔']] },
  glass: { note: '명사 자리: 음료 (유리잔으로 마시는 것)', examples: [['a glass of water', '물 한 잔'], ['a glass of milk', '우유 한 잔'], ['a glass of wine', '와인 한 잔']] },
};
const DRINKS = new Set(['coffee', 'tea', 'hot chocolate', 'water', 'milk', 'wine', 'juice', 'orange juice', 'green tea', 'beer', 'cocoa']);

const TEMPLATES: Template[] = [
  {
    match: /^(look|feel|seem|sound) ([a-z]+)$/,
    build: (m) => (ADJECTIVES.has(m[2]) ? { pattern: `${m[1]} + 형용사`, slotNote: LINKING[m[1]].note, examples: LINKING[m[1]].examples } : null),
  },
  {
    match: /^which ([a-z]+) to (buy|choose|wear|order)$/,
    build: (m) => ({ pattern: `which + 명사 + to ${m[2]}`, slotNote: WHICH_TO[m[2]].note, examples: WHICH_TO[m[2]].examples }),
  },
  {
    match: /^didn't get much ([a-z]+(?: [a-z]+)?)$/,
    build: (m) => (UNCOUNTABLE.has(m[1]) ? { pattern: "didn't get much + 불가산명사", slotNote: '불가산명사 자리: 충분히 하지(얻지) 못한 것', examples: GET_MUCH } : null),
  },
  {
    match: /^a (cup|glass) of ([a-z]+(?: [a-z]+)?)$/,
    build: (m) => (DRINKS.has(m[2]) ? { pattern: `a ${m[1]} of + 명사`, slotNote: CONTAINER[m[1]].note, examples: CONTAINER[m[1]].examples } : null),
  },
];

/** 예전 자료용: 검토된 틀에 맞으면 교체 패턴과 활용 예시 (같은 검사를 거친다) */
export function templatePattern(base: string): PatternInfo | null {
  const key = normPhrase(base);
  for (const t of TEMPLATES) {
    const m = t.match.exec(key);
    const b = m && t.build(m);
    if (!b) continue;
    return checkPattern(base, b.pattern, b.slotNote, b.examples.map(([en, ko, note]) => ({ en, ko, note })));
  }
  return null;
}
