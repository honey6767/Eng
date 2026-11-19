import type { PrepState } from '@/repositories/contentStore';
import { nextPacificMidnight } from '@/utils/pacific';
import { computeRows, processVideo, summarizeRows, type PrepDeps, type PrepRow, type PrepStage, type PrepSummary } from './prepRunner';

/** Gemini가 처리하다 실패한 경우 — 다음 영상도 줄줄이 실패하지 않게 대기열을 멈춘다 (사용자가 '이어서 만들기'를 누를 때까지) */
const SERVICE_FAIL_CODES = new Set(['gemini_failed', 'gemini_rejected', 'unknown']);

/**
 * 학습 자료 자동 생성 실행 관리 — 시작·멈춤·이어하기, 화면에 보여 줄 상태.
 * - 한 탭에서만 실행 (Web Locks 'mes-extraction' — 기존 자막 추출과 같은 잠금이라 둘이 동시에 돌지 않음)
 * - 앱을 열 때 resume(): 대기 중인 영상이나 진행 중이던 요청이 있으면 이어서
 * - 하루 한도로 멈췄으면 초기화 시각에 (앱이 열려 있으면) 자동으로 다시 시작
 * - 자동 준비 몫(하루 실제 요청 수)을 다 쓰면 자동 영상만 멈추고, 사용자가 직접 넣은 영상은 계속
 * - Google 한도 초과로 보류된 영상은 초기화 뒤 먼저, 1번만 이어서 (또 보류되면 실패로 두고 사용자가 다시 시도)
 * - Gemini 처리 실패는 그 영상만 실패로 두고(자동 재시도 없음) 대기열을 멈춘다
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
      const t = now().getTime();
      if (state.stopped) {
        emit({ status: { kind: 'paused', code: 'stopped', message: state.stopped.message, until: null, httpStatus: null } });
        return;
      }
      if (state.pausedUntil && Date.parse(state.pausedUntil) > t) {
        emit({ status: { kind: 'paused', code: state.pauseReason ?? 'daily_cap', message: state.pauseMessage ?? '', until: state.pausedUntil, httpStatus: null } });
        scheduleWake(state.pausedUntil);
        return;
      }
      const manual = new Set(state.manual ?? []);
      const held = state.held ?? {};
      const autoPaused = !!state.autoPausedUntil && Date.parse(state.autoPausedUntil) > t;
      const queued = rows.filter((r) => r.status === 'queued');
      const pickable = queued.filter((r) => !autoPaused || manual.has(r.video.id));
      // 한도 초과로 보류됐던 영상을 먼저 이어서
      const next = pickable.find((r) => (held[r.video.id] ?? 0) > 0) ?? pickable[0];
      if (!next) {
        if (queued.length && autoPaused) {
          emit({ status: { kind: 'paused', code: 'auto_cap', message: '오늘 자동 준비 몫을 다 썼어요. 직접 누르는 작업은 계속할 수 있어요.', until: state.autoPausedUntil!, httpStatus: null } });
          scheduleWake(state.autoPausedUntil!);
          return;
        }
        emit({ status: { kind: 'done' } });
        return;
      }
      const id = next.video.id;
      const auto = !manual.has(id);
      const since = now().toISOString();
      const retry = state.retry.includes(id);
      emit({ status: { kind: 'running', videoId: id, title: next.video.title, stage: next.stage, since } });
      const out = await processVideo(next, deps, retry, (n) => emit({ status: { kind: 'running', videoId: id, title: next.video.title, stage: n.stage, since, note: n.note } }), signal, auto);
      const iso = now().toISOString();
      if (out.kind === 'pause') {
        if (out.code === 'cancelled') return;
        if (out.code === 'auto_cap') {
          // 자동 영상만 초기화 시각까지 멈춤 — 사용자가 넣은 영상이 있으면 계속
          await deps.store.updatePrep((s) => ({ ...s, autoPausedUntil: out.until ?? nextPacificMidnight(now().getTime()) }));
          continue;
        }
        const until = out.until ?? (out.code === 'daily_cap' || out.code === 'gemini_quota' ? iso : null);
        await deps.store.updatePrep((s) => {
          let next2: PrepState = { ...s, pausedUntil: until, pauseReason: out.code, pauseMessage: out.message };
          if (out.code === 'gemini_quota') {
            // 보류 1번째: 초기화 뒤 이어서 / 2번째: 더 이어서 보내지 않고 실패로 (사용자가 다시 시도)
            const heldNow = { ...(s.held ?? {}) };
            const n = (heldNow[id] ?? 0) + 1;
            if (n >= 2) {
              delete heldNow[id];
              const videos = { ...s.videos, [id]: { status: 'failed' as const, stage: next.stage === 'done' ? 'pack' : next.stage, error: { code: 'gemini_quota', message: `Gemini 한도 초과로 두 번 보류돼 자동으로 이어서 보내지 않아요. 초기화 시각 이후 '다시 시도'를 눌러 주세요. (${out.message})`, httpStatus: out.httpStatus }, attempts: (s.videos[id]?.attempts ?? 0) + 1, updatedAt: iso } };
              next2 = { ...next2, held: heldNow, videos, queue: s.queue.filter((x) => x !== id), retry: s.retry.filter((x) => x !== id), manual: (s.manual ?? []).filter((x) => x !== id) };
            } else next2 = { ...next2, held: { ...heldNow, [id]: n } };
          }
          return next2;
        });
        emit({ status: { kind: 'paused', code: out.code, message: out.message, until: out.until, httpStatus: out.httpStatus } });
        await refresh();
        scheduleWake(out.until);
        return;
      }
      const stop = out.kind === 'fail' && SERVICE_FAIL_CODES.has(out.code);
      await deps.store.updatePrep((s) => {
        const videos = { ...s.videos };
        const heldNow = { ...(s.held ?? {}) };
        delete heldNow[id];
        if (out.kind === 'ok') delete videos[id];
        else videos[id] = { status: out.skip ? 'skipped' : 'failed', stage: out.stage, error: { code: out.code, message: out.message, httpStatus: out.httpStatus }, attempts: (s.videos[id]?.attempts ?? 0) + 1, updatedAt: iso };
        return {
          ...s, videos, held: heldNow, retry: s.retry.filter((x) => x !== id), queue: s.queue.filter((x) => x !== id), manual: (s.manual ?? []).filter((x) => x !== id),
          ...(stop ? { stopped: { code: out.code, message: `Gemini 처리 실패로 자동 생성을 멈췄어요 (${next.video.title}). 실패한 영상은 자동으로 다시 보내지 않아요. 원인을 확인한 뒤 '이어서 만들기'를 눌러 주세요.`, at: iso } } : {}),
        };
      });
      if (stop) {
        await refresh();
        const st = (await deps.store.getPrep()).stopped!;
        emit({ status: { kind: 'paused', code: 'stopped', message: st.message, until: null, httpStatus: null } });
        return;
      }
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
    async enqueue(videoIds: string[], opts: { manual?: boolean } = {}) {
      if (!videoIds.length) return;
      await deps.store.updatePrep((s) => ({
        ...s,
        queue: [...s.queue, ...videoIds.filter((id) => !s.queue.includes(id))],
        // 사용자가 직접 넣은 영상은 자동 준비 몫으로 세지 않는다
        manual: opts.manual ? [...new Set([...(s.manual ?? []), ...videoIds])] : (s.manual ?? []),
      }));
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
        const heldNow = { ...(s.held ?? {}) };
        for (const id of ids) {
          delete videos[id];
          delete heldNow[id];
        }
        // 다시 시도는 사용자가 누른 작업
        return { ...s, videos, held: heldNow, retry: [...new Set([...s.retry, ...ids])], manual: [...new Set([...(s.manual ?? []), ...ids])] };
      });
      await clearServerPause();
      void api.start();
    },
    /** Gemini 처리 실패로 멈춘 대기열을 사용자가 이어서 (실패한 영상은 다시 보내지 않음) */
    async continueQueue() {
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
        ? { ...s, stopped: null }
        : { ...s, pausedUntil: null, pauseReason: null, pauseMessage: null, stopped: null },
    );
  }

  return api;
}

export type PrepController = ReturnType<typeof createPrepController>;
