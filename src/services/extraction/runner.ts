import type { ExtractionStore, ExtractionRunState } from '@/repositories/extractionStore';
import type { AiClient } from '@/services/integrations/aiClient';
import { AI_PROMPT_VERSION, type AiExtractResponse } from '@/types/aiApi';
import type { AiRequest, ExtractionDraft, ExtractionJob, Video } from '@/types/models';
import { validateExtraction } from './validateResult';

/**
 * 자동 자막 추출 실행기 — 한 번에 한 영상씩, 백그라운드로.
 *
 * 원칙
 * - 영상마다 요청 식별자를 하나만 쓴다. 결과 조회는 같은 식별자로 다시 묻는 것이다(서버가 Gemini를 다시 생성하지 않음).
 * - 새 식별자는 Gemini가 처리하지 않은 것이 확실할 때(consumed=false: 하루 상한·무료 한도 429·거절)만 만든다.
 *   결과를 모르거나 Gemini가 실패한 영상은 '확인 필요'로 두고 자동으로 다시 요청하지 않는다.
 * - 이미 자막이 있거나 초안이 저장된 영상은 Gemini를 부르지 않는다 (저장된 결과 재사용).
 * - 무료 한도·하루 상한에 닿으면 유료 전환 없이 멈추고, 다음 초기화 시각 이후 이어서 한다.
 * - 쓰기는 새 테이블과 appMeta 'extractionRun'에만 (ExtractionStore).
 */

/** 앱이 자동 처리하는 최대 영상 길이 (서버 기본값과 같음). 더 긴 영상은 '긴 영상'으로 표시만 */
export const MAX_AUTO_VIDEO_SEC = 30 * 60;
/** 결과 조회 간격·연결 실패 시 다시 물어볼 간격 */
export const POLL_MS = 15_000;
export const RETRY_MS = 30_000;
/** 생성 요청 사이 최소 간격 (무료 등급 분당 요청 수 보호) */
export const CREATE_GAP_MS = 15_000;
/** 서버 장부 보관 기간(7일)보다 짧게 — 이보다 오래된 요청은 다시 묻지 않는다 */
export const STALE_REQUEST_MS = 6 * 24 * 3_600_000;

export interface RunnerDeps {
  store: ExtractionStore;
  client: AiClient;
  now?: () => Date;
  newId?: () => string;
  maxVideoSec?: number;
}

const PACIFIC = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
export const pacificDate = (d: Date) => PACIFIC.format(d);

export type JobSummary = {
  total: number;
  succeeded: number;
  queued: number;
  running: number;
  needsAttention: number;
  longVideos: number;
  skipped: number;
};

const jobId = (videoId: string) => `job-${videoId}`;

/** 자막이 없는 영상마다 작업을 만든다 (이미 있으면 그대로). 긴 영상·길이를 모르는 영상은 건너뜀으로 기록 */
export async function syncJobs(deps: RunnerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const max = deps.maxVideoSec ?? MAX_AUTO_VIDEO_SEC;
  const { videos, transcripts, jobs } = await deps.store.readOverview();
  const hasTranscript = new Set(transcripts.filter((t) => t.status === 'success').map((t) => t.videoId));
  const hasJob = new Set(jobs.map((j) => j.videoId));
  const add: ExtractionJob[] = [];
  for (const v of videos) {
    if (v.isSample || !v.youtubeVideoId || hasTranscript.has(v.id) || hasJob.has(v.id)) continue;
    const tooLong = typeof v.durationSec === 'number' && v.durationSec > max;
    const noDuration = !(typeof v.durationSec === 'number' && v.durationSec > 0);
    add.push({
      id: jobId(v.id), videoId: v.id, status: tooLong || noDuration ? 'skipped' : 'queued', attempts: 0, attemptAfter: null,
      lastError: tooLong ? { code: 'too_long', message: `${Math.round(max / 60)}분이 넘는 긴 영상이라 자동 추출하지 않아요.` } : noDuration ? { code: 'no_duration', message: '영상 길이를 몰라 자동 추출하지 않아요.' } : null,
      currentRequestId: null, segments: [], leaseOwner: null, leaseUntil: null, model: null, apiStyle: 'interactions', promptVersion: AI_PROMPT_VERSION,
      videoDurationSec: v.durationSec ?? null, draftId: null, createdAt: now, updatedAt: now,
    });
  }
  await deps.store.addJobs(add);
}

export async function summarize(store: ExtractionStore): Promise<JobSummary> {
  const { jobs, drafts } = await store.readOverview();
  const reviewDrafts = drafts.filter((d) => d.status === 'pending_review').length;
  const c = (f: (j: ExtractionJob) => boolean) => jobs.filter(f).length;
  return {
    total: jobs.length,
    succeeded: c((j) => j.status === 'succeeded'),
    queued: c((j) => j.status === 'queued' || j.status === 'failed_retryable'),
    running: c((j) => j.status === 'running'),
    // 실패한 영상 + 품질 문제로 자동 적용하지 않은 초안
    needsAttention: c((j) => j.status === 'failed_permanent') + reviewDrafts,
    longVideos: c((j) => j.status === 'skipped' && j.lastError?.code === 'too_long'),
    skipped: c((j) => j.status === 'skipped'),
  };
}

/** 다음에 처리할 작업: 진행 중(조회할 요청이 있는 것) 먼저, 그다음 대기 중 (재생목록 순서) */
export async function pickNext(store: ExtractionStore, now: Date): Promise<{ job: ExtractionJob; video: Video } | null> {
  const { videos, jobs } = await store.readOverview();
  const byId = new Map(videos.map((v) => [v.id, v]));
  const order = (j: ExtractionJob) => byId.get(j.videoId)?.orderIndex ?? Number.MAX_SAFE_INTEGER;
  const ready = (j: ExtractionJob) => !j.attemptAfter || Date.parse(j.attemptAfter) <= now.getTime();
  const running = jobs.filter((j) => j.status === 'running' && j.currentRequestId).sort((a, b) => order(a) - order(b));
  const queued = jobs.filter((j) => (j.status === 'queued' || j.status === 'failed_retryable') && ready(j)).sort((a, b) => order(a) - order(b));
  for (const job of [...running, ...queued]) {
    const video = byId.get(job.videoId);
    if (video?.youtubeVideoId && video.durationSec) return { job, video };
  }
  return null;
}

export type StepOutcome =
  /** 진행 중 — 잠시 뒤 같은 식별자로 다시 조회 */
  | { kind: 'pending'; created: boolean }
  /** 초안 저장 완료 */
  | { kind: 'done'; draftId: string }
  /** 이 영상만 멈춤 ('확인 필요' 또는 건너뜀) — 다음 영상으로 */
  | { kind: 'job_stopped'; code: string }
  /** 서버에 닿지 못함 — 같은 식별자로 나중에 다시 */
  | { kind: 'retry' }
  /** 전체를 멈춰야 함 (하루 한도·무료 한도·접근 코드·서버 설정) */
  | { kind: 'pause'; reason: NonNullable<ExtractionRunState['pauseReason']>; until: string | null; message: string };

/** 한 작업을 한 걸음 진행한다 (요청 1번) */
export async function stepJob(job: ExtractionJob, video: Video, deps: RunnerDeps): Promise<StepOutcome> {
  const clock = deps.now ?? (() => new Date());
  const t = clock();
  const iso = t.toISOString();
  let created = false;
  let req: AiRequest | undefined = job.currentRequestId ? await deps.store.getRequest(job.currentRequestId) : undefined;

  if (!req) {
    // 새 요청 — 식별자를 먼저 기기에 저장한 뒤 보낸다
    req = {
      id: (deps.newId ?? (() => crypto.randomUUID()))(), jobId: job.id, videoId: video.id, status: 'reserved', bodyHash: null, interactionId: null,
      estVideoSec: video.durationSec, estTokens: video.durationSec ? video.durationSec * 100 : null, inputTokens: null, sentAt: null, finishedAt: null,
      pacificDate: pacificDate(t), httpStatus: null, errorCode: null, responseHash: null, createdAt: iso, updatedAt: iso,
    };
    job = { ...job, status: 'running', currentRequestId: req.id, attempts: job.attempts + 1, attemptAfter: null, lastError: null, updatedAt: iso };
    await deps.store.beginRequest(job, req);
    created = true;
  }
  // 서버 장부는 기록을 7일 보관한다. 그보다 오래된 식별자로 다시 물으면 서버가 새 요청으로 볼 수 있으므로
  // 묻지 않고 '결과 만료'로 처리한다 (같은 영상 두 번 생성 방지)
  if (req.status === 'sent' && req.sentAt && t.getTime() - Date.parse(req.sentAt) > STALE_REQUEST_MS) {
    const iso3 = t.toISOString();
    await deps.store.saveResult(
      { ...job, status: 'failed_permanent', lastError: { code: 'expired', message: '오래전에 보낸 요청이라 결과를 확인할 수 없어요.' }, updatedAt: iso3 },
      { ...req, status: 'failed_unknown', errorCode: 'expired', finishedAt: iso3, updatedAt: iso3 },
      null,
    );
    return { kind: 'job_stopped', code: 'expired' };
  }
  if (req.status === 'reserved') {
    req = { ...req, status: 'sent', sentAt: iso, updatedAt: iso };
    await deps.store.putRequest(req);
  }

  const r = await deps.client.extract(req.id, { videoId: video.youtubeVideoId!, durationSec: video.durationSec!, promptVersion: AI_PROMPT_VERSION });
  const iso2 = clock().toISOString();
  if (r.kind === 'transport_error') return { kind: 'retry' };
  if (r.kind === 'auth_error') return { kind: 'pause', reason: 'auth', until: null, message: r.message };
  const body: AiExtractResponse = r.body;

  if (body.state === 'pending') {
    if (body.interactionId && body.interactionId !== req.interactionId) await deps.store.putRequest({ ...req, interactionId: body.interactionId, updatedAt: iso2 });
    return { kind: 'pending', created };
  }

  if (body.state === 'succeeded') {
    const v = validateExtraction(body.resultText, video.durationSec!);
    const doneReq: AiRequest = { ...req, status: 'succeeded', interactionId: body.interactionId, inputTokens: body.usage?.inputTokens ?? null, finishedAt: iso2, httpStatus: r.httpStatus, updatedAt: iso2 };
    if (!v.ok) {
      // 깨진 응답: 초안으로 저장하지 않고 '확인 필요'. Gemini는 이미 처리했으므로 자동으로 다시 요청하지 않는다
      await deps.store.saveResult({ ...job, status: 'failed_permanent', lastError: { code: 'invalid_result', message: v.error }, updatedAt: iso2 }, { ...doneReq, errorCode: 'invalid_result' }, null);
      return { kind: 'job_stopped', code: 'invalid_result' };
    }
    const draft: ExtractionDraft = {
      id: `draft-${req.id}`, videoId: video.id, jobId: job.id, requestId: req.id, status: 'pending_review', result: v.result, rawText: body.resultText,
      model: body.model, usage: body.usage, rejectedSegments: v.rejectedSegments, edited: null, validation: v.issues, approvedRefs: [], createdAt: iso2, updatedAt: iso2,
    };
    await deps.store.saveResult({ ...job, status: 'succeeded', draftId: draft.id, model: body.model, lastError: null, updatedAt: iso2 }, doneReq, draft);
    return { kind: 'done', draftId: draft.id };
  }

  // 실패
  const reqStatus: AiRequest['status'] = body.consumed ? 'failed_unknown' : 'failed_definite';
  const failedReq: AiRequest = { ...req, status: reqStatus, errorCode: body.code, httpStatus: r.httpStatus, finishedAt: iso2, updatedAt: iso2 };
  const err = { code: body.code, message: body.message };
  if (!body.consumed) {
    if (body.code === 'daily_cap' || body.code === 'gemini_quota') {
      // 처리 안 됨 → 이 영상은 대기열로 되돌리고(다음에 새 식별자), 전체는 초기화 시각까지 멈춤
      await deps.store.saveResult({ ...job, status: 'queued', currentRequestId: null, attemptAfter: body.retryAt ?? null, lastError: err, updatedAt: iso2 }, failedReq, null);
      return { kind: 'pause', reason: body.code, until: body.retryAt ?? null, message: body.message };
    }
    if (body.code === 'too_long') {
      await deps.store.saveResult({ ...job, status: 'skipped', currentRequestId: null, lastError: err, updatedAt: iso2 }, failedReq, null);
      return { kind: 'job_stopped', code: body.code };
    }
    if (body.code === 'gemini_not_configured' || body.code === 'ledger_unavailable' || body.code === 'bad_request') {
      await deps.store.saveResult({ ...job, status: 'queued', currentRequestId: null, lastError: err, updatedAt: iso2 }, failedReq, null);
      return { kind: 'pause', reason: 'server', until: null, message: body.message };
    }
  }
  // Gemini 거절(비공개 등)·결과 모름·Gemini 실패·만료 → 이 영상만 '확인 필요' (자동 재요청 없음)
  await deps.store.saveResult({ ...job, status: 'failed_permanent', lastError: err, updatedAt: iso2 }, failedReq, null);
  return { kind: 'job_stopped', code: body.code };
}
