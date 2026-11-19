import type { PrepState } from '@/repositories/contentStore';
import { computeRows, processVideo, summarizeRows, type PrepDeps, type PrepRow, type PrepStage, type PrepSummary } from './prepRunner';

/**
 * 학습 자료 자동 생성 실행 관리 — 시작·멈춤·이어하기, 화면에 보여 줄 상태.
 * - 한 탭에서만 실행 (Web Locks 'mes-extraction' — 기존 자막 추출과 같은 잠금이라 둘이 동시에 돌지 않음)
 * - 앱을 열 때 resume(): 대기 중인 영상이나 진행 중이던 요청이 있으면 이어서
 * - 하루 한도로 멈췄으면 초기화 시각에 (앱이 열려 있으면) 자동으로 다시 시작
 */

export type PrepRunStatus =
  | { kind: 'idle' }
  | { kind: 'running'; videoId: string; title: string; stage: PrepStage; since: string; note?: string }
  | { kind: 'paused'; code: string; message: string; until: string | null; httpStatus: number | null }
  | { kind: 'other_tab' }
  | { kind: 'done' };

export interface PrepSnapshot {
  status: PrepRunStatus;
  summary: PrepSummary | null;
  rows: PrepRow[];
  state: PrepState | null;
}

export interface PrepControllerDeps extends PrepDeps {
  withLock?: (fn: () => Promise<void>, signal?: AbortSignal) => Promise<boolean>;
}

const defaultLock = async (fn: () => Promise<void>, signal?: AbortSignal) => {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks) {
    await fn();
    return true;
  }
  let got = false;
  try {
    await locks.request('mes-extraction', { signal }, async () => {
      got = true;
      await fn();
    });
  } catch {
    /* 멈춤 */
  }
  return got;
};

export function createPrepController(deps: PrepControllerDeps) {
  const withLock = deps.withLock ?? defaultLock;
  const now = deps.now ?? (() => new Date());
  let snapshot: PrepSnapshot = { status: { kind: 'idle' }, summary: null, rows: [], state: null };
  const listeners = new Set<(s: PrepSnapshot) => void>();
  let loop: Promise<void> | null = null;
  let abort: AbortController | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;

  const emit = (patch: Partial<PrepSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const l of listeners) l(snapshot);
  };
  const refresh = async () => {
    const [ov, state] = await Promise.all([deps.store.readPrepOverview(), deps.store.getPrep()]);
    const rows = computeRows(ov, state);
    emit({ rows, summary: summarizeRows(rows), state });
    return { rows, state };
  };

  const scheduleWake = (until: string | null) => {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = null;
    if (!until) return;
    const ms = Date.parse(until) - now().getTime() + 5_000;
    if (ms > 0 && ms < 26 * 3_600_000) wakeTimer = setTimeout(() => void api.start(), ms);
  };

  async function runLoop(signal: AbortSignal) {
    while (!signal.aborted) {
      const { rows, state } = await refresh();
      if (state.pausedUntil && Date.parse(state.pausedUntil) > now().getTime()) {
        emit({ status: { kind: 'paused', code: state.pauseReason ?? 'daily_cap', message: state.pauseMessage ?? '', until: state.pausedUntil, httpStatus: null } });
        scheduleWake(state.pausedUntil);
        return;
      }
      const next = rows.find((r) => r.status === 'queued');
      if (!next) {
        emit({ status: { kind: 'done' } });
        return;
      }
      const since = now().toISOString();
      const retry = state.retry.includes(next.video.id);
      emit({ status: { kind: 'running', videoId: next.video.id, title: next.video.title, stage: next.stage, since } });
      const out = await processVideo(next, deps, retry, (n) => emit({ status: { kind: 'running', videoId: next.video.id, title: next.video.title, stage: n.stage, since, note: n.note } }), signal);
      const iso = now().toISOString();
      if (out.kind === 'pause') {
        if (out.code === 'cancelled') return;
        await deps.store.updatePrep((s) => ({ ...s, pausedUntil: out.until ?? (out.code === 'daily_cap' || out.code === 'gemini_quota' ? iso : null), pauseReason: out.code, pauseMessage: out.message }));
        emit({ status: { kind: 'paused', code: out.code, message: out.message, until: out.until, httpStatus: out.httpStatus } });
        await refresh();
        scheduleWake(out.until);
        return;
      }
      await deps.store.updatePrep((s) => {
        const videos = { ...s.videos };
        if (out.kind === 'ok') delete videos[next.video.id];
        else videos[next.video.id] = { status: out.skip ? 'skipped' : 'failed', stage: out.stage, error: { code: out.code, message: out.message, httpStatus: out.httpStatus }, attempts: (s.videos[next.video.id]?.attempts ?? 0) + 1, updatedAt: iso };
        return { ...s, videos, retry: s.retry.filter((id) => id !== next.video.id), queue: s.queue.filter((id) => id !== next.video.id) };
      });
    }
  }

  const api = {
    subscribe(fn: (s: PrepSnapshot) => void) {
      listeners.add(fn);
      fn(snapshot);
      return () => void listeners.delete(fn);
    },
    getSnapshot: () => snapshot,
    refresh,
    /** 대기열 실행 (이미 실행 중이면 그대로) */
    start(): Promise<void> {
      if (loop) return loop;
      abort = new AbortController();
      const signal = abort.signal;
      loop = (async () => {
        try {
          const got = await withLock(() => runLoop(signal), signal);
          if (!got && !signal.aborted) emit({ status: { kind: 'other_tab' } });
        } catch (e) {
          console.error(e);
          emit({ status: { kind: 'paused', code: 'app_error', message: `자료 생성 중 앱 오류로 멈췄어요: ${e instanceof Error ? e.message : String(e)}`, until: null, httpStatus: null } });
        } finally {
          loop = null;
          abort = null;
        }
      })();
      return loop;
    },
    async stop() {
      abort?.abort();
      await loop;
      emit({ status: { kind: 'idle' } });
    },
    /** 새로 등록한 영상·'학습 시작'한 영상을 대기열 앞에 넣고 시작 */
    async enqueue(videoIds: string[]) {
      if (!videoIds.length) return;
      await deps.store.updatePrep((s) => ({ ...s, queue: [...s.queue, ...videoIds.filter((id) => !s.queue.includes(id))] }));
      await clearServerPause();
      void api.start();
    },
    /** '기존 영상 자료 만들기 시작' — 한 번 누르면 이후 자동 */
    async startAll() {
      await deps.store.updatePrep((s) => ({ ...s, allStarted: true }));
      await clearServerPause();
      void api.start();
    },
    /** '실패만 다시 시도' (videoIds 없으면 실패 전체) */
    async retryFailed(videoIds?: string[]) {
      // 전체 다시 시도는 화면에 '실패'로 보이는 영상만 (자막이 생겨 지난 일이 된 자막 단계 실패는 제외)
      const shown = videoIds ? null : new Set((await refresh()).rows.filter((r) => r.status === 'failed').map((r) => r.video.id));
      await deps.store.updatePrep((s) => {
        const ids = videoIds ?? Object.entries(s.videos).filter(([id, v]) => v.status === 'failed' && shown!.has(id)).map(([id]) => id);
        const videos = { ...s.videos };
        for (const id of ids) delete videos[id];
        return { ...s, videos, retry: [...new Set([...s.retry, ...ids])] };
      });
      await clearServerPause();
      void api.start();
    },
    /** 앱을 열 때 — 할 일이 있으면 이어서 */
    async resume() {
      const { rows } = await refresh();
      if (rows.some((r) => r.status === 'queued')) void api.start();
    },
  };

  /** 사용자가 다시 시작하면: 하루 한도 멈춤은 초기화 시각까지 유지, 서버·연결 문제 멈춤은 풀고 다시 시도 */
  async function clearServerPause() {
    await deps.store.updatePrep((s) =>
      s.pausedUntil && Date.parse(s.pausedUntil) > now().getTime() && (s.pauseReason === 'daily_cap' || s.pauseReason === 'gemini_quota')
        ? s
        : { ...s, pausedUntil: null, pauseReason: null, pauseMessage: null },
    );
  }

  return api;
}

export type PrepController = ReturnType<typeof createPrepController>;
