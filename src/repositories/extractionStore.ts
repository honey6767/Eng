import type { StudyDatabase } from '@/db/database';
import type { AiRequest, ExtractionDraft, ExtractionJob, Transcript, Video } from '@/types/models';

/**
 * 자동 추출용 저장소 (저장소 계층)
 *
 * 쓰기는 새 테이블(extractionJobs · aiRequests · extractionDrafts)과 appMeta의 새 키 'extractionRun'에만 한다.
 * 영상·자막 등 기존 테이블은 읽기만 한다 (기존 데이터 덮어쓰기 없음).
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
    getRun: async () => ((await db.appMeta.get(META_EXTRACTION_RUN))?.value as ExtractionRunState | undefined) ?? null,
    putRun: async (run) => {
      await db.appMeta.put({ key: META_EXTRACTION_RUN, value: run });
    },
  };
}
