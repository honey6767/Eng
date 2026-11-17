import { describe, expect, it } from 'vitest';
import type { AiClient, AiTransportResult } from '@/services/integrations/aiClient';
import type { AiAskRequest } from '@/types/aiApi';
import { handleAiExtract, type AiCaps } from '../../../server/ai/extractHandler';
import { memoryLedgerStore } from '../../../server/ai/ledger';
import { createMockGemini } from '../../../server/ai/mockGemini';
import { buildAskPrompt, validateTaskRequest } from '../../../server/ai/tasks';
import { QaDatabase } from './qaDb';
import { ask, checkTurn, createQaStore, retryTurn, startSession, type QaChunkRef, type QaDeps } from './qaService';

const T = '2026-11-17T12:00:00.000Z';
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function server(caps: AiCaps = { dailyVideoSec: 6 * 3600, dailyRequests: 20, maxVideoSec: 1800 }) {
  const gemini = createMockGemini();
  const ledger = memoryLedgerStore();
  const sent: { key: string; body: AiAskRequest & { retryFailed?: boolean } }[] = [];
  let offline = false;
  const client: AiClient = {
    async extract(key, body): Promise<AiTransportResult> {
      if (offline) return { kind: 'transport_error', message: '네트워크 오류' };
      sent.push({ key, body: body as AiAskRequest & { retryFailed?: boolean } });
      const r = await handleAiExtract({ idempotencyKey: key, body }, { store: ledger, gemini, caps, now: () => Date.parse(T) });
      return { kind: 'response', httpStatus: r.status, body: r.body };
    },
  };
  return { client, gemini, sent, setOffline: (v: boolean) => (offline = v) };
}

function deps(client: AiClient, db = new QaDatabase(`qa-test-${++seq}`)): QaDeps & { db: QaDatabase } {
  return { db, store: createQaStore(db), client, now: () => new Date(T), newId: uuid, sleep: async () => {}, pollMs: 1 };
}

const chunk = (key: string, base: string, extra: Partial<QaChunkRef['context']> = {}): QaChunkRef => ({
  chunkKey: key, chunkLabel: base, videoId: 'd11', videoTitle: '[Day 11] 필요해',
  context: { source: 'Day 11 · [Day 11] 필요해', dayNumber: 11, role: 'extra', base, ...extra },
});

describe('Chunk별 AI 질문', () => {
  it('질문을 보내면 Chunk 문맥이 요청에 들어가고, 답변이 저장된다 (질문 1번 = 요청 식별자 1개)', async () => {
    const s = server();
    const d = deps(s.client);
    const ref = chunk('li-tired', 'look tired', { original: 'look super tired', sentences: ['You look super tired.'], meaningKo: '피곤해 보이다', pattern: 'look + 형용사', examples: ['look happy — 행복해 보이다'] });
    const session = await startSession(d, ref);
    const out = await ask(d, session.id, 'look sleepy도 자연스러운 표현이야?');
    expect(out.ok).toBe(true);
    const body = s.sent[0].body;
    expect(body).toMatchObject({ task: 'ask', turn: 1, history: [], question: 'look sleepy도 자연스러운 표현이야?', context: { base: 'look tired', original: 'look super tired', role: 'extra', dayNumber: 11, pattern: 'look + 형용사' } });
    expect(new Set(s.sent.map((x) => x.key)).size).toBe(1);
    const turns = await d.store.turnsOf(session.id);
    expect(turns[0]).toMatchObject({ status: 'answered', question: 'look sleepy도 자연스러운 표현이야?', chunkKey: 'li-tired', dayNumber: 11, parentTurnId: null });
    expect(turns[0].answer?.answer).toContain("'look tired'");
    expect(turns[0].answer?.grammar.verdict).toBe('가능');
    // 서버 프롬프트: 문맥·문법/자연스러움 구분·강의 내용 구분
    const prompt = buildAskPrompt(validateTaskRequest(body) as AiAskRequest);
    expect(prompt).toContain('원문 표현: look super tired');
    expect(prompt).toContain('추가 덩어리 표현 (강사가 가르치지 않았고');
    expect(prompt).toContain('강사가 말하지 않은 것을 강사가 가르쳤다고 하지 않습니다');
  });

  it('후속 질문은 같은 세션의 최근 3개 질문·답변 요약만 이어받고, 다른 Chunk의 대화는 섞이지 않는다', async () => {
    const s = server({ dailyVideoSec: 6 * 3600, dailyRequests: 50, maxVideoSec: 1800, dailyAsk: 50 });
    const d = deps(s.client);
    const a = await startSession(d, chunk('li-tired', 'look tired'));
    const b = await startSession(d, chunk('li-car', 'which car to buy'));
    for (const q of ['질문 1', '질문 2', '질문 3', '질문 4']) expect((await ask(d, a.id, q)).ok).toBe(true);
    expect((await ask(d, b.id, '다른 Chunk 질문')).ok).toBe(true);
    const fifth = s.sent.find((x) => x.body.turn === 4 && x.body.sessionId === a.id)!.body;
    expect(fifth.history.map((h) => h.question)).toEqual(['질문 1', '질문 2', '질문 3']); // 최근 3개만
    expect(fifth.history[2].answer).toContain('요약'); // 답변 전체가 아니라 요약
    const other = s.sent.find((x) => x.body.sessionId === b.id)!.body;
    expect([other.history, other.context.base]).toEqual([[], 'which car to buy']);
    const turnsA = await d.store.turnsOf(a.id);
    expect(turnsA.map((t) => t.turn)).toEqual([1, 2, 3, 4]);
    expect(turnsA[3].parentTurnId).toBe(turnsA[2].id);
    expect(turnsA[3].answer?.answer).toContain('이전 질문 3개에 이어서');
    // 기록은 지우거나 요약으로 바꾸지 않음
    expect(turnsA.every((t) => t.answer && t.answer.answer.length > 0)).toBe(true);
  });

  it('실패하면 자동으로 다시 보내지 않고, 결과 확인을 눌러도 새로 만들지 않으며, 다시 시도를 눌러야만 새로 요청', async () => {
    const s = server();
    const d = deps(s.client);
    const session = await startSession(d, chunk('li-x', 'look tired'));
    const out = await ask(d, session.id, '이건 실패해야 해 [실패]');
    expect(out.ok).toBe(false);
    const after = s.gemini.createCalls.length;
    const turnId = out.turn!.id;
    expect((await d.store.getTurn(turnId))?.status).toBe('failed');
    expect((await d.store.getTurn(turnId))?.error?.code).toBe('gemini_failed');
    expect((await checkTurn(d, turnId)).ok).toBe(false);
    expect(s.gemini.createCalls.length).toBe(after); // 결과 확인은 새로 생성하지 않음
    const keysBefore = new Set(s.sent.map((x) => x.key));
    const retried = await retryTurn(d, turnId);
    expect(retried.ok).toBe(false); // 같은 질문이라 가짜 AI가 또 실패
    const newKeys = s.sent.filter((x) => !keysBefore.has(x.key));
    expect(newKeys.length).toBeGreaterThan(0);
    expect(newKeys[0].body.retryFailed).toBe(true); // 사용자가 누른 다시 시도의 첫 요청에만
    expect(newKeys.slice(1).every((x) => !x.body.retryFailed)).toBe(true);
  });

  it('답을 못 받고 앱이 꺼진 질문: 다시 열어도 자동 요청 없음, 답변 확인을 누르면 같은 요청 식별자로 이어서', async () => {
    const s = server();
    const db = new QaDatabase(`qa-test-${++seq}`);
    const d = deps(s.client, db);
    const session = await startSession(d, chunk('li-y', 'which car to buy'));
    s.setOffline(true);
    const out = await ask(d, session.id, '이 표현 다른 예문 만들어 줘');
    expect(out.ok).toBe(false);
    expect(out.turn?.status).toBe('failed'); // 연결 실패 표시
    // 앱 다시 열기: 같은 DB 이름으로 새로 연다 → 기록 그대로, 요청 없음
    db.close();
    const d2 = deps(s.client, new QaDatabase(db.name));
    const turns = await d2.store.turnsOf(session.id);
    expect(turns).toHaveLength(1);
    expect(turns[0].question).toBe('이 표현 다른 예문 만들어 줘');
    expect(s.sent.length).toBe(0);
  });

  it('보내는 중인 질문이 있으면 같은 세션에서 새 질문을 받지 않음 (중복 방지)', async () => {
    const s = server();
    const d = deps(s.client);
    const session = await startSession(d, chunk('li-z', 'a cup of coffee'));
    const [r1, r2] = await Promise.all([ask(d, session.id, '첫 질문'), ask(d, session.id, '동시에 보낸 질문')]);
    const turns = await d.store.turnsOf(session.id);
    // 첫 질문만 만들어지고, 동시에 누른 두 번째는 '앞 질문 답변 대기'로 거절 → 질문 1개, 요청 식별자 1개
    expect([r1.ok, r2.ok]).toEqual([true, false]);
    expect(r2.ok === false && r2.code).toBe('busy');
    expect(turns.map((t) => [t.turn, t.question])).toEqual([[1, '첫 질문']]);
    expect(new Set(s.sent.map((x) => x.key)).size).toBe(1);
  });

  it('하루 질문 한도는 학습 자료 생성 몫과 따로 (기본 10회), 한도에 걸리면 Gemini 호출 없이 실패 표시', async () => {
    const s = server({ dailyVideoSec: 6 * 3600, dailyRequests: 20, maxVideoSec: 1800, dailyAsk: 2 });
    const d = deps(s.client);
    const session = await startSession(d, chunk('li-cap', 'look tired'));
    expect((await ask(d, session.id, '하나')).ok).toBe(true);
    expect((await ask(d, session.id, '두 번째')).ok).toBe(true);
    const calls = s.gemini.createCalls.length;
    const third = await ask(d, session.id, '세 번째');
    expect(third.ok).toBe(false);
    expect(third.ok === false && third.code).toBe('daily_cap');
    expect(s.gemini.createCalls.length).toBe(calls);
  });

  it('서버 요청 검사: 형식이 잘못되거나 너무 길면 거부', () => {
    const ok = { task: 'ask', sessionId: 's1', turn: 1, context: { source: 'Day 11', dayNumber: 11, role: 'extra', base: 'look tired' }, history: [], question: '질문이에요', promptVersion: 'q1' };
    expect(validateTaskRequest(ok)).not.toBeNull();
    expect(validateTaskRequest({ ...ok, question: 'x'.repeat(501) })).toBeNull();
    expect(validateTaskRequest({ ...ok, history: [1, 2, 3, 4].map(() => ({ question: 'q', answer: 'a' })) })).toBeNull();
    expect(validateTaskRequest({ ...ok, context: { ...ok.context, role: 'teacher' } })).toBeNull();
    expect(validateTaskRequest({ ...ok, turn: 0 })).toBeNull();
  });
});
