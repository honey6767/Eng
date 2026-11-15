import type { ExtractionStore } from '@/repositories/extractionStore';
import type { ExtractionDraft, ExtractionJob, Video } from '@/types/models';
import { createId } from '@/utils/id';
import { assessDraft, planApplication, type ApplyPlan, type DraftAssessment } from './applyDraft';

/**
 * B1-c — AI 결과 검토·확인 필요 처리·재시도 관리
 *
 * - 품질이 괜찮은 초안은 자동 적용(autoApplyPending) — 사용자가 따로 확인하지 않아도 학습 자료가 된다.
 * - 확인 필요 초안: '그래도 적용'(일부 표현 빼기 가능) · '버리고 다시 추출' · '건너뛰기'
 * - 실패한 영상: '다시 추출'(하나씩 또는 모두). 사용자가 누를 때만 새 요청을 만든다 (자동 재요청 없음).
 */

export interface ManageDeps {
  store: ExtractionStore;
  now?: () => Date;
  newId?: () => string;
}

const nowIso = (d: ManageDeps) => (d.now ?? (() => new Date()))().toISOString();

export async function applyDraft(deps: ManageDeps, draftId: string, opts: { excludeKeyIdx?: number[]; excludeChunkIdx?: number[] } = {}): Promise<ApplyPlan | null> {
  const now = nowIso(deps);
  const newId = deps.newId ?? createId;
  return deps.store.applyDraft(draftId, (ctx) => planApplication({ ...ctx, now, newId, ...opts }));
}

/** 검토 대기 초안 중 품질이 괜찮은 것을 모두 자동 적용. 적용한 수를 돌려준다 */
export async function autoApplyPending(deps: ManageDeps): Promise<number> {
  const { drafts } = await deps.store.readOverview();
  let n = 0;
  for (const d of drafts) {
    if (d.status !== 'pending_review' || !assessDraft(d).autoApply) continue;
    if (await applyDraft(deps, d.id)) n++;
  }
  return n;
}

export interface ReviewOverview {
  /** 확인 필요 — 품질 문제로 자동 적용하지 않은 초안 */
  needsReview: { draft: ExtractionDraft; video: Video | null; assessment: DraftAssessment }[];
  /** 확인 권장 — 경고가 있었지만 적용된 초안 */
  appliedWithWarnings: { draft: ExtractionDraft; video: Video | null; assessment: DraftAssessment }[];
  /** 실패한 영상 (다시 추출 가능) */
  failed: { job: ExtractionJob; video: Video | null }[];
  /** 긴 영상·길이를 모르는 영상 (수동 입력) */
  skipped: { job: ExtractionJob; video: Video | null }[];
  applied: number;
}

export async function reviewOverview(store: ExtractionStore): Promise<ReviewOverview> {
  const { videos, jobs, drafts } = await store.readOverview();
  const vById = new Map(videos.map((v) => [v.id, v]));
  const latest = new Map<string, ExtractionDraft>();
  for (const d of [...drafts].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) if (d.status !== 'superseded') latest.set(d.videoId, d);
  const out: ReviewOverview = { needsReview: [], appliedWithWarnings: [], failed: [], skipped: [], applied: 0 };
  for (const d of latest.values()) {
    const a = assessDraft(d);
    const entry = { draft: d, video: vById.get(d.videoId) ?? null, assessment: a };
    if (d.status === 'pending_review') out.needsReview.push(entry);
    else if (d.status === 'approved' || d.status === 'partially_approved') {
      out.applied++;
      if (a.warnings.length || !a.autoApply) out.appliedWithWarnings.push(entry);
    }
  }
  for (const j of jobs) {
    if (j.status === 'failed_permanent') out.failed.push({ job: j, video: vById.get(j.videoId) ?? null });
    else if (j.status === 'skipped' && j.lastError?.code !== 'user_skipped') out.skipped.push({ job: j, video: vById.get(j.videoId) ?? null });
  }
  return out;
}

/** 실패한 영상을 다시 대기열로 — 다음 실행에서 새 요청 식별자로 한 번 더 요청한다 (사용자가 누를 때만) */
export async function retryJob(deps: ManageDeps, jobId: string): Promise<boolean> {
  const job = await deps.store.getJob(jobId);
  if (!job || job.status !== 'failed_permanent') return false;
  await deps.store.putJob({ ...job, status: 'queued', currentRequestId: null, attemptAfter: null, lastError: null, updatedAt: nowIso(deps) });
  return true;
}

export async function retryAllFailed(deps: ManageDeps): Promise<number> {
  const { jobs } = await deps.store.readOverview();
  let n = 0;
  for (const j of jobs) if (j.status === 'failed_permanent' && (await retryJob(deps, j.id))) n++;
  return n;
}

/** 확인 필요 초안을 버리고 다시 추출 (초안은 지우지 않고 '버림'으로 남김) */
export async function rejectDraftAndRetry(deps: ManageDeps, draftId: string): Promise<boolean> {
  const draft = await deps.store.getDraft(draftId);
  if (!draft || draft.status !== 'pending_review') return false;
  const job = await deps.store.getJob(draft.jobId);
  if (!job) return false;
  const now = nowIso(deps);
  await deps.store.putDraft({ ...draft, status: 'rejected', updatedAt: now });
  await deps.store.putJob({ ...job, status: 'queued', currentRequestId: null, draftId: null, attemptAfter: null, lastError: null, updatedAt: now });
  return true;
}

/** 확인 필요 초안 건너뛰기 — 학습 자료로 쓰지 않고, 다시 추출하지도 않음 (수동 입력 가능) */
export async function skipDraft(deps: ManageDeps, draftId: string): Promise<boolean> {
  const draft = await deps.store.getDraft(draftId);
  if (!draft || draft.status !== 'pending_review') return false;
  const job = await deps.store.getJob(draft.jobId);
  const now = nowIso(deps);
  await deps.store.putDraft({ ...draft, status: 'rejected', updatedAt: now });
  if (job) await deps.store.putJob({ ...job, status: 'skipped', lastError: { code: 'user_skipped', message: '사용자가 건너뜀' }, updatedAt: now });
  return true;
}
