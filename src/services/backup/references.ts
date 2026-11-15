import type { TableName } from '@/db/database';
import type {
  AiRequest,
  DayAssignment,
  Dialogue,
  DialogueDraft,
  ExtractionDraft,
  ExtractionJob,
  LearningItem,
  StudySession,
  DialogueComposition,
  DialogueProgress,
  Expression,
  ExpressionNote,
  KeySentence,
  ReviewItemType,
  ReviewState,
  StudyLog,
  Transcript,
  Video,
} from '@/types/models';

/**
 * 테이블 사이의 연결 관계 정의 — 복원할 때 연결 대상이 실제로 있는지 검사하는 데 쓴다.
 *
 * 표현 · 대화문 · 영상 · 핵심 문장 · 학습 기록 사이의 모든 id 참조를 여기에 모은다.
 * 새 테이블/필드가 생기면 여기에도 추가해야 복원 검사가 그 연결을 확인한다.
 */

export interface RowRef {
  /** 참조하는 필드 (사람이 읽는 설명용) */
  field: string;
  /** 연결 대상 테이블 */
  table: TableName;
  /** 연결 대상 id */
  id: string;
}

type AnyRow = Record<string, unknown>;

const ITEM_TABLE: Record<ReviewItemType, TableName> = {
  expression: 'expressions',
  sentence: 'keySentences',
  dialogue: 'dialogues',
};

/** 각 테이블의 기본 키 필드 */
export function primaryKeyOf(table: TableName, row: AnyRow): string {
  return String(table === 'appMeta' ? row.key : row.id);
}

function push(out: RowRef[], field: string, table: TableName, id: unknown) {
  if (typeof id === 'string' && id.length > 0) out.push({ field, table, id });
}

/** 한 레코드가 가리키는 다른 레코드 목록 */
export function referencesOf(table: TableName, row: AnyRow): RowRef[] {
  const out: RowRef[] = [];
  switch (table) {
    case 'videos': {
      const v = row as unknown as Video;
      push(out, 'playlistId', 'playlists', v.playlistId);
      for (const s of v.sources ?? []) if (s.kind === 'playlist') push(out, 'sources.playlistId', 'playlists', s.playlistId);
      break;
    }
    case 'transcripts':
      push(out, 'videoId', 'videos', (row as unknown as Transcript).videoId);
      break;
    case 'expressionNotes': {
      const n = row as unknown as ExpressionNote;
      push(out, 'videoId', 'videos', n.videoId);
      push(out, 'expressionId', 'expressions', n.expressionId);
      break;
    }
    case 'keySentences': {
      const k = row as unknown as KeySentence;
      push(out, 'videoId', 'videos', k.videoId);
      for (const id of k.expressionIds ?? []) push(out, 'expressionIds', 'expressions', id);
      for (const s of k.expressionSpans ?? []) push(out, 'expressionSpans.expressionId', 'expressions', s.expressionId);
      break;
    }
    case 'dialogues': {
      const d = row as unknown as Dialogue;
      push(out, 'videoId', 'videos', d.videoId);
      for (const id of d.sourceVideoIds ?? []) push(out, 'sourceVideoIds', 'videos', id);
      for (const id of d.expressionIds ?? []) push(out, 'expressionIds', 'expressions', id);
      for (const line of d.lines ?? [])
        for (const seg of line.segments ?? []) push(out, 'lines.segments.keySentenceId', 'keySentences', seg.keySentenceId);
      break;
    }
    case 'dialogueCompositions': {
      const c = row as unknown as DialogueComposition;
      push(out, 'videoId', 'videos', c.videoId);
      for (const id of c.dialogueIds ?? []) push(out, 'dialogueIds', 'dialogues', id);
      for (const id of c.leftoverSentenceIds ?? []) push(out, 'leftoverSentenceIds', 'keySentences', id);
      break;
    }
    case 'expressions': {
      const e = row as unknown as Expression;
      for (const r of e.sourceRefs ?? []) {
        push(out, 'sourceRefs.videoId', 'videos', r.videoId);
        push(out, 'sourceRefs.dialogueId', 'dialogues', r.dialogueId);
        push(out, 'sourceRefs.sentenceId', 'keySentences', r.sentenceId);
      }
      break;
    }
    case 'reviewStates': {
      const r = row as unknown as ReviewState;
      const t = ITEM_TABLE[r.itemType];
      if (t) push(out, 'itemId', t, r.itemId);
      break;
    }
    case 'dialogueProgress':
      push(out, 'dialogueId', 'dialogues', (row as unknown as DialogueProgress).dialogueId);
      break;
    case 'studyLogs': {
      const l = row as unknown as StudyLog;
      const t = ITEM_TABLE[l.itemType];
      if (t) push(out, 'itemId', t, l.itemId);
      break;
    }
    // v3 (B1) 새 테이블
    case 'learningItems': {
      const li = row as unknown as LearningItem;
      push(out, 'expressionId', 'expressions', li.expressionId);
      push(out, 'videoId', 'videos', li.videoId);
      push(out, 'dialogueId', 'dialogues', li.dialogueId);
      break;
    }
    case 'dayAssignments':
      push(out, 'videoId', 'videos', (row as unknown as DayAssignment).videoId);
      break;
    case 'extractionJobs':
      push(out, 'videoId', 'videos', (row as unknown as ExtractionJob).videoId);
      break;
    case 'extractionDrafts': {
      const d = row as unknown as ExtractionDraft;
      push(out, 'videoId', 'videos', d.videoId);
      push(out, 'jobId', 'extractionJobs', d.jobId);
      break;
    }
    case 'aiRequests':
      push(out, 'jobId', 'extractionJobs', (row as unknown as AiRequest).jobId);
      break;
    case 'studySessions': {
      const s = row as unknown as StudySession;
      push(out, 'dialogueId', 'dialogues', s.dialogueId);
      for (const id of s.learningItemIds ?? []) push(out, 'learningItemIds', 'learningItems', id);
      break;
    }
    case 'dialogueDrafts':
      for (const id of (row as unknown as DialogueDraft).expressionIds ?? []) push(out, 'expressionIds', 'expressions', id);
      break;
    case 'playlists':
    case 'appMeta':
      break;
  }
  return out;
}

/**
 * 같은 대상을 가리키는 고유 값 — id가 달라도 이 값이 같으면 같은 대상으로 본다.
 * (예: 같은 YouTube 영상, 같은 표현 문구) 복원 시 이미 있으면 중복 생성하지 않고 충돌로 표시한다.
 */
export function uniqueKeysOf(table: TableName, row: AnyRow): { label: string; key: string }[] {
  const out: { label: string; key: string }[] = [];
  const add = (label: string, value: unknown) => {
    if (typeof value === 'string' && value.length > 0) out.push({ label, key: `${table}.${label}:${value}` });
  };
  switch (table) {
    case 'expressions':
      add('normalizedKey', row.normalizedKey);
      break;
    case 'videos':
      add('youtubeVideoId', row.youtubeVideoId);
      break;
    case 'playlists':
      add('youtubePlaylistId', row.youtubePlaylistId);
      break;
    case 'dialogueCompositions':
      add('videoId', row.videoId);
      break;
    case 'dialogueProgress':
      add('dialogueId', row.dialogueId);
      break;
    case 'reviewStates':
      add('item', `${String(row.itemType)}:${String(row.itemId)}`);
      break;
    case 'keySentences':
      add('videoId+order', `${String(row.videoId)}#${String(row.order)}`);
      break;
    // v3 (B1) — 영상당 1개, 학습 대상은 영상+종류+표현+대화문 조합이 같으면 같은 대상
    case 'dayAssignments':
    case 'extractionJobs':
      add('videoId', row.videoId);
      break;
    case 'learningItems':
      add('video+kind+expression+dialogue', `${String(row.videoId ?? '')}|${String(row.kind)}|${String(row.expressionId)}|${String(row.dialogueId ?? '')}`);
      break;
    default:
      break;
  }
  return out;
}
