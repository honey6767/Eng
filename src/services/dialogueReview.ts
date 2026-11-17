import type { DayAssignment, Dialogue, DialogueProgress, Rating, ReviewState, Video } from '@/types/models';
import { addDays, endOfDay } from '@/utils/date';
import { applyRating, createReviewState, intervalDaysForIndex, reviewStateId } from './scheduler';

/**
 * 대화문 누적 복습 (에빙하우스 망각 곡선을 참고한 간격 반복)
 *
 * - 복습 단위는 통합 대화문 전체 (표현·Chunk가 아님)
 * - 5단계 암기를 마친 날부터 1일 → 3일 → 7일 → 14일 → 30일 뒤 복습 (그 뒤는 간격을 늘림, 기존 scheduler 그대로)
 * - 복습 평가: 잘 기억함 → 다음 간격 / 헷갈림 → 간격 줄여 다시 / 다시 외워야 함 → 처음 간격부터(오늘 다시)
 * - 저장은 기존 '복습 상태' 표(reviewStates, itemType='dialogue')만 쓴다. DB 구조 변경 없음
 * - 이 기능 전에 이미 암기를 마친 대화문은 저장값을 바꾸지 않고, 암기 완료일 기준으로 화면에서 일정을 계산한다
 *   (사용자가 처음 복습을 평가할 때 그 대화문의 복습 상태가 처음 저장된다)
 */

export interface DialogueReviewItem {
  dialogue: Dialogue;
  /** 'Day 3' · 'Day 3 · Day 7' · 영상 제목 */
  label: string;
  dayNumbers: number[];
  state: ReviewState;
  /** 저장된 복습 상태가 아직 없음 (예전에 암기를 마친 대화문) */
  virtual: boolean;
  dueAt: string;
  /** 몇 번째 복습인지 (암기 완료 뒤 1번째부터) */
  reviewNo: number;
  /** 이번 복습 간격 (일) */
  intervalDays: number;
  /** 예정일보다 며칠 지났는지 (오늘이 예정일이면 0) */
  overdueDays: number;
}

export interface DialogueReviewSchedule {
  /** 오늘(자정까지) 복습할 대화문 — 오래 밀린 것부터 */
  due: DialogueReviewItem[];
  /** 앞으로 예정된 복습 — 가까운 날부터 */
  upcoming: DialogueReviewItem[];
}

export interface ReviewInput {
  dialogues: Dialogue[];
  progress: DialogueProgress[];
  reviewStates: ReviewState[];
  videos?: Video[];
  days?: DayAssignment[];
}

const DAY_MS = 86_400_000;

/** 대화문의 Day 번호 (통합 대화문은 여러 개) */
export function dialogueDays(d: Dialogue, dayByVideo: Map<string, number>): number[] {
  if (d.sourceDays?.length) return [...new Set(d.sourceDays)].sort((a, b) => a - b);
  const day = d.videoId ? dayByVideo.get(d.videoId) : undefined;
  return day ? [day] : [];
}

export const dayLabelOf = (days: number[], fallback: string) => (days.length ? days.map((n) => `Day ${n}`).join(' · ') : fallback);

/** 5단계 암기 완료일 (예전 기록에 완료일이 비어 있으면 마지막 학습 시각) — 외우지 않았으면 null */
export function memorizedDate(p: DialogueProgress | undefined | null): string | null {
  if (!p?.memorized) return null;
  return p.memorizedAt ?? p.updatedAt ?? null;
}

/** 예전에 암기를 마친 대화문: 저장하지 않고 암기 완료일 기준 첫 복습(1일 뒤)으로 본다 */
export function virtualState(dialogueId: string, memorizedAt: string): ReviewState {
  const at = new Date(memorizedAt);
  return { ...createReviewState('dialogue', dialogueId), intervalIndex: 1, reviewCount: 1, correctCount: 1, streak: 1, lastResult: 'easy', lastStudiedAt: at.toISOString(), nextReviewAt: addDays(at, 1).toISOString() };
}

export function dialogueReviewSchedule(input: ReviewInput, now = new Date()): DialogueReviewSchedule {
  const progressById = new Map(input.progress.map((p) => [p.dialogueId, p]));
  const stateById = new Map(input.reviewStates.filter((s) => s.itemType === 'dialogue').map((s) => [s.itemId, s]));
  const dayByVideo = new Map((input.days ?? []).map((d) => [d.videoId, d.dayNumber]));
  const cutoff = endOfDay(now).getTime();
  const due: DialogueReviewItem[] = [];
  const upcoming: DialogueReviewItem[] = [];
  for (const d of input.dialogues) {
    const saved = stateById.get(d.id);
    const p = progressById.get(d.id);
    const at = memorizedDate(p);
    const state = saved ?? (at ? virtualState(d.id, at) : null);
    if (!state?.nextReviewAt) continue;
    const days = dialogueDays(d, dayByVideo);
    const dueAt = state.nextReviewAt;
    const dueMs = new Date(dueAt).getTime();
    const item: DialogueReviewItem = {
      dialogue: d, label: dayLabelOf(days, d.title), dayNumbers: days, state, virtual: !saved, dueAt,
      reviewNo: Math.max(1, state.reviewCount), intervalDays: intervalDaysForIndex(state.intervalIndex),
      overdueDays: Math.max(0, Math.floor((endOfDay(now).getTime() - endOfDay(new Date(dueAt)).getTime()) / DAY_MS)),
    };
    (dueMs <= cutoff ? due : upcoming).push(item);
  }
  const byDay = (a: DialogueReviewItem, b: DialogueReviewItem) => (a.dayNumbers[0] ?? 1e9) - (b.dayNumbers[0] ?? 1e9);
  due.sort((a, b) => a.dueAt.localeCompare(b.dueAt) || byDay(a, b));
  upcoming.sort((a, b) => a.dueAt.localeCompare(b.dueAt) || byDay(a, b));
  return { due, upcoming };
}

/** "오늘은 Day 3, Day 7, Day 12를 복습할 차례입니다." */
export function todaySentence(due: DialogueReviewItem[]): string {
  if (!due.length) return '';
  const names = due.slice(0, 5).map((x) => x.label);
  const rest = due.length > 5 ? ` 외 ${due.length - 5}개` : '';
  return `오늘은 ${names.join(', ')}${rest}를 복습할 차례입니다.`;
}

/** 처음 암기를 마쳤을 때: 1일 뒤 첫 복습 (이미 복습 상태가 있으면 그대로 둔다) */
export function scheduleAfterMemorized(dialogueId: string, existing: ReviewState | undefined | null, now = new Date()): ReviewState | null {
  if (existing) return null;
  return applyRating(createReviewState('dialogue', dialogueId), 'easy', now);
}

/** 복습을 평가했을 때 다음 복습일 계산 (저장된 상태가 없으면 암기 완료일 기준 상태에서 시작) */
export function recordReview(dialogueId: string, existing: ReviewState | undefined | null, memorizedAt: string | null, rating: Rating, now = new Date()): ReviewState {
  const base = existing ?? (memorizedAt ? virtualState(dialogueId, memorizedAt) : applyRating(createReviewState('dialogue', dialogueId), 'easy', now));
  return { ...applyRating(base, rating, now), id: reviewStateId('dialogue', dialogueId) };
}

/** 지금 이 대화문이 복습할 차례인지 (오늘 자정까지 예정) */
export function isReviewDue(state: ReviewState | null | undefined, now = new Date()): boolean {
  return !!state?.nextReviewAt && new Date(state.nextReviewAt).getTime() <= endOfDay(now).getTime();
}

export const REVIEW_RATING_LABEL: Record<Rating, string> = { easy: '잘 기억했어요', hard: '헷갈렸어요', wrong: '다시 외워야 해요' };

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
/** "오늘" · "내일" · "11월 24일 (월) · 3일 뒤" */
export function reviewDateLabel(iso: string | null, now = new Date()): string {
  if (!iso) return '-';
  const d = new Date(iso);
  const diff = Math.round((endOfDay(d).getTime() - endOfDay(now).getTime()) / DAY_MS);
  if (diff <= 0) return '오늘';
  if (diff === 1) return '내일';
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]}) · ${diff}일 뒤`;
}
