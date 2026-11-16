import { describe, expect, it } from 'vitest';
import { matchAllParts, matchParts, partsFrom, patternLabel } from './chunkMatch';

describe('떨어진 Chunk 찾기 (could … use)', () => {
  it('사이에 부사가 끼어도 같은 Chunk', () => {
    expect(matchParts('I could seriously use a cup of coffee.', ['could', 'use'])?.surface).toBe('could seriously use');
    expect(matchParts('I could really use a nap.', ['could', 'use'])?.surface).toBe('could really use');
    expect(matchParts('We could use some help.', ['could', 'use'])?.surface).toBe('could use');
    expect(matchParts('I Could Use It', ['could', 'use'])?.spans).toEqual([[2, 7], [8, 11]]);
  });
  it('끼는 단어는 2개까지, 순서가 바뀌면 아님', () => {
    expect(matchParts('I could not really ever use it', ['could', 'use'])).toBeNull();
    expect(matchParts('use could', ['could', 'use'])).toBeNull();
    expect(matchParts('could, honestly, use', ['could', 'use'])?.surface).toBe('could, honestly, use');
  });
  it('여러 단어 part와 여러 번 나오는 경우', () => {
    expect(matchAllParts('I could use a break. You could really use one too.', ['could', 'use']).map((m) => m.surface)).toEqual(['could use', 'could really use']);
    expect(matchParts('a cup of hot coffee', ['a cup of', 'coffee'])?.spans.length).toBe(2);
    expect(matchParts("I'm running late", ["I'm", 'late'], 1)?.surface).toBe("I'm running late");
  });
  it('parts 검사와 패턴 이름', () => {
    expect(partsFrom('could use', ['could', 'use'])).toEqual(['could', 'use']);
    expect(partsFrom('could use', ['could', 'need'])).toEqual(['could use']);
    expect(partsFrom('right now', null)).toEqual(['right now']);
    expect(patternLabel(['could', 'use'])).toBe('could … use');
  });
});

import { chunkLabel } from './chunkMatch';
describe('Chunk 이름', () => {
  it('실제로 떨어진 형태가 있을 때만 … 표시', () => {
    expect(chunkLabel('could use', ['could', 'use'], ['could seriously use', 'could use'])).toBe('could … use');
    expect(chunkLabel('could use', ['could', 'use'], ['could use'])).toBe('could use');
    expect(chunkLabel('a little break', ['a', 'little', 'break'], ['a little break'])).toBe('a little break');
  });
});
