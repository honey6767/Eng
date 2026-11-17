import Dexie, { type EntityTable } from 'dexie';
import type { AiAskContext, AiAskTurn } from '@/types/aiApi';
import type { AiTaskState } from '@/repositories/contentStore';

/**
 * Chunk별 AI 질문 기록 — 학습 DB(my-english-study, 버전 30)와 완전히 따로 있는 IndexedDB.
 *
 * - 학습 DB의 표·버전·기록은 건드리지 않는다 (새 DB를 따로 만들 뿐, 기존 DB는 열지도 바꾸지도 않음)
 * - 질문과 답변은 지우거나 요약으로 바꾸지 않고 그대로 보관한다
 * - 진행 중 요청 상태(요청 식별자·보낸 내용)도 여기 따로 둔다 → 앱을 다시 열어도 같은 식별자로 이어서 확인
 */

export const QA_DB_NAME = 'my-english-study-ai-qa';

export interface AskAnswer {
  answer: string;
  grammar: { verdict: string; explain: string };
  natural: { verdict: string; explain: string };
  nuance: string;
  examples: { en: string; ko: string }[];
  /** 저장된 강의 설명에 실제로 있는 내용만 (AI 설명과 구분) */
  fromLecture: string;
  /** 확인할 수 없거나 확신하지 못하는 부분 */
  uncertain: string;
  /** 후속 질문 문맥용 요약 */
  summary: string;
}

/** Chunk 하나에 대한 대화 세션 */
export interface QaSession {
  id: string;
  /** 학습 항목 id (예전 자료에서 화면에서만 묶은 핵심 Chunk는 inferred:… id) */
  chunkKey: string;
  chunkLabel: string;
  role: AiAskContext['role'];
  videoId: string | null;
  videoTitle: string;
  dayNumber: number | null;
  /** 세션을 시작할 때의 Chunk 정보 (질문할 때 함께 보냄) */
  context: AiAskContext;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
}

export type QaTurnStatus = 'pending' | 'answered' | 'failed';

/** 질문 하나와 그 답변 */
export interface QaTurn {
  id: string;
  sessionId: string;
  /** 세션 안 순서 (1부터) */
  turn: number;
  /** 바로 앞 질문 (후속 질문 관계) */
  parentTurnId: string | null;
  question: string;
  status: QaTurnStatus;
  answer: AskAnswer | null;
  error: { code: string; message: string; httpStatus: number | null } | null;
  requestId: string | null;
  chunkKey: string;
  chunkLabel: string;
  videoId: string | null;
  dayNumber: number | null;
  /** 이 질문을 보낼 때의 이전 대화 요약 (다시 시도해도 같은 문맥) */
  history: AiAskTurn[];
  createdAt: string;
  answeredAt: string | null;
}

export class QaDatabase extends Dexie {
  sessions!: EntityTable<QaSession, 'id'>;
  turns!: EntityTable<QaTurn, 'id'>;
  tasks!: EntityTable<{ key: string; state: AiTaskState }, 'key'>;

  constructor(name = QA_DB_NAME) {
    super(name);
    this.version(1).stores({
      sessions: 'id, chunkKey, videoId, dayNumber, updatedAt',
      turns: 'id, sessionId, chunkKey, videoId, dayNumber, createdAt, status',
      tasks: 'key',
    });
  }
}
