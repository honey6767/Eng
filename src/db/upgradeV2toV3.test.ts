import { describe, expect, it } from 'vitest';
import { V2_TABLE_NAMES } from './tables';
import { parseDayNumber, upgradeV2toV3, type V2Tables } from './upgradeV2toV3';

const empty = (): V2Tables => Object.fromEntries(V2_TABLE_NAMES.map((t) => [t, []])) as unknown as V2Tables;
const base = { createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' };

describe('upgradeV2toV3 (순수 함수)', () => {
  it('Day 번호는 제목의 [Day N]만 인정한다', () => {
    expect(parseDayNumber('[Day 11] 필요해 I need 말고')).toBe(11);
    expect(parseDayNumber('[ day 007 ] 소문자·공백·0')).toBe(7);
    expect(parseDayNumber('Day 11 대괄호 없음')).toBeNull();
    expect(parseDayNumber('[Day] 번호 없음')).toBeNull();
    expect(parseDayNumber('[Day 0]')).toBeNull();
    expect(parseDayNumber(null)).toBeNull();
  });

  it('입력을 바꾸지 않고, 같은 입력이면 결과가 항상 같다 (시각 인자는 기록에만 쓰임)', () => {
    const v2 = empty();
    v2.videos.push({ id: 'v1', title: '[Day 1] a', ...base, isSample: true });
    v2.expressions.push({ id: 'e1', ...base });
    v2.keySentences.push({ id: 'k1', videoId: 'v1', english: 'hi', expressionIds: ['e1'], expressionSpans: [{ expressionId: 'e1', start: 0, end: 2 }], timestampSec: 5, ...base, isSample: true });
    const frozen = JSON.stringify(v2);
    const a = upgradeV2toV3(v2, '2026-11-15T00:00:00Z');
    const b = upgradeV2toV3(v2, '2030-01-01T00:00:00Z');
    expect(JSON.stringify(v2)).toBe(frozen);
    expect(a.newTables).toEqual(b.newTables);
    // 같은 표현이 expressionIds와 expressionSpans에 함께 있어도 하나만 만든다
    expect(a.newTables.learningItems).toHaveLength(1);
    // 샘플에서 나온 기록은 샘플 표시를 이어받아, 샘플 삭제 때 함께 지워진다
    expect(a.newTables.learningItems[0]).toMatchObject({ id: 'li-ks-k1-e1', isSample: true, timestampSec: 5, sourceText: 'hi', createdAt: base.createdAt, updatedAt: base.updatedAt });
    expect(a.newTables.dayAssignments[0]).toMatchObject({ id: 'day-v1', isSample: true, dayNumber: 1 });
    expect(a.log.created).toMatchObject({ learningItems: 1, dayAssignments: 1, studySessions: 0, aiRequests: 0 });
  });
});
