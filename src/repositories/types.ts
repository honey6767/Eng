import type {
  Dialogue,
  DialogueComposition,
  DialogueKind,
  DialogueProgress,
  Expression,
  ExpressionNote,
  KeySentence,
  MetadataSource,
  Playlist,
  ReviewItemType,
  ReviewState,
  SourceRef,
  StudyLog,
  Transcript,
  TranscriptFormat,
  TranscriptSegment,
  Video,
  VideoStatus,
} from '@/types/models';

/** YouTube에서 가져온(또는 URL에서 추출한) 영상 정보 */
export interface VideoMetadataInput {
  youtubeVideoId: string;
  title: string;
  channelTitle: string | null;
  thumbnailUrl: string | null;
  durationSec: number | null;
  metadataSource: MetadataSource;
  /** 재생목록 내 순서 */
  position?: number | null;
}

export type VideoSourceInput = { kind: 'playlist'; playlistId: string } | { kind: 'manual' };

export interface VideoUpsertResult {
  video: Video;
  /** 새로 만든 레코드 */
  created: boolean;
  /** 이미 있던 영상에 새 출처를 연결 */
  linked: boolean;
}

export interface PlaylistUpsertInput {
  youtubePlaylistId: string;
  url: string;
  title: string;
  channelTitle: string | null;
  thumbnailUrl: string | null;
  itemCount: number | null;
}

export interface TranscriptSaveInput {
  source: Transcript['source'];
  status: Transcript['status'];
  rawText: string;
  segments: TranscriptSegment[];
  format: TranscriptFormat | null;
  errorMessage?: string;
}

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
  getByYouTubeId(youtubePlaylistId: string): Promise<Playlist | undefined>;
  /** 같은 YouTube 재생목록 ID가 있으면 새로 만들지 않고 정보만 갱신 */
  upsertByYouTubeId(input: PlaylistUpsertInput): Promise<{ playlist: Playlist; created: boolean }>;
  update(id: string, patch: Partial<Omit<Playlist, 'id'>>): Promise<void>;
}

export interface VideoRepository {
  list(): Promise<Video[]>;
  get(id: string): Promise<Video | undefined>;
  getByYouTubeId(youtubeVideoId: string): Promise<Video | undefined>;
  listByStatus(status: VideoStatus): Promise<Video[]>;
  update(id: string, patch: Partial<Omit<Video, 'id'>>): Promise<void>;
  /**
   * YouTube 영상 ID 기준으로 중복 없이 저장 (하나의 트랜잭션).
   * 이미 있으면 학습 상태 등 기존 데이터는 유지하고, 정보 보강 + 출처만 연결한다.
   */
  upsertFromYouTube(items: VideoMetadataInput[], source: VideoSourceInput): Promise<VideoUpsertResult[]>;
}

export interface TranscriptRepository {
  getByVideo(videoId: string): Promise<Transcript | undefined>;
  /** 영상의 자막을 저장 (기존 자막이 있으면 교체 — 호출 전에 사용자 확인 필요) */
  save(videoId: string, input: TranscriptSaveInput): Promise<Transcript>;
  deleteByVideo(videoId: string): Promise<void>;
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
