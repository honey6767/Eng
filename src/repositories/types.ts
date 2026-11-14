import type {
  Dialogue,
  DialogueComposition,
  DialogueKind,
  DialogueProgress,
  Expression,
  ExpressionNote,
  KeySentence,
  Playlist,
  ReviewItemType,
  ReviewState,
  SourceRef,
  StudyLog,
  Transcript,
  Video,
  VideoStatus,
} from '@/types/models';

/**
 * 저장소(Repository) 인터페이스
 *
 * UI·훅·서비스는 이 인터페이스에만 의존한다.
 * 현재 구현: IndexedDB(Dexie) — ./indexeddb.ts
 * 향후 구현: Supabase 등 — 같은 인터페이스로 구현 후 ./index.ts에서 교체
 */

export interface PlaylistRepository {
  list(): Promise<Playlist[]>;
  get(id: string): Promise<Playlist | undefined>;
}

export interface VideoRepository {
  list(): Promise<Video[]>;
  get(id: string): Promise<Video | undefined>;
  listByStatus(status: VideoStatus): Promise<Video[]>;
  update(id: string, patch: Partial<Omit<Video, 'id'>>): Promise<void>;
}

export interface TranscriptRepository {
  getByVideo(videoId: string): Promise<Transcript | undefined>;
}

export interface ExpressionNoteRepository {
  listByVideo(videoId: string): Promise<ExpressionNote[]>;
}

export interface KeySentenceRepository {
  list(): Promise<KeySentence[]>;
  listByVideo(videoId: string): Promise<KeySentence[]>;
  getMany(ids: string[]): Promise<KeySentence[]>;
}

export interface DialogueRepository {
  list(kind?: DialogueKind): Promise<Dialogue[]>;
  get(id: string): Promise<Dialogue | undefined>;
  listByVideo(videoId: string): Promise<Dialogue[]>;
  setFavorite(id: string, isFavorite: boolean): Promise<void>;
}

export interface DialogueCompositionRepository {
  getByVideo(videoId: string): Promise<DialogueComposition | undefined>;
}

export interface ExpressionRepository {
  list(): Promise<Expression[]>;
  get(id: string): Promise<Expression | undefined>;
  getMany(ids: string[]): Promise<Expression[]>;
  /**
   * 같은 표현(정규화 키 기준)이 이미 있으면 새로 만들지 않고 출처만 누적한다.
   * 반환값: 최종 표현 레코드
   */
  upsert(input: { text: string; meaningKo: string; sourceRef?: SourceRef; isSample?: boolean }): Promise<Expression>;
  setFavorite(id: string, isFavorite: boolean): Promise<void>;
  setMarkedDifficult(id: string, marked: boolean): Promise<void>;
}

export interface ReviewStateRepository {
  list(itemType?: ReviewItemType): Promise<ReviewState[]>;
  get(itemType: ReviewItemType, itemId: string): Promise<ReviewState | undefined>;
  listDue(now: Date): Promise<ReviewState[]>;
  put(state: ReviewState): Promise<void>;
}

export interface DialogueProgressRepository {
  list(): Promise<DialogueProgress[]>;
  get(dialogueId: string): Promise<DialogueProgress | undefined>;
}

export interface StudyLogRepository {
  /** dateKey(YYYY-MM-DD) 이후(포함) 기록 */
  listSince(dateKey: string): Promise<StudyLog[]>;
  countReviews(): Promise<number>;
  count(): Promise<number>;
}

export interface MetaRepository {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export interface BulkData {
  playlists?: Playlist[];
  videos?: Video[];
  transcripts?: Transcript[];
  expressionNotes?: ExpressionNote[];
  keySentences?: KeySentence[];
  dialogues?: Dialogue[];
  dialogueCompositions?: DialogueComposition[];
  expressions?: Expression[];
  reviewStates?: ReviewState[];
  dialogueProgress?: DialogueProgress[];
  studyLogs?: StudyLog[];
}

export interface TableCount {
  table: string;
  label: string;
  total: number;
  sample: number;
}

export interface MaintenanceRepository {
  countAll(): Promise<TableCount[]>;
  hasSampleData(): Promise<boolean>;
  /** 샘플(isSample) 레코드만 삭제 — 사용자 데이터는 보존 */
  deleteSampleData(): Promise<number>;
  /** 모든 데이터 삭제 (반드시 사용자 확인 후 호출) */
  clearAll(): Promise<void>;
  /** 여러 테이블에 레코드를 하나의 트랜잭션으로 추가 (시드/가져오기용) */
  bulkInsert(data: BulkData): Promise<void>;
}

export interface Repositories {
  playlists: PlaylistRepository;
  videos: VideoRepository;
  transcripts: TranscriptRepository;
  expressionNotes: ExpressionNoteRepository;
  keySentences: KeySentenceRepository;
  dialogues: DialogueRepository;
  compositions: DialogueCompositionRepository;
  expressions: ExpressionRepository;
  reviewStates: ReviewStateRepository;
  dialogueProgress: DialogueProgressRepository;
  studyLogs: StudyLogRepository;
  meta: MetaRepository;
  maintenance: MaintenanceRepository;
}
