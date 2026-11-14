import { describe, expect, it } from 'vitest';
import { applyRating, createReviewState, intervalDaysForIndex, reviewPriority, sortByPriority } from './scheduler';

const now = new Date('2026-11-14T10:00:00Z');
const days = (iso: string | null) => Math.round((new Date(iso!).getTime() - now.getTime()) / 86400000);

describe('scheduler', () => {
  it('추천 간격 표: 직후→1→3→7→14→30일, 이후 2배(최대 180일)', () => {
    expect([0, 1, 2, 3, 4, 5].map(intervalDaysForIndex)).toEqual([0, 1, 3, 7, 14, 30]);
    expect(intervalDaysForIndex(6)).toBe(60);
    expect(intervalDaysForIndex(10)).toBe(180);
  });

  it('확실히 외웠어요: 단계 진행, 취약도 감소', () => {
    let s = createReviewState('expression', 'x');
    s = applyRating(s, 'easy', now);
    expect(s.intervalIndex).toBe(1);
    expect(days(s.nextReviewAt)).toBe(1);
    expect(s.weakness).toBe(35);
    s = applyRating(s, 'easy', now);
    expect(days(s.nextReviewAt)).toBe(3);
    expect(s.streak).toBe(2);
    expect(s.correctCount).toBe(2);
  });

  it('틀렸어요: 처음 단계로, 같은 날 재복습, 반복 오답은 취약도 가중', () => {
    let s = { ...createReviewState('expression', 'x'), intervalIndex: 3, streak: 2 };
    s = applyRating(s, 'wrong', now);
    expect(s.intervalIndex).toBe(0);
    expect(s.streak).toBe(0);
    expect(new Date(s.nextReviewAt!).getTime() - now.getTime()).toBe(10 * 60 * 1000);
    expect(s.weakness).toBe(75);
    s = applyRating(s, 'wrong', now);
    expect(s.weakness).toBe(100); // 75 + 35 → 100 상한
    expect(s.wrongCount).toBe(2);
  });

  it('겨우 기억했어요: 단계 유지 + 간격 단축(최소 1일)', () => {
    const s = applyRating({ ...createReviewState('expression', 'x'), intervalIndex: 3 }, 'hard', now);
    expect(s.intervalIndex).toBe(3);
    expect(days(s.nextReviewAt)).toBe(4); // 7일 * 0.6
    const first = applyRating(createReviewState('expression', 'y'), 'hard', now);
    expect(days(first.nextReviewAt)).toBe(1);
  });

  it('원본 상태를 변경하지 않는다', () => {
    const s = createReviewState('expression', 'x');
    applyRating(s, 'wrong', now);
    expect(s.wrongCount).toBe(0);
  });

  it('복습 우선순위: 반복 오답 > 최근 오답 > 겨우 기억 > 예정 > 장기 유지', () => {
    const base = createReviewState('expression', 'a');
    const repeated = { ...base, id: '1', lastResult: 'wrong' as const, wrongCount: 3 };
    const recent = { ...base, id: '2', lastResult: 'wrong' as const, wrongCount: 1 };
    const hard = { ...base, id: '3', lastResult: 'hard' as const };
    const due = { ...base, id: '4', lastResult: 'easy' as const, intervalIndex: 2 };
    const longTerm = { ...base, id: '5', lastResult: 'easy' as const, intervalIndex: 5 };
    expect([repeated, recent, hard, due, longTerm].map(reviewPriority)).toEqual([1, 2, 3, 4, 5]);
    expect(sortByPriority([longTerm, due, hard, recent, repeated]).map((s) => s.id)).toEqual(['1', '2', '3', '4', '5']);
  });
});
