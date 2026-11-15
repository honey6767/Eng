import Dexie, { type EntityTable } from 'dexie';
import type {
  AiRequest,
  AppMeta,
  DayAssignment,
  DialogueDraft,
  ExtractionDraft,
  ExtractionJob,
  LearningItem,
  StudySession,
  Dialogue,
  DialogueComposition,
  DialogueProgress,
  Expression,
  ExpressionNote,
  KeySentence,
  Playlist,
  ReviewState,
  StudyLog,
  Transcript,
  Video,
} from '@/types/models';
import { applyMigrations } from './migrations';

export const DB_NAME = 'my-english-study';

/**
 * IndexedDB 데이터베이스 (Dexie)
 *
 * 이 클래스는 저장소(Repository) 계층에서만 직접 사용한다.
 * UI/훅/서비스는 반드시 repositories를 거쳐 데이터에 접근해야
 * 향후 Supabase 등으로 저장소를 교체할 때 영향 범위가 줄어든다.
 */
export class StudyDatabase extends Dexie {
  playlists!: EntityTable<Playlist, 'id'>;
  videos!: EntityTable<Video, 'id'>;
  transcripts!: EntityTable<Transcript, 'id'>;
  expressionNotes!: EntityTable<ExpressionNote, 'id'>;
  keySentences!: EntityTable<KeySentence, 'id'>;
  dialogues!: EntityTable<Dialogue, 'id'>;
  dialogueCompositions!: EntityTable<DialogueComposition, 'id'>;
  expressions!: EntityTable<Expression, 'id'>;
  reviewStates!: EntityTable<ReviewState, 'id'>;
  dialogueProgress!: EntityTable<DialogueProgress, 'id'>;
  studyLogs!: EntityTable<StudyLog, 'id'>;
  appMeta!: EntityTable<AppMeta, 'key'>;
  // v3 (B1)
  learningItems!: EntityTable<LearningItem, 'id'>;
  dayAssignments!: EntityTable<DayAssignment, 'id'>;
  studySessions!: EntityTable<StudySession, 'id'>;
  dialogueDrafts!: EntityTable<DialogueDraft, 'id'>;
  extractionJobs!: EntityTable<ExtractionJob, 'id'>;
  extractionDrafts!: EntityTable<ExtractionDraft, 'id'>;
  aiRequests!: EntityTable<AiRequest, 'id'>;

  /** @param upToVersion 테스트 전용 — 구버전 스키마로 열 때 사용 */
  constructor(name = DB_NAME, upToVersion?: number) {
    super(name);
    applyMigrations(this, upToVersion);
  }
}

export const db = new StudyDatabase();

/** 모든 테이블 이름 (내보내기/초기화/통계용) — 스키마 버전별 목록은 ./tables */
export { TABLE_NAMES, V2_TABLE_NAMES, V3_NEW_TABLE_NAMES, type TableName } from './tables';
