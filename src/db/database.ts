import Dexie, { type EntityTable } from 'dexie';
import type {
  AppMeta,
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

  constructor(name = DB_NAME) {
    super(name);
    applyMigrations(this);
  }
}

export const db = new StudyDatabase();

/** 모든 테이블 이름 (내보내기/초기화/통계용) */
export const TABLE_NAMES = [
  'playlists',
  'videos',
  'transcripts',
  'expressionNotes',
  'keySentences',
  'dialogues',
  'dialogueCompositions',
  'expressions',
  'reviewStates',
  'dialogueProgress',
  'studyLogs',
  'appMeta',
] as const;

export type TableName = (typeof TABLE_NAMES)[number];
