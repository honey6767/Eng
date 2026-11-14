import type { Rating, ReviewItemType, ReviewState } from '@/types/models';
import { addDays, addMinutes } from '@/utils/date';
import { clamp } from '@/utils/text';

/**
 * 에빙하우스 망각 곡선 기반 간격 반복 스케줄러 (순수 함수)
 *
 * 초기 추천 간격: 학습 직후 → 1일 → 3일 → 7일 → 14일 → 30일
 * 고정 규칙이 아니라 평가 결과에 따라 조정된다.
 *  - 틀렸어요: 처음 단계로 되돌리고 같은 날(10분 후) 다시 복습, 취약도 크게 증가
 *  - 겨우 기억했어요: 단계를 올리지 않고 간격을 줄여 재복습, 취약도 소폭 증가
 *  - 확실히 외웠어요: 다음 단계로 진행, 취약도 감소.
 *    30일을 넘어서면 연속 정답에 따라 간격을 늘려 장기 기억을 유지(최대 180일)
 */
export const RECOMMENDED_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30] as const;
export const MAX_INTERVAL_DAYS = 180;
export const SAME_DAY_RETRY_MINUTES = 10;

export const WEAKNESS_DELTA: Record<Rating, number> = {
  wrong: 25,
  hard: 10,
  easy: -15,
};

export const RATING_LABEL_KO: Record<Rating, string> = {
  wrong: '틀렸어요',
  hard: '겨우 기억했어요',
  easy: '확실히 외웠어요',
};

export function createReviewState(
  itemType: ReviewItemType,
  itemId: string,
  initialWeakness = 50,
): ReviewState {
  return {
    id: reviewStateId(itemType, itemId),
    itemType,
    itemId,
    correctCount: 0,
    wrongCount: 0,
    lastResult: null,
    lastStudiedAt: null,
    nextReviewAt: null,
    weakness: initialWeakness,
    streak: 0,
    intervalIndex: 0,
    reviewCount: 0,
    lastQuizzedAt: null,
  };
}

export function reviewStateId(itemType: ReviewItemType, itemId: string): string {
  return `${itemType}:${itemId}`;
}

/** 다음 단계 인덱스에 해당하는 간격(일). 표 범위를 넘으면 2배씩 늘림 */
export function intervalDaysForIndex(index: number): number {
  const last = RECOMMENDED_INTERVAL_DAYS.length - 1;
  if (index <= last) return RECOMMENDED_INTERVAL_DAYS[Math.max(0, index)];
  const extra = index - last;
  return Math.min(MAX_INTERVAL_DAYS, RECOMMENDED_INTERVAL_DAYS[last] * 2 ** extra);
}

/** 평가 결과를 반영한 새 복습 상태를 반환 (원본 불변) */
export function applyRating(state: ReviewState, rating: Rating, now = new Date()): ReviewState {
  const next: ReviewState = { ...state };
  next.lastResult = rating;
  next.lastStudiedAt = now.toISOString();
  next.reviewCount = state.reviewCount + 1;

  // 반복 오답이면 취약도를 더 크게 올린다
  let weaknessDelta = WEAKNESS_DELTA[rating];
  if (rating === 'wrong' && state.lastResult === 'wrong') weaknessDelta += 10;
  next.weakness = clamp(state.weakness + weaknessDelta, 0, 100);

  if (rating === 'wrong') {
    next.wrongCount = state.wrongCount + 1;
    next.streak = 0;
    next.intervalIndex = 0;
    next.nextReviewAt = addMinutes(now, SAME_DAY_RETRY_MINUTES).toISOString();
    return next;
  }

  next.correctCount = state.correctCount + 1;

  if (rating === 'hard') {
    next.streak = 0;
    // 단계는 유지(최소 1일 단계), 간격은 60%로 단축, 최소 1일
    next.intervalIndex = Math.max(1, state.intervalIndex);
    const days = Math.max(1, Math.round(intervalDaysForIndex(next.intervalIndex) * 0.6));
    next.nextReviewAt = addDays(now, days).toISOString();
    return next;
  }

  // easy
  next.streak = state.streak + 1;
  // 처음 학습(0단계)에서 확실히 외웠다면 1일 단계로 진행
  next.intervalIndex = state.intervalIndex + 1;
  next.nextReviewAt = addDays(now, intervalDaysForIndex(next.intervalIndex)).toISOString();
  return next;
}

export function isDue(state: ReviewState, now = new Date()): boolean {
  return state.nextReviewAt != null && new Date(state.nextReviewAt).getTime() <= now.getTime();
}

/**
 * 복습 우선순위 (낮을수록 먼저)
 * 1. 반복해서 틀린 표현
 * 2. 최근에 틀린 표현
 * 3. 겨우 기억한 표현
 * 4. 복습 예정일이 도래한 대화문
 * 5. 장기 기억 유지를 위한 암기 완료 항목
 */
export type ReviewPriority = 1 | 2 | 3 | 4 | 5;

export const PRIORITY_LABEL_KO: Record<ReviewPriority, string> = {
  1: '반복 오답',
  2: '최근 오답',
  3: '겨우 기억',
  4: '복습 예정',
  5: '장기 유지',
};

export function reviewPriority(state: ReviewState): ReviewPriority {
  if (state.lastResult === 'wrong' && state.wrongCount >= 2) return 1;
  if (state.lastResult === 'wrong') return 2;
  if (state.lastResult === 'hard') return 3;
  if (state.intervalIndex >= RECOMMENDED_INTERVAL_DAYS.length - 1) return 5;
  return 4;
}

/** 우선순위 → 취약도(높은 순) → 예정일(이른 순)으로 정렬 */
export function sortByPriority(states: ReviewState[]): ReviewState[] {
  return [...states].sort((a, b) => {
    const p = reviewPriority(a) - reviewPriority(b);
    if (p !== 0) return p;
    const w = b.weakness - a.weakness;
    if (w !== 0) return w;
    return (a.nextReviewAt ?? '').localeCompare(b.nextReviewAt ?? '');
  });
}
