import type { Repositories } from '@/repositories/types';
import type { Dialogue, DialogueProgress, Expression, ReviewState, StudyLog, Video } from '@/types/models';
import { endOfDay, lastNDateKeys, toDateKey } from '@/utils/date';
import { percent } from '@/utils/text';
import { reviewPriority, sortByPriority, type ReviewPriority } from './scheduler';

/** 취약 표현 기준: 취약도 50 이상 또는 사용자가 직접 어렵다고 표시 */
export const WEAK_THRESHOLD = 50;

export interface DueItem {
  state: ReviewState;
  priority: ReviewPriority;
  title: string;
  subtitle: string;
  /** 이동할 화면 경로 (없으면 null) */
  href: string | null;
}

export interface RetentionBuckets {
  /** 아직 복습 이력 없음 */
  notStarted: number;
  /** 직후~1일 단계 */
  shortTerm: number;
  /** 3~7일 단계 */
  midTerm: number;
  /** 14일 이상 단계 */
  longTerm: number;
}

export interface DashboardStats {
  totalVideos: number;
  completedVideos: number;
  inProgressVideos: number;
  newVideos: number;
  totalDialogues: number;
  studiedDialogues: number;
  memorizedDialogues: number;
  totalExpressions: number;
  weakExpressions: number;
  dueItems: DueItem[];
  totalReviews: number;
  todayCount: number;
  weekly: { date: string; count: number }[];
  weekTotal: number;
  /** 영상 완료 기준 진도 (%) */
  videoProgress: number;
  /** 대화문 5단계 기준 진도 (%) */
  stepProgress: number;
  retention: RetentionBuckets;
  /** 이어서 학습할 대화문 */
  continueDialogue: { dialogue: Dialogue; progress: DialogueProgress | undefined } | null;
}

export interface StatsInput {
  videos: Video[];
  dialogues: Dialogue[];
  progress: DialogueProgress[];
  expressions: Expression[];
  reviewStates: ReviewState[];
  recentLogs: StudyLog[];
  totalReviews: number;
}

export function computeDashboardStats(input: StatsInput, now = new Date()): DashboardStats {
  const { videos, dialogues, progress, expressions, reviewStates, recentLogs, totalReviews } = input;
  const progressById = new Map(progress.map((p) => [p.dialogueId, p]));
  const exprById = new Map(expressions.map((e) => [e.id, e]));
  const dialogueById = new Map(dialogues.map((d) => [d.id, d]));
  const exprStates = new Map(reviewStates.filter((s) => s.itemType === 'expression').map((s) => [s.itemId, s]));

  const completedVideos = videos.filter((v) => v.status === 'completed').length;
  const inProgressVideos = videos.filter((v) => v.status === 'in_progress').length;

  const studiedDialogues = dialogues.filter((d) => (progressById.get(d.id)?.highestCompletedStep ?? 0) >= 1).length;
  const memorizedDialogues = dialogues.filter((d) => progressById.get(d.id)?.memorized).length;

  const weakExpressions = expressions.filter(
    (e) => e.isMarkedDifficult || (exprStates.get(e.id)?.weakness ?? 0) >= WEAK_THRESHOLD,
  ).length;

  // 오늘 복습할 항목 (오늘 자정까지 예정된 것 포함)
  const cutoff = endOfDay(now).getTime();
  const due = reviewStates.filter((s) => s.nextReviewAt && new Date(s.nextReviewAt).getTime() <= cutoff);
  const dueItems: DueItem[] = sortByPriority(due)
    .map((state): DueItem | null => {
      if (state.itemType === 'expression') {
        const e = exprById.get(state.itemId);
        if (!e) return null;
        return { state, priority: reviewPriority(state), title: e.text, subtitle: e.meaningKo, href: '/expressions' };
      }
      if (state.itemType === 'dialogue') {
        const d = dialogueById.get(state.itemId);
        if (!d) return null;
        return { state, priority: reviewPriority(state), title: d.title, subtitle: '대화문', href: `/dialogues/${d.id}` };
      }
      return null; // sentence 복습은 6단계에서 연결
    })
    .filter((x): x is DueItem => x !== null);

  const todayKey = toDateKey(now);
  const weekKeys = lastNDateKeys(7, now);
  const countByDate = new Map<string, number>();
  for (const log of recentLogs) countByDate.set(log.date, (countByDate.get(log.date) ?? 0) + 1);
  const weekly = weekKeys.map((date) => ({ date, count: countByDate.get(date) ?? 0 }));

  const totalSteps = dialogues.length * 5;
  const doneSteps = dialogues.reduce((sum, d) => sum + (progressById.get(d.id)?.highestCompletedStep ?? 0), 0);

  // 장기 기억 유지 현황 — 표현과 대화문의 복습 단계 분포
  const retention: RetentionBuckets = { notStarted: 0, shortTerm: 0, midTerm: 0, longTerm: 0 };
  const trackedIds = [
    ...expressions.map((e) => `expression:${e.id}`),
    ...dialogues.map((d) => `dialogue:${d.id}`),
  ];
  const stateById = new Map(reviewStates.map((s) => [s.id, s]));
  for (const id of trackedIds) {
    const s = stateById.get(id);
    if (!s || s.reviewCount === 0) retention.notStarted++;
    else if (s.intervalIndex <= 1) retention.shortTerm++;
    else if (s.intervalIndex <= 3) retention.midTerm++;
    else retention.longTerm++;
  }

  // 이어서 학습: 시작했지만 암기 완료되지 않은 대화문 중 최근 것 → 없으면 시작 안 한 첫 대화문
  const inProgress = dialogues
    .filter((d) => {
      const p = progressById.get(d.id);
      return p && !p.memorized && p.highestCompletedStep > 0;
    })
    .sort((a, b) => (progressById.get(b.id)!.updatedAt ?? '').localeCompare(progressById.get(a.id)!.updatedAt ?? ''));
  // 아직 시작 안 한 대화문은 Day 번호 순 (줄이 없는 빈 대화문은 제외)
  const dayOf = (d: (typeof dialogues)[number]) => d.sourceDays?.[0] ?? Number.MAX_SAFE_INTEGER;
  const notStarted = dialogues.filter((d) => !progressById.get(d.id) && d.lines.length > 0).sort((a, b) => dayOf(a) - dayOf(b));
  const next = inProgress[0] ?? notStarted[0] ?? null;

  return {
    totalVideos: videos.length,
    completedVideos,
    inProgressVideos,
    newVideos: videos.length - completedVideos - inProgressVideos,
    totalDialogues: dialogues.length,
    studiedDialogues,
    memorizedDialogues,
    totalExpressions: expressions.length,
    weakExpressions,
    dueItems,
    totalReviews,
    todayCount: countByDate.get(todayKey) ?? 0,
    weekly,
    weekTotal: weekly.reduce((s, d) => s + d.count, 0),
    videoProgress: percent(completedVideos, videos.length),
    stepProgress: percent(doneSteps, totalSteps),
    retention,
    continueDialogue: next ? { dialogue: next, progress: progressById.get(next.id) } : null,
  };
}

export async function loadDashboardStats(repos: Repositories, now = new Date()): Promise<DashboardStats> {
  const weekStartKey = lastNDateKeys(7, now)[0];
  const [videos, dialogues, progress, expressions, reviewStates, recentLogs, totalReviews] = await Promise.all([
    repos.videos.list(),
    repos.dialogues.list(),
    repos.dialogueProgress.list(),
    repos.expressions.list(),
    repos.reviewStates.list(),
    repos.studyLogs.listSince(weekStartKey),
    repos.studyLogs.countReviews(),
  ]);
  return computeDashboardStats({ videos, dialogues, progress, expressions, reviewStates, recentLogs, totalReviews }, now);
}
