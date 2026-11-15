import type { StudyDatabase } from '@/db/database';
import type { AiRequest, DayAssignment, ExtractionDraft, ExtractionJob, LearningItem, Transcript, Video } from '@/types/models';
import type { ApplyContext, ApplyPlan } from '@/services/extraction/applyDraft';

/**
 * 자동 추출용 저장소 (저장소 계층)
 *
 * 쓰기는 새 테이블(extractionJobs · aiRequests · extractionDrafts · learningItems · dayAssignments)과
 * appMeta의 새 키 'extractionRun'에 한다. 기존 테이블 중 자막·표현에는 초안을 적용할 때 '새 레코드 추가'만 하고
 * (같은 영상의 자막·같은 표현이 이미 있으면 추가하지 않음), 기존 레코드는 고치거나 지우지 않는다.
 */

export const META_EXTRACTION_RUN = 'extractionRun';

export interface ExtractionRunState {
  /** 사용자가 시작해 아직 끝나지 않음 — 앱을 다시 열면 이어서 진행 */
  active: boolean;
  startedAt: string | null;
  /** 이 시각까지 멈춤 (하루 한도 등) */
  pausedUntil: string | null;
  /** 멈춘 이유 */
  pauseReason: 'daily_cap' | 'gemini_quota' | 'auth' | 'server' | null;
  pauseMessage: string | null;
  updatedAt: string;
}

export interface CandidateVideo {
  video: Video;
  hasTranscript: boolean;
}

export interface ExtractionStore {
  /** 자막 추출 대상 판단에 필요한 영상·자막·작업을 읽는다 */
  readOverview(): Promise<{ videos: Video[]; transcripts: Transcript[]; jobs: ExtractionJob[]; drafts: ExtractionDraft[] }>;
  addJobs(jobs: ExtractionJob[]): Promise<void>;
  getJob(id: string): Promise<ExtractionJob | undefined>;
  putJob(job: ExtractionJob): Promise<void>;
  getRequest(id: string): Promise<AiRequest | undefined>;
  putRequest(req: AiRequest): Promise<void>;
  /** 새 요청 시작: 요청 기록(reserved)과 작업 상태를 한 트랜잭션으로 */
  beginRequest(job: ExtractionJob, req: AiRequest): Promise<void>;
  /** 결과 저장: 초안 추가 + 요청·작업 상태 변경을 한 트랜잭션으로 (같은 요청의 초안이 이미 있으면 다시 만들지 않음) */
  saveResult(job: ExtractionJob, req: AiRequest, draft: ExtractionDraft | null): Promise<void>;
  getRun(): Promise<ExtractionRunState | null>;
  putRun(run: ExtractionRunState): Promise<void>;
  getDraft(id: string): Promise<ExtractionDraft | undefined>;
  putDraft(draft: ExtractionDraft): Promise<void>;
  /**
   * B1-d — 초안 적용. 한 트랜잭션 안에서 지금 상태를 다시 읽어 계획(plan)을 만들고, 추가만 한다.
   * 자막·표현은 이미 있으면 추가하지 않고(덮어쓰지 않음), 초안의 상태와 approvedRefs만 바꾼다.
   */
  applyDraft(draftId: string, plan: (ctx: Omit<ApplyContext, 'now' | 'newId' | 'excludeKeyIdx' | 'excludeChunkIdx'>) => ApplyPlan): Promise<ApplyPlan | null>;
  readDays(): Promise<{ videos: Video[]; days: DayAssignment[]; drafts: ExtractionDraft[] }>;
  /** Day 확정·변경: dayAssignments와 그 영상의 학습 대상(새 테이블)만 바꾼다 */
  setDays(updates: { videoId: string; dayNumber: number }[], now: string): Promise<number>;
  listLearningItems(videoId: string): Promise<LearningItem[]>;
}

export function createExtractionStore(db: StudyDatabase): ExtractionStore {
  return {
    readOverview: () =>
      db.transaction('r', [db.videos, db.transcripts, db.extractionJobs, db.extractionDrafts], async () => ({
        videos: await db.videos.toArray(),
        transcripts: await db.transcripts.toArray(),
        jobs: await db.extractionJobs.toArray(),
        drafts: await db.extractionDrafts.toArray(),
      })),
    addJobs: async (jobs) => {
      if (jobs.length) await db.extractionJobs.bulkAdd(jobs);
    },
    getJob: (id) => db.extractionJobs.get(id),
    putJob: async (job) => {
      await db.extractionJobs.put(job);
    },
    getRequest: (id) => db.aiRequests.get(id),
    putRequest: async (req) => {
      await db.aiRequests.put(req);
    },
    beginRequest: (job, req) =>
      db.transaction('rw', [db.extractionJobs, db.aiRequests], async () => {
        await db.aiRequests.add(req);
        await db.extractionJobs.put(job);
      }),
    saveResult: (job, req, draft) =>
      db.transaction('rw', [db.extractionJobs, db.aiRequests, db.extractionDrafts], async () => {
        if (draft && !(await db.extractionDrafts.where('jobId').equals(job.id).filter((d) => d.requestId === req.id).count())) {
          await db.extractionDrafts.add(draft);
        }
        await db.aiRequests.put(req);
        await db.extractionJobs.put(job);
      }),
    getDraft: (id) => db.extractionDrafts.get(id),
    putDraft: async (draft) => {
      await db.extractionDrafts.put(draft);
    },
    applyDraft: (draftId, plan) =>
      db.transaction('rw', [db.extractionDrafts, db.videos, db.transcripts, db.expressions, db.learningItems, db.dayAssignments], async () => {
        const draft = await db.extractionDrafts.get(draftId);
        if (!draft || draft.status === 'approved' || draft.status === 'partially_approved' || draft.status === 'superseded') return null;
        const video = await db.videos.get(draft.videoId);
        if (!video) return null;
        const hasTranscript = (await db.transcripts.where('videoId').equals(video.id).count()) > 0;
        const expressions = await db.expressions.toArray();
        const existingItems = await db.learningItems.where('videoId').equals(video.id).toArray();
        const dayAssignment = (await db.dayAssignments.where('videoId').equals(video.id).first()) ?? null;
        const p = plan({ draft, video, hasTranscript, expressionIdByKey: new Map(expressions.map((e) => [e.normalizedKey, e.id])), existingLearningItemIds: new Set(existingItems.map((i) => i.id)), dayAssignment });
        // 추가만 (bulkAdd: 같은 id가 있으면 트랜잭션 전체 취소 → 덮어쓰기 불가)
        if (p.transcript) await db.transcripts.add(p.transcript);
        if (p.expressions.length) await db.expressions.bulkAdd(p.expressions);
        if (p.learningItems.length) await db.learningItems.bulkAdd(p.learningItems);
        if (p.dayAssignment) await db.dayAssignments.add(p.dayAssignment);
        await db.extractionDrafts.put({ ...draft, status: p.status, approvedRefs: p.approvedRefs, updatedAt: p.transcript?.updatedAt ?? p.learningItems[0]?.updatedAt ?? draft.updatedAt });
        return p;
      }),
    readDays: () =>
      db.transaction('r', [db.videos, db.dayAssignments, db.extractionDrafts], async () => ({
        videos: await db.videos.toArray(),
        days: await db.dayAssignments.toArray(),
        drafts: await db.extractionDrafts.toArray(),
      })),
    setDays: (updates, now) =>
      db.transaction('rw', [db.dayAssignments, db.learningItems, db.videos], async () => {
        let n = 0;
        for (const u of updates) {
          if (!(await db.videos.get(u.videoId))) continue;
          const cur = await db.dayAssignments.where('videoId').equals(u.videoId).first();
          const next: DayAssignment = cur
            ? { ...cur, dayNumber: u.dayNumber, status: 'confirmed', source: cur.dayNumber === u.dayNumber ? cur.source : 'user', updatedAt: now }
            : { id: `day-${u.videoId}`, videoId: u.videoId, dayNumber: u.dayNumber, status: 'confirmed', source: 'user', createdAt: now, updatedAt: now };
          await db.dayAssignments.put(next);
          await db.learningItems
            .where('videoId')
            .equals(u.videoId)
            .modify((li: LearningItem) => {
              li.sourceType = 'day';
              li.dayNumber = u.dayNumber;
              li.updatedAt = now;
            });
          n++;
        }
        return n;
      }),
    listLearningItems: (videoId) => db.learningItems.where('videoId').equals(videoId).toArray(),
    getRun: async () => ((await db.appMeta.get(META_EXTRACTION_RUN))?.value as ExtractionRunState | undefined) ?? null,
    putRun: async (run) => {
      await db.appMeta.put({ key: META_EXTRACTION_RUN, value: run });
    },
  };
}
