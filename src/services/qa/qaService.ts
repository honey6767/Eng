import { AI_ASK_PROMPT_VERSION, ASK_LIMITS, type AiAskContext, type AiAskRequest, type AiAskTurn } from '@/types/aiApi';
import type { AiClient } from '@/services/integrations/aiClient';
import { markApplied, runAiTask, type TaskProgress } from '@/services/ai/taskRunner';
import type { AiTaskState } from '@/repositories/contentStore';
import type { AskAnswer, QaDatabase, QaSession, QaTurn } from './qaDb';

/**
 * Chunk별 AI 질문
 *
 * - 사용자가 질문을 직접 보낼 때만 요청한다. 화면 진입·탭 이동·새로고침으로는 요청하지 않는다
 * - 질문(턴)마다 요청 식별자 1개. 보내기 전에 질문을 먼저 저장한다 → 실패해도 질문은 남는다
 * - 실패하면 자동으로 다시 보내지 않는다. 사용자가 '다시 시도'를 누를 때만 새로 요청
 * - 앱을 닫았다 열어 답을 못 받은 질문은 '답변 확인'을 누르면 같은 식별자로 결과만 확인 (새로 생성하지 않음)
 * - 후속 질문은 같은 세션(같은 Chunk)의 최근 3개 질문과 답변 요약만 문맥으로 보낸다 (다른 Chunk 대화는 섞지 않음)
 */

export interface QaStore {
  getSession(id: string): Promise<QaSession | undefined>;
  putSession(s: QaSession): Promise<void>;
  sessionsOfChunk(chunkKey: string): Promise<QaSession[]>;
  allSessions(): Promise<QaSession[]>;
  getTurn(id: string): Promise<QaTurn | undefined>;
  putTurn(t: QaTurn): Promise<void>;
  turnsOf(sessionId: string): Promise<QaTurn[]>;
  allTurns(): Promise<QaTurn[]>;
  getTask(key: string): Promise<AiTaskState | null>;
  putTask(key: string, state: AiTaskState | null): Promise<void>;
}

export function createQaStore(db: QaDatabase): QaStore {
  return {
    getSession: (id) => db.sessions.get(id),
    putSession: async (s) => void (await db.sessions.put(s)),
    sessionsOfChunk: async (k) => (await db.sessions.where('chunkKey').equals(k).toArray()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    allSessions: async () => (await db.sessions.toArray()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    getTurn: (id) => db.turns.get(id),
    putTurn: async (t) => void (await db.turns.put(t)),
    turnsOf: async (sid) => (await db.turns.where('sessionId').equals(sid).toArray()).sort((a, b) => a.turn - b.turn),
    allTurns: async () => (await db.turns.toArray()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    getTask: async (key) => (await db.tasks.get(key))?.state ?? null,
    putTask: async (key, state) => {
      if (state) await db.tasks.put({ key, state });
      else await db.tasks.delete(key);
    },
  };
}

export interface QaDeps {
  store: QaStore;
  client: AiClient;
  now?: () => Date;
  newId?: () => string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollMs?: number;
}

export interface QaChunkRef {
  chunkKey: string;
  chunkLabel: string;
  videoId: string | null;
  videoTitle: string;
  context: AiAskContext;
}

const nowIso = (deps: QaDeps) => (deps.now ?? (() => new Date()))().toISOString();
const newId = (deps: QaDeps) => (deps.newId ?? (() => crypto.randomUUID()))();
const taskKey = (turnId: string) => `ask:${turnId}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 문맥 필드 길이 맞추기 (서버 검사 한도 안으로) */
export function fitContext(c: AiAskContext): AiAskContext {
  const L = ASK_LIMITS.fieldChars;
  const out: AiAskContext = { source: clip(c.source, L), dayNumber: c.dayNumber, role: c.role, base: clip(c.base, L) };
  for (const k of ['original', 'meaningKo', 'nuance', 'taught', 'pattern'] as const) if (c[k]) out[k] = clip(c[k]!, L);
  if (c.sentences?.length) out.sentences = c.sentences.filter(Boolean).slice(0, ASK_LIMITS.maxSentences).map((x) => clip(x, L));
  if (c.examples?.length) out.examples = c.examples.filter(Boolean).slice(0, ASK_LIMITS.maxExamples).map((x) => clip(x, L));
  return out;
}

/** 새 대화 세션 (Chunk마다 따로) */
export async function startSession(deps: QaDeps, ref: QaChunkRef): Promise<QaSession> {
  const t = nowIso(deps);
  const s: QaSession = {
    id: newId(deps), chunkKey: ref.chunkKey, chunkLabel: ref.chunkLabel, role: ref.context.role, videoId: ref.videoId, videoTitle: ref.videoTitle,
    dayNumber: ref.context.dayNumber, context: fitContext(ref.context), createdAt: t, updatedAt: t, turnCount: 0,
  };
  await deps.store.putSession(s);
  return s;
}

/** 후속 질문 문맥: 같은 세션에서 답을 받은 최근 3개만, 답변은 요약으로 */
export function historyOf(turns: QaTurn[]): AiAskTurn[] {
  return turns
    .filter((t) => t.status === 'answered' && t.answer)
    .slice(-ASK_LIMITS.historyTurns)
    .map((t) => ({ question: clip(t.question, ASK_LIMITS.questionChars), answer: clip(t.answer!.summary || t.answer!.answer, ASK_LIMITS.historyAnswerChars) }));
}

export function buildAskRequest(session: QaSession, turn: QaTurn): AiAskRequest {
  return { task: 'ask', sessionId: session.id, turn: turn.turn, context: session.context, history: turn.history, question: turn.question, promptVersion: AI_ASK_PROMPT_VERSION };
}

const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const verdict = (v: unknown) => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { verdict: str(o.verdict, 30), explain: str(o.explain) };
};

/** AI 답변 검사 — 형식이 맞지 않으면 오류 문자열 */
export function parseAskAnswer(text: string): AskAnswer | string {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'JSON 형식이 아니에요.';
  }
  const answer = str(raw.answer);
  if (!answer) return '답변이 비어 있어요.';
  return {
    answer,
    grammar: verdict(raw.grammar),
    natural: verdict(raw.natural),
    nuance: str(raw.nuance),
    examples: (Array.isArray(raw.examples) ? (raw.examples as Record<string, unknown>[]) : []).map((e) => ({ en: str(e?.en, 300), ko: str(e?.ko, 300) })).filter((e) => e.en).slice(0, 5),
    fromLecture: str(raw.fromLecture, 600),
    uncertain: str(raw.uncertain, 600),
    summary: str(raw.summary, ASK_LIMITS.historyAnswerChars),
  };
}

/** 이 페이지에서 지금 처리 중인 질문 (같은 질문을 두 번 보내지 않게) */
const inFlight = new Set<string>();
export const isInFlight = (turnId: string) => inFlight.has(turnId);

export type AskOutcome = { ok: true; turn: QaTurn } | { ok: false; turn: QaTurn | null; code: string; message: string };

/** 같은 세션의 질문 만들기는 한 번에 하나씩 (두 번 눌러도 같은 순서 번호의 질문이 두 개 생기지 않게) */
const sessionLocks = new Map<string, Promise<unknown>>();
function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  sessionLocks.set(sessionId, tail);
  void tail.then(() => {
    if (sessionLocks.get(sessionId) === tail) sessionLocks.delete(sessionId);
  });
  return next;
}

/** 질문 보내기 — 질문을 먼저 저장하고, 요청은 1번만 */
export async function ask(deps: QaDeps, sessionId: string, question: string, onProgress?: (p: TaskProgress) => void): Promise<AskOutcome> {
  const q = question.trim();
  if (q.length < ASK_LIMITS.minQuestionChars) return { ok: false, turn: null, code: 'too_short', message: '질문을 조금 더 자세히 적어 주세요.' };
  if (q.length > ASK_LIMITS.questionChars) return { ok: false, turn: null, code: 'too_long', message: `질문은 ${ASK_LIMITS.questionChars}자까지 보낼 수 있어요.` };
  const created = await withSessionLock(sessionId, () => createTurn(deps, sessionId, q));
  if (!('id' in created)) return created;
  return runTurn(deps, created.id, false, onProgress);
}

async function createTurn(deps: QaDeps, sessionId: string, q: string): Promise<QaTurn | Extract<AskOutcome, { ok: false }>> {
  const session = await deps.store.getSession(sessionId);
  if (!session) return { ok: false, turn: null, code: 'not_found', message: '대화를 찾지 못했어요.' };
  const turns = await deps.store.turnsOf(sessionId);
  const waiting = turns.find((t) => t.status === 'pending');
  if (waiting) return { ok: false, turn: waiting, code: 'busy', message: '앞 질문의 답변을 아직 받지 못했어요. 먼저 그 답변을 확인해 주세요.' };
  if (turns.length >= ASK_LIMITS.maxTurns) return { ok: false, turn: null, code: 'too_many', message: '이 대화는 질문이 너무 많아요. 새 대화를 시작해 주세요.' };
  const t = nowIso(deps);
  const last = turns[turns.length - 1];
  const turn: QaTurn = {
    id: newId(deps), sessionId, turn: (last?.turn ?? 0) + 1, parentTurnId: last?.id ?? null, question: q, status: 'pending', answer: null, error: null, requestId: null,
    chunkKey: session.chunkKey, chunkLabel: session.chunkLabel, videoId: session.videoId, dayNumber: session.dayNumber, history: historyOf(turns), createdAt: t, answeredAt: null,
  };
  await deps.store.putTurn(turn);
  await deps.store.putSession({ ...session, updatedAt: t, turnCount: turns.length + 1 });
  return turn;
}

/** 답을 못 받은 질문의 결과 확인 — 같은 요청 식별자로 조회만 (새로 생성하지 않음) */
export const checkTurn = (deps: QaDeps, turnId: string, onProgress?: (p: TaskProgress) => void) => runTurn(deps, turnId, false, onProgress);

/** 실패한 질문을 사용자가 직접 다시 보낼 때만 */
export async function retryTurn(deps: QaDeps, turnId: string, onProgress?: (p: TaskProgress) => void): Promise<AskOutcome> {
  const turn = await deps.store.getTurn(turnId);
  if (!turn || turn.status !== 'failed') return { ok: false, turn: turn ?? null, code: 'not_failed', message: '다시 시도할 질문이 아니에요.' };
  await deps.store.putTurn({ ...turn, status: 'pending', error: null });
  return runTurn(deps, turnId, true, onProgress);
}

async function runTurn(deps: QaDeps, turnId: string, retry: boolean, onProgress?: (p: TaskProgress) => void): Promise<AskOutcome> {
  if (inFlight.has(turnId)) return { ok: false, turn: (await deps.store.getTurn(turnId)) ?? null, code: 'in_flight', message: '이미 보내는 중이에요.' };
  inFlight.add(turnId);
  try {
    const turn = await deps.store.getTurn(turnId);
    if (!turn) return { ok: false, turn: null, code: 'not_found', message: '질문을 찾지 못했어요.' };
    if (turn.status === 'answered') return { ok: true, turn };
    if (!retry && turn.status === 'failed') return { ok: false, turn, code: 'failed', message: turn.error?.message ?? '실패한 질문이에요. 다시 시도를 눌러 주세요.' };
    const session = await deps.store.getSession(turn.sessionId);
    if (!session) return { ok: false, turn, code: 'not_found', message: '대화를 찾지 못했어요.' };
    const key = taskKey(turn.id);
    // 결과 확인만 할 때: 이미 실패로 끝난 요청이면 새로 보내지 않고 실패로 표시 (다시 보내기는 사용자가 '다시 시도'를 누를 때만)
    const prev = await deps.store.getTask(key);
    if (!retry && prev?.status === 'failed') {
      const failed: QaTurn = { ...turn, status: 'failed', requestId: prev.requestId, error: prev.error ?? { code: 'failed', message: '답변을 받지 못했어요.', httpStatus: null } };
      await deps.store.putTurn(failed);
      return { ok: false, turn: failed, code: failed.error!.code, message: failed.error!.message };
    }
    const out = await runAiTask(key, () => buildAskRequest(session, turn), { store: deps.store, client: deps.client, now: deps.now, newId: deps.newId, sleep: deps.sleep, pollMs: deps.pollMs }, (p) => onProgress?.(p), undefined, { retryFailed: retry });
    const requestId = (await deps.store.getTask(key))?.requestId ?? null;
    if (!out.ok) {
      const failed: QaTurn = { ...turn, status: 'failed', requestId, error: { code: out.code, message: out.message, httpStatus: out.httpStatus } };
      await deps.store.putTurn(failed);
      return { ok: false, turn: failed, code: out.code, message: out.message };
    }
    const answer = parseAskAnswer(out.text);
    if (typeof answer === 'string') {
      const failed: QaTurn = { ...turn, status: 'failed', requestId, error: { code: 'invalid_result', message: `AI 답변을 읽지 못했어요: ${answer}`, httpStatus: null } };
      await deps.store.putTurn(failed);
      const st = await deps.store.getTask(key);
      if (st) await deps.store.putTask(key, { ...st, status: 'failed', resultText: null });
      return { ok: false, turn: failed, code: 'invalid_result', message: failed.error!.message };
    }
    const done: QaTurn = { ...turn, status: 'answered', answer, error: null, requestId: out.requestId, answeredAt: nowIso(deps) };
    await deps.store.putTurn(done);
    await markApplied(deps.store, key);
    return { ok: true, turn: done };
  } finally {
    inFlight.delete(turnId);
  }
}
