import type { Repositories } from '@/repositories/types';
import type { Video, VideoStatus } from '@/types/models';
import { nowISO } from '@/utils/date';

/**
 * 신규 영상 무작위 학습 순서
 *
 * - 학습 완료 영상은 기본적으로 제외 (includeCompleted 옵션으로 포함 가능)
 * - 이번 회차(cycle)의 영상을 모두 한 번씩 학습(방문)하면 남은 대상 영상으로 다시 섞는다
 * - 순서는 IndexedDB(appMeta)에 저장되어 새로고침·재실행해도 유지된다
 * - 새 영상이 추가되면 기존 순서를 유지한 채 아직 학습하지 않은 구간에 무작위로 끼워 넣는다
 * - 실제 영상이 하나라도 있으면 샘플 영상은 대상에서 제외한다
 */
export const META_STUDY_QUEUE = 'studyQueue';

export interface StudyQueueState {
  version: 1;
  cycle: number;
  order: string[];
  /** 이번 회차에 이미 학습을 시작한 영상 */
  visited: string[];
  includeCompleted: boolean;
  shuffledAt: string;
}

export type Rng = () => number;

const secureRandom: Rng = () => {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] / 2 ** 32;
  }
  return Math.random();
};

export function shuffle<T>(items: T[], rng: Rng = secureRandom): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 학습 순서 대상 영상 */
export function eligibleVideos(videos: Video[], includeCompleted: boolean): Video[] {
  const hasReal = videos.some((v) => !v.isSample);
  return videos
    .filter((v) => (hasReal ? !v.isSample : true))
    .filter((v) => includeCompleted || v.status !== 'completed');
}

function newCycle(ids: string[], cycle: number, includeCompleted: boolean, rng: Rng, avoidFirst?: string): StudyQueueState {
  let order = shuffle(ids, rng);
  // 직전에 학습한 영상이 바로 다시 첫 번째로 오지 않게
  if (avoidFirst && order.length > 1 && order[0] === avoidFirst) order = [...order.slice(1), order[0]];
  return { version: 1, cycle, order, visited: [], includeCompleted, shuffledAt: nowISO() };
}

/**
 * 저장된 순서를 현재 영상 목록에 맞게 정리한다 (순수 함수).
 * 변경이 없으면 같은 객체를 반환한다.
 */
export function reconcileQueue(state: StudyQueueState | undefined, videos: Video[], rng: Rng = secureRandom): StudyQueueState {
  const includeCompleted = state?.includeCompleted ?? false;
  const eligible = eligibleVideos(videos, includeCompleted);
  const eligibleIds = new Set(eligible.map((v) => v.id));

  if (!state) return newCycle([...eligibleIds], 1, includeCompleted, rng);

  const allIds = new Set(videos.map((v) => v.id));
  let order = state.order.filter((id) => allIds.has(id));
  const visited = state.visited.filter((id) => allIds.has(id));
  const visitedSet = new Set(visited);
  let changed = order.length !== state.order.length || visited.length !== state.visited.length;

  // 새 영상: 아직 학습하지 않은 구간 안의 무작위 위치에 삽입 (기존 순서는 유지)
  const known = new Set(order);
  const added = shuffle(
    [...eligibleIds].filter((id) => !known.has(id)),
    rng,
  );
  if (added.length) {
    changed = true;
    for (const id of added) {
      const firstUnvisited = order.findIndex((x) => !visitedSet.has(x));
      const start = firstUnvisited === -1 ? order.length : firstUnvisited;
      // 현재 추천 영상(start) 뒤쪽에 끼워 넣어 지금 추천이 갑자기 바뀌지 않게 한다
      const from = Math.min(order.length, start + 1);
      const pos = from + Math.floor(rng() * (order.length - from + 1));
      order = [...order.slice(0, pos), id, ...order.slice(pos)];
    }
  }

  const next: StudyQueueState = changed ? { ...state, order, visited } : state;

  // 이번 회차에 남은 영상이 없으면 다시 섞는다
  const remaining = next.order.filter((id) => eligibleIds.has(id) && !visitedSet.has(id));
  if (remaining.length === 0 && eligibleIds.size > 0) {
    const last = visited[visited.length - 1];
    return newCycle([...eligibleIds], next.cycle + 1, includeCompleted, rng, last);
  }
  return next;
}

export interface QueueView {
  /** 지금 추천하는 다음 영상 */
  current: Video | null;
  /** 이번 회차 남은 영상 수 (현재 포함) */
  remaining: number;
  /** 이번 회차 전체 대상 수 */
  total: number;
  cycle: number;
  includeCompleted: boolean;
  /** 대상 영상이 하나도 없음 (모두 완료 등) */
  allDone: boolean;
}

/** 화면 표시용 계산 (순수 함수, 무작위 없음) */
export function viewQueue(state: StudyQueueState | undefined, videos: Video[]): QueueView {
  const includeCompleted = state?.includeCompleted ?? false;
  const eligible = eligibleVideos(videos, includeCompleted);
  const byId = new Map(eligible.map((v) => [v.id, v]));
  const visited = new Set(state?.visited ?? []);
  const inOrder = (state?.order ?? []).filter((id) => byId.has(id));
  const remainingIds = inOrder.filter((id) => !visited.has(id));
  return {
    current: remainingIds.length ? byId.get(remainingIds[0])! : null,
    remaining: remainingIds.length,
    total: inOrder.length,
    cycle: state?.cycle ?? 1,
    includeCompleted,
    allDone: eligible.length === 0,
  };
}

export function markVisited(state: StudyQueueState, videoId: string): StudyQueueState {
  if (state.visited.includes(videoId)) return state;
  return { ...state, visited: [...state.visited, videoId] };
}

/** 건너뛰기: 이번 회차 순서의 맨 뒤로 보낸다 */
export function skipVideo(state: StudyQueueState, videoId: string): StudyQueueState {
  if (!state.order.includes(videoId)) return state;
  return { ...state, order: [...state.order.filter((id) => id !== videoId), videoId] };
}

// ─────────────────────────────────────────────
// 저장소와 연결된 동작
// ─────────────────────────────────────────────

async function load(repos: Repositories) {
  return repos.meta.get<StudyQueueState>(META_STUDY_QUEUE);
}

/** 영상 목록이 바뀐 뒤 호출 — 순서를 정리하고 변경이 있으면 저장 */
export async function syncStudyQueue(repos: Repositories, rng?: Rng): Promise<StudyQueueState> {
  const [state, videos] = await Promise.all([load(repos), repos.videos.list()]);
  const next = reconcileQueue(state, videos, rng);
  if (next !== state) await repos.meta.set(META_STUDY_QUEUE, next);
  return next;
}

/** 영상 학습 시작 (무작위 추천 영상이든 직접 선택한 영상이든 동일) */
export async function startVideo(repos: Repositories, video: Video): Promise<void> {
  if (video.status === 'new') {
    await repos.videos.update(video.id, { status: 'in_progress', startedAt: video.startedAt ?? nowISO() });
  }
  const state = await syncStudyQueue(repos);
  await repos.meta.set(META_STUDY_QUEUE, markVisited(state, video.id));
  await syncStudyQueue(repos);
}

export async function skipCurrent(repos: Repositories, videoId: string): Promise<void> {
  const state = await syncStudyQueue(repos);
  await repos.meta.set(META_STUDY_QUEUE, skipVideo(state, videoId));
}

/** 사용자가 직접 다시 섞기 (회차 번호 증가) */
export async function reshuffleQueue(repos: Repositories, options?: { includeCompleted?: boolean }, rng?: Rng): Promise<void> {
  const [state, videos] = await Promise.all([load(repos), repos.videos.list()]);
  const includeCompleted = options?.includeCompleted ?? state?.includeCompleted ?? false;
  const ids = eligibleVideos(videos, includeCompleted).map((v) => v.id);
  await repos.meta.set(META_STUDY_QUEUE, newCycle(ids, (state?.cycle ?? 0) + 1, includeCompleted, rng ?? secureRandom));
}

/** 영상 학습 상태 변경 */
export async function setVideoStatus(repos: Repositories, video: Video, status: VideoStatus): Promise<void> {
  const now = nowISO();
  await repos.videos.update(video.id, {
    status,
    completedAt: status === 'completed' ? (video.completedAt ?? now) : null,
    startedAt: status === 'new' ? video.startedAt ?? null : (video.startedAt ?? now),
  });
  if (status !== 'new') {
    const state = await syncStudyQueue(repos);
    await repos.meta.set(META_STUDY_QUEUE, markVisited(state, video.id));
  }
  await syncStudyQueue(repos);
}
