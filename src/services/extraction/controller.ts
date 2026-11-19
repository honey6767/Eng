import type { ExtractionRunState, ExtractionStore } from '@/repositories/extractionStore';
import { autoApplyPending, retryJob } from './manage';
import { CREATE_GAP_MS, makeJob, pickNext, POLL_MS, RETRY_MS, stepJob, summarize, syncJobs, type JobSummary, type RunnerDeps } from './runner';

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

/** 영상 1개 AI 자막 만들기 진행 상태 (영상 화면의 '자막' 탭에 그대로 보여 준다) */
export type SingleProgress =
  | { phase: 'sending' }
  | { phase: 'processing'; since: string; note?: string }
  | { phase: 'succeeded'; transcriptSaved: boolean; segments: number; keyExpressions: number; applied: boolean; needsReview: boolean; reused: boolean }
  | { phase: 'already' }
  | { phase: 'failed'; httpStatus: number | null; code: string; message: string };

/** 서버에 닿지 못할 때 같은 식별자로 다시 묻는 최대 횟수 (그 뒤에는 화면에 오류를 보여 주고 멈춤 — 다음에 누르면 같은 식별자로 이어서 조회) */
const SINGLE_MAX_TRANSPORT_RETRIES = 3;

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

  async function resultOf(videoId: string, draftId: string, reused: boolean): Promise<SingleProgress> {
    const { transcripts } = await store.readOverview();
    const draft = await store.getDraft(draftId);
    const tr = transcripts.find((t) => t.videoId === videoId && t.status === 'success' && t.segments.length > 0);
    const result = draft?.result as { keyExpressions?: unknown[] } | undefined;
    const applied = draft?.status === 'approved' || draft?.status === 'partially_approved';
    return { phase: 'succeeded', transcriptSaved: !!tr, segments: tr?.segments.length ?? 0, keyExpressions: result?.keyExpressions?.length ?? 0, applied, needsReview: !applied, reused };
  }

  async function runSingle(videoId: string, report: (p: SingleProgress) => SingleProgress, signal?: AbortSignal): Promise<SingleProgress> {
    const overview = await store.readOverview();
    const video = overview.videos.find((v) => v.id === videoId);
    if (!video?.youtubeVideoId) return report({ phase: 'failed', httpStatus: null, code: 'no_video_id', message: 'YouTube 영상 ID가 없어 AI 자막을 만들 수 없어요.' });
    if (overview.transcripts.some((t) => t.videoId === videoId && t.status === 'success' && t.segments.length > 0)) return report({ phase: 'already' });

    let job = overview.jobs.find((j) => j.videoId === videoId);
    if (!job) {
      job = makeJob(video, now().toISOString(), deps.maxVideoSec);
      await store.addJobs([job]);
    }
    if (job.status === 'skipped') return report({ phase: 'failed', httpStatus: null, code: job.lastError?.code ?? 'skipped', message: job.lastError?.message ?? '이 영상은 자동 추출 대상이 아니에요.' });
    if (job.status === 'succeeded' && job.draftId) {
      // 이미 받은 결과 재사용 (Gemini 다시 부르지 않음)
      await autoApplyPending(deps);
      return report(await resultOf(videoId, job.draftId, true));
    }
    if (job.status === 'failed_permanent') {
      await retryJob(deps, job.id);
      job = (await store.getJob(job.id))!;
    }
    // 하루 상한으로 대기 중이면 안내만
    if (job.attemptAfter && Date.parse(job.attemptAfter) > now().getTime()) {
      return report({ phase: 'failed', httpStatus: null, code: job.lastError?.code ?? 'waiting', message: `${job.lastError?.message ?? '하루 한도에 닿았어요.'} (${new Date(job.attemptAfter).toLocaleString('ko-KR')} 이후 다시 시도)` });
    }

    const since = now().toISOString();
    report(job.currentRequestId ? { phase: 'processing', since } : { phase: 'sending' });
    let transportFails = 0;
    const ac = signal ?? new AbortController().signal;
    while (!ac.aborted) {
      const cur = (await store.getJob(job.id))!;
      const out = await stepJob(cur, video, deps);
      if (out.kind === 'pending') {
        transportFails = 0;
        report({ phase: 'processing', since, note: 'Gemini가 영상을 보고 자막을 만드는 중이에요. 보통 1~3분 걸려요.' });
        await sleep(POLL_MS, ac);
        continue;
      }
      if (out.kind === 'retry') {
        transportFails++;
        if (transportFails > SINGLE_MAX_TRANSPORT_RETRIES) {
          return report({ phase: 'failed', httpStatus: out.httpStatus ?? null, code: 'network', message: `${out.message ?? 'AI 서버에 연결하지 못했어요.'} 잠시 뒤 다시 누르면 같은 요청으로 이어서 확인해요(새로 생성하지 않음).` });
        }
        report({ phase: 'processing', since, note: `${out.message ?? '연결이 불안정해요.'} 다시 확인하는 중… (${transportFails}/${SINGLE_MAX_TRANSPORT_RETRIES})` });
        await sleep(RETRY_MS, ac);
        continue;
      }
      if (out.kind === 'done') {
        await autoApplyPending(deps);
        return report(await resultOf(videoId, out.draftId, false));
      }
      if (out.kind === 'pause') {
        if (out.until) await setRun({ pausedUntil: out.until, pauseReason: out.reason, pauseMessage: out.message });
        return report({ phase: 'failed', httpStatus: out.httpStatus ?? null, code: out.code ?? out.reason, message: out.message });
      }
      return report({ phase: 'failed', httpStatus: out.httpStatus ?? null, code: out.code, message: out.message ?? '자막을 만들지 못했어요.' });
    }
    return report({ phase: 'failed', httpStatus: null, code: 'cancelled', message: '멈췄어요. 다시 누르면 같은 요청으로 이어서 확인해요.' });
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
    /**
     * 영상 1개만 AI 자막 만들기 (사용자가 영상 화면에서 누름).
     * - 이미 자막(내용 있음)이 있으면 요청하지 않는다.
     * - 이미 받은 결과(초안)가 있으면 Gemini를 다시 부르지 않고 그 결과를 적용한다.
     * - 실패로 멈춘 영상은 사용자가 눌렀으므로 한 번 더 요청한다(새 식별자). 진행 중이던 요청은 같은 식별자로 조회만 한다.
     * - 전체 자동 추출이 돌고 있으면 잠시 멈추고 이 영상을 먼저 한 뒤, 다시 이어 간다.
     */
    async extractOne(videoId: string, onProgress: (p: SingleProgress) => void, signal?: AbortSignal): Promise<SingleProgress> {
      const report = (p: SingleProgress) => {
        onProgress(p);
        return p;
      };
      const wasRunning = !!loop;
      if (wasRunning) {
        abort?.abort();
        await loop;
      }
      let final: SingleProgress | null = null;
      const finish = async () => {
        await refresh();
        if (wasRunning) void this.start();
      };
      try {
        const got = await withLock(async () => {
          final = await runSingle(videoId, report, signal);
        }, undefined, signal);
        if (!got) final = report({ phase: 'failed', httpStatus: null, code: 'other_tab', message: '다른 탭에서 자막 추출이 진행 중이에요. 그 탭을 닫고 다시 눌러 주세요.' });
      } catch (e) {
        final = report({ phase: 'failed', httpStatus: null, code: 'app_error', message: `앱에서 오류가 났어요: ${e instanceof Error ? e.message : String(e)}` });
      }
      await finish();
      return final ?? report({ phase: 'failed', httpStatus: null, code: 'cancelled', message: '멈췄어요.' });
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
