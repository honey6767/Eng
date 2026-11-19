import type { ContentStore } from '@/repositories/contentStore';
import type { AiClient } from '@/services/integrations/aiClient';
import { markApplied, runAiTask, type TaskProgress } from '@/services/ai/taskRunner';
import { buildContentRequest, hasContent, planContent, seriesOf, validateContent } from './contentService';
import { createId } from '@/utils/id';

export type ContentProgress =
  | TaskProgress
  | { phase: 'succeeded'; sentences: number; chunks: number; reusedSentences: number; issues: string[]; reused: boolean }
  | { phase: 'already' };

export interface ContentDeps {
  store: ContentStore;
  client: AiClient;
  now?: () => Date;
  newId?: () => string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollMs?: number;
}

export const contentTaskKey = (videoId: string) => `content:${videoId}`;

/** 영상 1개의 원문 문장·Chunk 만들기 (이미 있으면 요청하지 않음) */
export async function generateContent(deps: ContentDeps, videoId: string, onProgress: (p: ContentProgress) => void, signal?: AbortSignal): Promise<ContentProgress> {
  const report = (p: ContentProgress) => {
    onProgress(p);
    return p;
  };
  const ctx = await deps.store.readVideo(videoId);
  if (!ctx) return report({ phase: 'failed', httpStatus: null, code: 'not_found', message: '영상을 찾지 못했어요.' });
  if (hasContent(ctx.sentences, ctx.items)) return report({ phase: 'already' });
  if (!ctx.video.youtubeVideoId) return report({ phase: 'failed', httpStatus: null, code: 'no_video_id', message: 'YouTube 영상 ID가 없는 영상이에요.' });
  if (!ctx.transcript) return report({ phase: 'failed', httpStatus: null, code: 'no_transcript', message: '저장된 자막이 없어요. 자막 탭에서 먼저 자막을 만들거나 붙여 넣어 주세요.' });
  const transcript = ctx.transcript;
  const key = contentTaskKey(videoId);
  const out = await runAiTask(key, () => buildContentRequest(ctx.video, transcript, ctx.day), deps, report, signal);
  if (!out.ok) return report({ phase: 'failed', httpStatus: out.httpStatus, code: out.code, message: out.message });

  const v = validateContent(out.text, ctx.video.durationSec ?? null);
  if (!v.ok) {
    const st = await deps.store.getTask(key);
    if (st) await deps.store.putTask(key, { ...st, status: 'failed', resultText: null, error: { code: 'invalid_result', message: v.error, httpStatus: null } });
    return report({ phase: 'failed', httpStatus: null, code: 'invalid_result', message: `Gemini 결과를 읽지 못했어요: ${v.error}` });
  }
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const { dayNumber } = seriesOf(ctx.video, ctx.day);
  const plan = await deps.store.applyContent(videoId, (c) => planContent({ ...c, dayNumber, result: v.result, requestId: out.requestId, now, newId: deps.newId ?? createId }));
  await markApplied(deps.store, key);
  if (!plan) return report({ phase: 'already' });
  return report({ phase: 'succeeded', sentences: plan.sentences.length + plan.reusedSentences, chunks: plan.items.length, reusedSentences: plan.reusedSentences, issues: v.issues, reused: out.reused });
}

// ─────────────────────────────────────────────
// 화면용: 영상별 진행 상태 (화면을 옮겨도 진행은 계속, 돌아오면 마지막 상태)
// ─────────────────────────────────────────────

const state = new Map<string, ContentProgress>();
const running = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export const contentProgress = {
  get: (videoId: string) => state.get(videoId) ?? null,
  isRunning: (videoId: string) => running.has(videoId),
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  /** 같은 영상은 한 번에 하나만 */
  start(deps: ContentDeps, videoId: string): Promise<ContentProgress> | null {
    if (running.has(videoId)) return null;
    running.add(videoId);
    state.set(videoId, { phase: 'sending' });
    notify();
    return generateContent(deps, videoId, (p) => {
      state.set(videoId, p);
      notify();
    }).finally(() => {
      running.delete(videoId);
      notify();
    });
  },
};

// ─────────────────────────────────────────────
// 여러 영상: 자막이 있고 아직 문장·Chunk가 없는 영상을 하나씩 (하루 한도·오류에서 멈춤)
// ─────────────────────────────────────────────

export interface PendingVideo {
  videoId: string;
  title: string;
}

export async function listPendingContent(store: ContentStore, videoIds: string[]): Promise<PendingVideo[]> {
  const out: PendingVideo[] = [];
  for (const id of videoIds) {
    const c = await store.readVideo(id);
    if (!c || c.video.isSample || !c.video.youtubeVideoId || !c.transcript || hasContent(c.sentences, c.items)) continue;
    out.push({ videoId: id, title: c.video.title });
  }
  return out;
}

const STOP_CODES = new Set(['daily_cap', 'gemini_quota', 'gemini_not_configured', 'auth', 'bad_request', 'network', 'ledger_unavailable', 'cancelled']);

export async function generatePendingContent(deps: ContentDeps, videos: PendingVideo[], onStep: (done: number, total: number, current: PendingVideo | null, last: ContentProgress | null) => void, signal?: AbortSignal) {
  let done = 0;
  let last: ContentProgress | null = null;
  for (const v of videos) {
    if (signal?.aborted) break;
    onStep(done, videos.length, v, last);
    last = (await contentProgress.start(deps, v.videoId)) ?? null;
    done++;
    if (last?.phase === 'failed' && STOP_CODES.has(last.code)) break;
  }
  onStep(done, videos.length, null, last);
  return { done, last };
}
