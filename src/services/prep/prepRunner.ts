import type { ContentStore, PrepOverview, PrepState, PrepVideoState } from '@/repositories/contentStore';
import type { ExtractionStore } from '@/repositories/extractionStore';
import type { AiClient } from '@/services/integrations/aiClient';
import type { Expression, Video } from '@/types/models';
import { markApplied, runAiTask } from '@/services/ai/taskRunner';
import { autoApplyPending, retryJob } from '@/services/extraction/manage';
import { makeJob, POLL_MS, RETRY_MS, stepJob } from '@/services/extraction/runner';
import { hasContent, seriesOf, transcriptText } from '@/services/content/contentService';
import { parseDayNumber } from '@/db/upgradeV2toV3';
import { createId } from '@/utils/id';
import { nextPacificMidnight } from '@/utils/pacific';
import { aiSentencesOf, buildDayPackRequest, buildPackRequest, hasDayDialogue, planPack, validateDayPack, validatePack } from './packService';

/**
 * 학습 자료 자동 생성 대기열 — 한 번에 한 영상씩, 앱이 열려 있는 동안 백그라운드로.
 *
 * 영상 1개의 단계 (이미 있는 단계는 건너뜀 = 누락분만 보완)
 *  ① 자막: 기기에 저장된 자막 → 없으면 AI 자막 (기존 자막 추출과 같은 작업·같은 요청 식별자 규칙)
 *  ② 학습 자료: 문장이 없으면 pack(자막 → 문장·Chunk·공통 Chunk·Day 대화문), 문장이 있으면 daypack(문장 → 공통 Chunk·Day 대화문)
 *  ③ 빈칸 자료: ②를 저장할 때 기기에서 계산 (AI 없음)
 *
 * - 대상: '기존 영상 자료 만들기 시작'을 누른 뒤의 모든 영상 + 새로 등록한 영상 + 진행 중이던 요청이 있는 영상
 * - 요청 식별자·보낸 내용은 기기에 먼저 저장 → 앱을 닫았다 열면 같은 식별자로 이어서 확인 (새로 생성하지 않음)
 * - 서버가 같은 작업은 한 번만 생성하고 결과를 보관 → 다른 기기도 같은 결과를 받는다
 * - 하루 상한·무료 한도·서버 문제는 대기열 전체를 멈춤, 영상 문제(거절·결과 모름·품질)는 그 영상만 '실패'
 */

export type PrepStage = 'transcript' | 'pack' | 'daypack' | 'done';
export type PrepRowStatus = 'ready' | 'queued' | 'failed' | 'skipped' | 'not_queued';

export interface PrepRow {
  video: Video;
  dayNumber: number | null;
  stage: PrepStage;
  status: PrepRowStatus;
  failure: PrepVideoState | null;
  /** 이전에 보낸 요청이 진행 중 (먼저 이어서 확인) */
  inflight: boolean;
}

export interface PrepSummary {
  total: number;
  ready: number;
  queued: number;
  failed: number;
  skipped: number;
  notQueued: number;
}

const hasTranscript = (ov: PrepOverview, videoId: string) =>
  ov.transcripts.some((t) => t.videoId === videoId && t.status === 'success' && (t.segments.length > 0 || t.rawText.trim().length > 0));

export function computeRows(ov: PrepOverview, st: PrepState): PrepRow[] {
  const dayByVideo = new Map(ov.days.map((d) => [d.videoId, d.dayNumber]));
  const rows: PrepRow[] = [];
  for (const v of ov.videos) {
    if (v.isSample || !v.youtubeVideoId) continue;
    const sentences = ov.sentences.filter((s) => s.videoId === v.id);
    const items = ov.items.filter((i) => i.videoId === v.id);
    const stage: PrepStage = hasDayDialogue(ov.dialogues, v.id) ? 'done' : hasContent(sentences, items) && aiSentencesOf(sentences).length > 0 ? 'daypack' : hasTranscript(ov, v.id) ? 'pack' : 'transcript';
    const job = ov.jobs.find((j) => j.videoId === v.id);
    const inflight = stage === 'transcript' && job?.status === 'running' && !!job.currentRequestId;
    const failure = st.videos[v.id] ?? null;
    const retrying = st.retry.includes(v.id);
    const inQueue = st.allStarted || st.queue.includes(v.id) || inflight || retrying;
    const status: PrepRowStatus = stage === 'done' ? 'ready' : failure && !retrying ? failure.status : inQueue ? 'queued' : 'not_queued';
    rows.push({ video: v, dayNumber: dayByVideo.get(v.id) ?? parseDayNumber(v.title), stage, status, failure: stage === 'done' ? null : failure, inflight });
  }
  // 처리 순서: 진행 중이던 요청 → 새로 넣은 영상(넣은 순서) → Day 번호 순 → 일반 영상(등록 순서)
  const q = new Map(st.queue.map((id, i) => [id, i]));
  return rows.sort(
    (a, b) =>
      Number(b.inflight) - Number(a.inflight) ||
      (q.get(a.video.id) ?? 1e9) - (q.get(b.video.id) ?? 1e9) ||
      (a.dayNumber ?? 1e6) - (b.dayNumber ?? 1e6) ||
      a.video.orderIndex - b.video.orderIndex,
  );
}

export function summarizeRows(rows: PrepRow[]): PrepSummary {
  const c = (s: PrepRowStatus) => rows.filter((r) => r.status === s).length;
  return { total: rows.length, ready: c('ready'), queued: c('queued'), failed: c('failed'), skipped: c('skipped'), notQueued: c('not_queued') };
}

// ─────────────────────────────────────────────
// 영상 1개 처리
// ─────────────────────────────────────────────

export type StepNote = { stage: PrepStage; note?: string };

export type VideoOutcome =
  | { kind: 'ok' }
  /** 이 영상만 실패/건너뜀 → 다음 영상으로 */
  | { kind: 'fail'; stage: PrepVideoState['stage']; skip?: boolean; code: string; message: string; httpStatus: number | null }
  /** 대기열 전체를 멈춤 (하루 한도·무료 한도·접근 코드·서버 설정·연결) */
  | { kind: 'pause'; code: string; message: string; until: string | null; httpStatus: number | null };

export interface PrepDeps {
  store: ContentStore;
  extraction: ExtractionStore;
  client: AiClient;
  now?: () => Date;
  newId?: () => string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 학습 자료 조회 간격 (기본 5초) */
  pollMs?: number;
  /** 자막 추출 조회 간격 (기본 15초) */
  extractPollMs?: number;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/** 대기열 전체를 멈춰야 하는 오류 */
const PAUSE_CODES = new Set(['daily_cap', 'gemini_quota', 'auth', 'gemini_not_configured', 'ledger_unavailable', 'bad_request', 'network', 'server', 'cancelled']);

function pauseFor(code: string, message: string, httpStatus: number | null, now: Date, until?: string | null): VideoOutcome {
  const reset = code === 'daily_cap' || code === 'gemini_quota' ? (until ?? nextPacificMidnight(now.getTime())) : null;
  return { kind: 'pause', code, message, until: reset, httpStatus };
}

async function runTranscript(video: Video, deps: PrepDeps, retry: boolean, onNote: (n: StepNote) => void, signal?: AbortSignal): Promise<VideoOutcome> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const ex = deps.extraction;
  const rdeps = { store: ex, client: deps.client, now: deps.now, newId: deps.newId };
  const id = `job-${video.id}`;
  let job = await ex.getJob(id);
  if (!job) {
    job = makeJob(video, now().toISOString());
    await ex.addJobs([job]);
  }
  if (job.status === 'skipped') return { kind: 'fail', stage: 'transcript', skip: true, code: job.lastError?.code ?? 'skipped', message: `${job.lastError?.message ?? '자동 처리 대상이 아니에요.'} 자막 탭에서 자막을 붙여 넣으면 이어서 만들어요.`, httpStatus: null };
  if (job.status === 'failed_permanent') {
    if (!retry) return { kind: 'fail', stage: 'transcript', code: job.lastError?.code ?? 'failed', message: job.lastError?.message ?? 'AI 자막을 만들지 못했어요.', httpStatus: null };
    await retryJob(rdeps, job.id);
  }
  const checkSaved = async (): Promise<VideoOutcome> => {
    await autoApplyPending(rdeps);
    const ctx = await deps.store.readVideo(video.id);
    return ctx?.transcript
      ? { kind: 'ok' }
      : { kind: 'fail', stage: 'transcript', code: 'needs_review', message: 'AI 자막 품질 확인이 필요해 자동으로 저장하지 않았어요. AI 자막 관리의 ‘확인 필요’에서 적용하면 이어서 만들어요.', httpStatus: null };
  };
  if (job.status === 'succeeded') return checkSaved();
  let transportFails = 0;
  while (!signal?.aborted) {
    const cur = (await ex.getJob(id))!;
    if (cur.attemptAfter && Date.parse(cur.attemptAfter) > now().getTime()) return pauseFor(cur.lastError?.code ?? 'daily_cap', cur.lastError?.message ?? '하루 한도에 닿았어요.', null, now(), cur.attemptAfter);
    onNote({ stage: 'transcript', note: cur.currentRequestId ? 'AI가 영상을 보고 자막을 만드는 중' : '자막 요청 보내는 중' });
    const out = await stepJob(cur, video, rdeps);
    if (out.kind === 'pending') {
      transportFails = 0;
      await sleep(deps.extractPollMs ?? POLL_MS, signal);
      continue;
    }
    if (out.kind === 'retry') {
      if (++transportFails > 3) return pauseFor('network', out.message ?? 'AI 서버에 연결하지 못했어요.', out.httpStatus ?? null, now());
      await sleep(deps.extractPollMs ? deps.extractPollMs * 2 : RETRY_MS, signal);
      continue;
    }
    if (out.kind === 'done') return checkSaved();
    if (out.kind === 'pause') return pauseFor(out.code ?? out.reason, out.message, out.httpStatus ?? null, now(), out.until);
    return { kind: 'fail', stage: 'transcript', skip: out.code === 'too_long', code: out.code, message: out.message ?? 'AI 자막을 만들지 못했어요.', httpStatus: out.httpStatus ?? null };
  }
  return pauseFor('cancelled', '멈췄어요.', null, now());
}

async function runPack(video: Video, kind: 'pack' | 'daypack', deps: PrepDeps, retry: boolean, onNote: (n: StepNote) => void, signal?: AbortSignal): Promise<VideoOutcome> {
  const now = deps.now ?? (() => new Date());
  const ctx = await deps.store.readVideo(video.id);
  if (!ctx) return { kind: 'fail', stage: kind, code: 'not_found', message: '영상을 찾지 못했어요.', httpStatus: null };
  if (kind === 'pack' && !ctx.transcript) return { kind: 'fail', stage: 'pack', code: 'no_transcript', message: '저장된 자막이 없어요.', httpStatus: null };
  // 너무 짧은 자막은 보내지 않는다 (요청 형식 오류로 대기열 전체가 멈추지 않게)
  if (kind === 'pack' && transcriptText(ctx.transcript!).trim().length < 20)
    return { kind: 'fail', stage: 'pack', code: 'transcript_too_short', message: '저장된 자막이 너무 짧아 학습 자료를 만들 수 없어요. 자막 탭에서 자막을 다시 넣어 주세요.', httpStatus: null };
  const exprs = new Map<string, Expression>(ctx.expressions.map((e) => [e.id, e]));
  const key = `${kind}:${video.id}`;
  const makeBody = () => (kind === 'pack' ? buildPackRequest(video, ctx.transcript!, ctx.day) : buildDayPackRequest(video, ctx.day, ctx.sentences, ctx.items, exprs, ctx.transcript));
  const out = await runAiTask(key, makeBody, deps, (p) => onNote({ stage: kind, note: p.phase === 'processing' ? p.note : p.phase === 'sending' ? '요청 보내는 중' : undefined }), signal, { retryFailed: retry });
  if (!out.ok) {
    if (PAUSE_CODES.has(out.code)) return pauseFor(out.code, out.message, out.httpStatus, now());
    return { kind: 'fail', stage: kind, code: out.code, message: out.message, httpStatus: out.httpStatus };
  }
  // 이어서 확인한 요청이면 그때 보낸 문장 기준으로 검사
  const st = await deps.store.getTask(key);
  const sentBody = st?.body;
  const v =
    kind === 'pack'
      ? validatePack(out.text, video.durationSec ?? null)
      : validateDayPack(out.text, sentBody && sentBody.task === 'daypack' ? sentBody.sentences : aiSentencesOf(ctx.sentences).map((s) => ({ number: s.aiNumber ?? s.order, text: s.english })));
  if (!v.ok) {
    if (st) await deps.store.putTask(key, { ...st, status: 'failed', resultText: null, error: { code: 'invalid_result', message: v.error, httpStatus: null } });
    return { kind: 'fail', stage: kind, code: 'invalid_result', message: `AI 결과를 쓸 수 없어요: ${v.error}`, httpStatus: null };
  }
  const { dayNumber } = seriesOf(video, ctx.day);
  await deps.store.applyPack(video.id, (c) => planPack({ ...c, dayNumber, content: v.content, pack: v.pack, requestId: out.requestId, now: now().toISOString(), newId: deps.newId ?? createId }));
  await markApplied(deps.store, key);
  return { kind: 'ok' };
}

/** 영상 1개: 빠진 단계만 차례로 */
export async function processVideo(row: PrepRow, deps: PrepDeps, retry: boolean, onNote: (n: StepNote) => void, signal?: AbortSignal): Promise<VideoOutcome> {
  let stage = row.stage;
  if (stage === 'transcript') {
    const r = await runTranscript(row.video, deps, retry, onNote, signal);
    if (r.kind !== 'ok') return r;
    stage = 'pack';
  }
  if (stage === 'pack' || stage === 'daypack') return runPack(row.video, stage, deps, retry, onNote, signal);
  return { kind: 'ok' };
}
