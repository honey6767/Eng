import { describe, expect, it } from 'vitest';
import { findExpressionSpan, spanFromTokens, splitBySpans, tokenize, wordMatches } from './expressionSpan';

const pick = (s: string, e: string) => {
  const r = findExpressionSpan(s, e);
  return r ? s.slice(r.start, r.end) : null;
};

describe('핵심 표현 위치 찾기', () => {
  it('정확히 같은 글자 (대소문자·곡선 따옴표 무시)', () => {
    expect(pick("You can't go wrong with that.", "can't go wrong with")).toBe("can't go wrong with");
    expect(pick('That makes two of us.', 'That makes two of us')).toBe('That makes two of us');
    expect(pick('I’ve been meaning to ask you.', "I've been meaning to")).toBe('I’ve been meaning to');
    expect(pick('NOT A BIG DEAL at all', 'not a big deal.')).toBe('NOT A BIG DEAL');
  });

  it('형태가 바뀐 표현 (규칙·불규칙 변화, 소유격)', () => {
    expect(pick('It completely slipped my mind.', 'slip my mind')).toBe('slipped my mind');
    expect(pick('It slipped her mind again.', 'slip my mind')).toBe('slipped her mind');
    expect(pick("I'm running a bit behind today.", 'run behind')).toBeNull(); // 사이에 다른 단어 → 직접 지정
    expect(pick('Sorry, we ran behind schedule.', 'run behind')).toBe('ran behind');
    expect(pick('She took my word for it.', 'take your word for it')).toBe('took my word for it');
    expect(pick('We grabbed a bite after work.', 'grab a bite')).toBe('grabbed a bite');
    expect(pick('He stopped by yesterday.', 'stop by')).toBe('stopped by');
  });

  it('자리표시자(someone/something)는 1~3단어와 맞춘다', () => {
    expect(pick('I will take you up on that.', 'take someone up on something')).toBe('take you up on that');
    expect(pick('Can you give my brother a hand?', 'give someone a hand')).toBe('give my brother a hand');
  });

  it('못 찾으면 null', () => {
    expect(findExpressionSpan('Hello there.', 'grab a bite')).toBeNull();
    expect(findExpressionSpan('Hello there.', '   ')).toBeNull();
  });

  it('단어 비교 규칙', () => {
    expect(wordMatches('be', 'was')).toBe(true);
    expect(wordMatches('try', 'tried')).toBe(true);
    expect(wordMatches('make', 'making')).toBe(true);
    expect(wordMatches('go', 'gone')).toBe(true);
    expect(wordMatches('go', 'get')).toBe(false);
  });

  it('토큰과 글자 위치, 강조 구간 나누기', () => {
    const s = "It's not a big deal.";
    const t = tokenize(s);
    expect(t.map((x) => x.text)).toEqual(["It's", 'not', 'a', 'big', 'deal']);
    const span = spanFromTokens(t, 4, 1);
    expect(s.slice(span.start, span.end)).toBe('not a big deal');
    const parts = splitBySpans(s, [{ ...span, id: 'x' }]);
    expect(parts.map((p) => p.text).join('')).toBe(s);
    expect(parts.find((p) => p.span)?.text).toBe('not a big deal');
  });
});
