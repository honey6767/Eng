import type { ExtractionRunState, ExtractionStore } from '@/repositories/extractionStore';
import { autoApplyPending } from './manage';
import { CREATE_GAP_MS, pickNext, POLL_MS, RETRY_MS, stepJob, summarize, syncJobs, type JobSummary, type RunnerDeps } from './runner';

/**
 * 자동 추출 실행 관리 — 시작·멈춤·이어하기, 화면에 보여 줄 상태.
 *
 * - 한 탭에서만 실행한다 (Web Locks 'mes-extraction'). 다른 탭은 상태만 본다.
 * - 진행 상태는 모두 IndexedDB에 있어서, 앱을 닫았다 열면 resumeIfActive()가 같은 식별자로 조회부터 이어 간다.
 * - 네트워크가 돌아오면(online) 다시 시작한다.
 */

export type ControllerStatus =
  | { kind: 'idle' }
  | { kind: 'running'; message: string }
  | { kind: 'paused'; reason: NonNullable<ExtractionRunState['pauseReason']>; message: string; until: string | null }
  | { kind: 'other_tab' }
  | { kind: 'done' };

export interface ControllerSnapshot {
  status: ControllerStatus;
  summary: JobSummary | null;
}

export interface ControllerDeps extends RunnerDeps {
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 한 탭만 실행: 잠금을 얻으면 fn을 실행하고 true, 다른 탭이 잡고 있으면 false */
  withLock?: (fn: () => Promise<void>, onWait?: () => void, signal?: AbortSignal) => Promise<boolean>;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * 한 탭만 실행: 잠금이 비어 있으면 바로 실행, 다른 탭이 잡고 있으면 onWait를 알리고 그 탭이 끝날(닫힐) 때까지 기다렸다 이어받는다.
 * (새로고침 직후에는 이전 페이지가 잠깐 잠금을 쥐고 있을 수 있다)
 */
const defaultLock = async (fn: () => Promise<void>, onWait?: () => void, signal?: AbortSignal) => {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks) {
    await fn();
    return true;
  }
  let got = false;
  await locks.request('mes-extraction', { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    got = true;
    await fn();
  });
  if (got) return true;
  onWait?.();
  try {
    await locks.request('mes-extraction', { signal }, async () => {
      got = true;
      await fn();
    });
  } catch {
    /* 사용자가 멈춤 → 기다리기 취소 */
  }
  return got;
};

export function createExtractionController(deps: ControllerDeps) {
  const sleep = deps.sleep ?? defaultSleep;
  const withLock = deps.withLock ?? defaultLock;
  const now = deps.now ?? (() => new Date());
  let snapshot: ControllerSnapshot = { status: { kind: 'idle' }, summary: null };
  const listeners = new Set<(s: ControllerSnapshot) => void>();
  let loop: Promise<void> | null = null;
  let abort: AbortController | null = null;

  const emit = (patch: Partial<ControllerSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const l of listeners) l(snapshot);
  };
  const refresh = async () => emit({ summary: await summarize(deps.store) });
  const store: ExtractionStore = deps.store;

  async function setRun(patch: Partial<ExtractionRunState>) {
    const cur = (await store.getRun()) ?? { active: false, startedAt: null, pausedUntil: null, pauseReason: null, pauseMessage: null, updatedAt: now().toISOString() };
    await store.putRun({ ...cur, ...patch, updatedAt: now().toISOString() });
  }

  async function runLoop(signal: AbortSignal) {
    await syncJobs(deps);
    // 이전에 저장만 되고 아직 적용되지 않은 초안 중 품질이 괜찮은 것은 먼저 학습 자료로
    await autoApplyPending(deps);
    await refresh();
    let lastCreate = 0;
    while (!signal.aborted) {
      const run = await store.getRun();
      if (run?.pausedUntil && Date.parse(run.pausedUntil) > now().getTime()) {
        emit({ status: { kind: 'paused', reason: run.pauseReason ?? 'daily_cap', message: run.pauseMessage ?? '', until: run.pausedUntil } });
        return;
      }
      const next = await pickNext(store, now());
      if (!next) {
        await setRun({ active: false, pausedUntil: null, pauseReason: null, pauseMessage: null });
        await refresh();
        emit({ status: { kind: 'done' } });
        return;
      }
      // 새 생성 요청이면 간격을 지킨다
      if (!next.job.currentRequestId) {
        const wait = lastCreate + CREATE_GAP_MS - now().getTime();
        if (wait > 0) await sleep(wait, signal);
        if (signal.aborted) return;
      }
      emit({ status: { kind: 'running', message: next.video.title } });
      const out = await stepJob(next.job, next.video, deps);
      if (out.kind === 'pending' && out.created) lastCreate = now().getTime();
      // B1-d: 결과가 나오면 품질 판정 후 자동으로 학습 자료에 연결 (문제가 있으면 '확인 필요'로 남김)
      if (out.kind === 'done') await autoApplyPending(deps);
      await refresh();
      if (out.kind === 'pause') {
        await setRun({ pausedUntil: out.until, pauseReason: out.reason, pauseMessage: out.message });
        emit({ status: { kind: 'paused', reason: out.reason, message: out.message, until: out.until } });
        return;
      }
      if (out.kind === 'pending') await sleep(POLL_MS, signal);
      else if (out.kind === 'retry') await sleep(RETRY_MS, signal);
    }
  }

  return {
    subscribe(fn: (s: ControllerSnapshot) => void) {
      listeners.add(fn);
      fn(snapshot);
      return () => void listeners.delete(fn);
    },
    getSnapshot: () => snapshot,
    refresh,
    /** 사용자가 학습을 시작했을 때 — 자막이 없는 영상의 추출을 백그라운드로 시작 (이미 실행 중이면 그대로) */
    async start(): Promise<void> {
      if (loop) return loop;
      const run = await store.getRun();
      // 하루 한도로 멈춘 상태가 아직 안 풀렸으면 시작만 기록하고 기다린다
      await setRun({ active: true, startedAt: run?.startedAt ?? now().toISOString(), ...(run?.pausedUntil && Date.parse(run.pausedUntil) <= now().getTime() ? { pausedUntil: null, pauseReason: null, pauseMessage: null } : {}) });
      if (run?.pauseReason === 'auth' || run?.pauseReason === 'server') await setRun({ pausedUntil: null, pauseReason: null, pauseMessage: null });
      abort = new AbortController();
      const signal = abort.signal;
      loop = (async () => {
        try {
          const got = await withLock(() => runLoop(signal), () => emit({ status: { kind: 'other_tab' } }), signal);
          if (!got && !signal.aborted) emit({ status: { kind: 'other_tab' } });
        } catch (e) {
          console.error(e);
          emit({ status: { kind: 'paused', reason: 'server', message: '자동 추출 중 문제가 생겨 멈췄어요. 학습 시작을 다시 누르면 이어서 해요.', until: null } });
        } finally {
          loop = null;
          abort = null;
        }
      })();
      return loop;
    },
    /** 사용자가 멈춤 — 진행 중인 요청 기록은 그대로 두어 다음에 같은 식별자로 이어 간다 */
    async stop(): Promise<void> {
      abort?.abort();
      await loop;
      await setRun({ active: false });
      emit({ status: { kind: 'idle' } });
    },
    /** 앱을 열 때 — 이전에 시작해 끝나지 않은 작업이 있으면 이어 간다 */
    async resumeIfActive(): Promise<void> {
      const run = await store.getRun();
      if (run?.active) await this.start();
      else await refresh();
    },
  };
}

export type ExtractionController = ReturnType<typeof createExtractionController>;
