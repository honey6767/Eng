import { describe, expect, it } from 'vitest';
import { normalizeExpressionKey } from './text';

describe('normalizeExpressionKey', () => {
  it('대소문자·곡선 따옴표·끝 구두점·공백을 정리한다', () => {
    expect(normalizeExpressionKey("It's not a big deal.")).toBe("it's not a big deal");
    expect(normalizeExpressionKey('  It’s   NOT a big deal ')).toBe("it's not a big deal");
    expect(normalizeExpressionKey('"That makes two of us!"')).toBe('that makes two of us');
  });
});
