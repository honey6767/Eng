import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { describeGeminiFailure, estimateRequestTokens, gateWaitMs, handleAiExtract, parseCaps, readUsage, sweepLedger, workKeyForBody, type AiCaps } from './extractHandler.ts';
import { memoryLedgerStore, pacificDate, nextPacificMidnight, type LedgerStore } from './ledger.ts';
import { createMockGemini } from './mockGemini.ts';
import { sqliteLedgerStore } from './durableObject.ts';
import type { GeminiClient } from './gemini.ts';

const require = createRequire(import.meta.url);
const KEY = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const caps: AiCaps = { dailyVideoSec: 3600, dailyRequests: 5, maxVideoSec: 1800 };
const body = (videoId = 'eNODHkrNuDA', durationSec = 295) => ({ videoId, durationSec, promptVersion: 'v1' });
const T = Date.parse('2026-11-15T12:00:00Z');

/** Durable Object와 같은 SQLite 저장소 — Node 내장 SQLite(동기)로 sql.exec를 흉내 낸다 */
function nodeSqliteStore(): LedgerStore {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      const isSelect = /^\s*select/i.test(query);
      const rows = isSelect ? stmt.all(...bindings) : (stmt.run(...bindings), []);
      return { toArray: () => rows as Record<string, unknown>[] };
    },
  };
  return sqliteLedgerStore(sql);
}

for (const [label, makeStore] of [['메모리 장부', () => memoryLedgerStore()], ['SQLite 장부(Durable Object와 같은 코드)', nodeSqliteStore]] as const) {
  describe(`AI 추출 처리 — ${label}`, () => {
    const setup = (gemini: GeminiClient & { createCalls?: string[] } = createMockGemini(), now = () => T) => {
      const store = makeStore();
      return { store, gemini, run: (key: string | null, b: unknown = body()) => handleAiExtract({ idempotencyKey: key, body: b }, { store, gemini, caps, now }) };
    };

    it('새 식별자: 생성 1회 → 같은 식별자로 조회만 → 완료 결과, 이후에도 다시 생성하지 않음', async () => {
      const g = createMockGemini();
      const { run } = setup(g);
      const r1 = await run(KEY(1));
      expect(r1.status).toBe(202);
      expect(r1.body).toMatchObject({ ok: true, state: 'pending' });
      const r2 = await run(KEY(1)); // 조회 1: 진행 중
      expect(r2.body.state).toBe('pending');
      const r3 = await run(KEY(1)); // 조회 2: 완료
      expect(r3.body).toMatchObject({ ok: true, state: 'succeeded', model: 'gemini-3.6-flash' });
      const r4 = await run(KEY(1)); // 저장된 결과
      expect(r4.body).toEqual(r3.body);
      expect(g.createCalls).toHaveLength(1);
      expect(g.getCalls).toHaveLength(2);
    });

    it('같은 식별자가 동시에 10번 와도 Gemini 생성은 1번', async () => {
      const g = createMockGemini();
      const { run } = setup(g);
      const all = await Promise.all(Array.from({ length: 10 }, () => run(KEY(2))));
      expect(g.createCalls).toHaveLength(1);
      // 생성 뒤에 도착한 요청은 같은 interaction을 조회만 한다 (진행 중 또는 완료)
      expect(all.every((r) => r.body.ok && (r.body.state === 'pending' || r.body.state === 'succeeded'))).toBe(true);
    });

    it('배포 전 예전 기록(식별자 키)에 다른 내용은 409, 식별자 없음·형식 오류는 400 — Gemini 호출 없음', async () => {
      const g = createMockGemini();
      const { run, store } = setup(g);
      await run(KEY(3));
      // 예전 방식으로 저장된 기록(키 = 식별자)을 흉내 낸다
      const w = (await workKeyForBody(body()))!;
      store.put({ ...store.get(w)!, key: KEY(3) });
      expect((await run(KEY(3), body('eNODHkrNuDA', 300))).status).toBe(409);
      expect((await run(null)).status).toBe(400);
      expect((await run('not-a-uuid')).status).toBe(400);
      expect((await run(KEY(4), { videoId: 'bad', durationSec: 10, promptVersion: 'v1' })).status).toBe(400);
      expect(g.createCalls).toHaveLength(1);
    });

    it('하루 상한·긴 영상: Gemini를 부르지 않고 consumed=false, 다음 초기화 시각 안내', async () => {
      const g = createMockGemini();
      const { run } = setup(g);
      const long = await run(KEY(5), body('eNODHkrNuDA', 4000));
      expect(long.body).toMatchObject({ ok: false, code: 'too_long', consumed: false });
      expect(long.status).toBe(413);
      for (let i = 0; i < 5; i++) await run(KEY(10 + i), body(`video00000${i}`, 300));
      const capped = await run(KEY(20), body('video000099', 300));
      expect(capped.body).toMatchObject({ ok: false, code: 'daily_cap', consumed: false, retryAt: nextPacificMidnight(T) });
      expect(capped.status).toBe(429);
      expect(g.createCalls).toHaveLength(5);
    });

    it('Gemini 거절(400): consumed=false로 알리고 사용량을 되돌린다', async () => {
      const g = createMockGemini();
      const { run, store } = setup(g);
      const b = await run(KEY(31), body('mockBad0001', 300));
      expect(b.body).toMatchObject({ ok: false, code: 'gemini_rejected', consumed: false });
      expect(store.getUsage(pacificDate(T))).toMatchObject({ requests: 0, videoSec: 0 });
    });

    it('Gemini 무료 한도(429): consumed=false, 그날은 모든 요청 차단(다시 시도 포함, Gemini 호출 없음), 같은 식별자로 다시 물어도 재생성 없음', async () => {
      const g = createMockGemini();
      const { run, store } = setup(g);
      const q = await run(KEY(30), body('mockQuota01', 300));
      expect(q.status).toBe(429);
      expect(q.body).toMatchObject({ ok: false, code: 'gemini_quota', consumed: false });
      expect(store.getUsage(pacificDate(T)).requests).toBe(caps.dailyRequests); // 상한까지 채움 → 다른 기기도 막힘
      const other = await run(KEY(32), body('otherVideo1', 300));
      expect(other.body).toMatchObject({ ok: false, code: 'daily_cap' });
      const retry = await run(KEY(33), { ...body('otherVideo2', 300), retryFailed: true });
      expect(retry.body).toMatchObject({ ok: false, code: 'daily_cap' });
      await run(KEY(30), body('mockQuota01', 300));
      expect(g.createCalls).toEqual(['mockQuota01']);
    });

    it('작업이 한도 초과(RESOURCE_EXHAUSTED)로 끝나면: gemini_quota(보류, consumed=false)로 알리고 그날 모든 요청 차단 → 초기화 뒤 같은 작업을 1번 다시 생성할 수 있음', async () => {
      const g = createMockGemini();
      let t = T;
      const { run, store } = setup(g, () => t);
      expect((await run(KEY(34), body('mockExhaus1', 300))).body.state).toBe('pending'); // 생성
      expect((await run(KEY(34), body('mockExhaus1', 300))).body.state).toBe('pending'); // 진행 중
      const r = await run(KEY(34), body('mockExhaus1', 300));
      expect(r.status).toBe(429);
      expect(r.body).toMatchObject({ ok: false, code: 'gemini_quota', consumed: false });
      expect((r.body as { message: string; retryAt?: string }).message).toMatch(/오류 RESOURCE_EXHAUSTED\/429/);
      expect((r.body as { retryAt?: string }).retryAt).toBe(nextPacificMidnight(T));
      expect(store.getUsage(pacificDate(T)).requests).toBe(caps.dailyRequests);
      expect((await run(KEY(35), body('otherVideo1', 300))).body).toMatchObject({ code: 'daily_cap' });
      // 초기화 전에는 같은 작업을 새 식별자로 보내도 다시 생성하지 않음
      expect((await run(KEY(36), body('mockExhaus1', 300))).body).toMatchObject({ code: 'gemini_quota' });
      expect(g.createCalls).toEqual(['mockExhaus1']);
      // 초기화 뒤: 같은 작업을 다시 생성 (보류 작업 이어서)
      t = Date.parse(nextPacificMidnight(T)) + 1000;
      expect((await run(KEY(37), body('mockExhaus1', 300))).body.state).toBe('pending');
      expect(g.createCalls).toEqual(['mockExhaus1', 'mockExhaus1']);
    });

    it('자동 준비 몫: auto 요청은 하루 몫까지만(실제 요청 수 기준), 넘으면 Gemini 호출 없이 auto_cap — 사용자가 누른 요청은 계속 가능', async () => {
      const g = createMockGemini();
      const store = makeStore();
      const c: AiCaps = { dailyVideoSec: 6 * 3600, dailyRequests: 5, maxVideoSec: 1800, dailyAutoRequests: 2 };
      const run = (key: string, b: unknown) => handleAiExtract({ idempotencyKey: key, body: b }, { store, gemini: g, caps: c, now: () => T });
      expect((await run(KEY(40), { ...body('autoVideo01', 60), auto: true })).body.state).toBe('pending');
      expect((await run(KEY(41), { ...body('autoVideo02', 60), auto: true })).body.state).toBe('pending');
      const third = await run(KEY(42), { ...body('autoVideo03', 60), auto: true });
      expect(third.status).toBe(429);
      expect(third.body).toMatchObject({ ok: false, code: 'auto_cap', consumed: false });
      expect((third.body as { retryAt?: string }).retryAt).toBe(nextPacificMidnight(T));
      // 사용자가 누른 요청(같은 영상이어도)은 통과
      expect((await run(KEY(43), body('autoVideo03', 60))).body.state).toBe('pending');
      expect(g.createCalls).toEqual(['autoVideo01', 'autoVideo02', 'autoVideo03']);
      expect(store.getUsage(pacificDate(T)).requests).toBe(3);
      // 자동 표시는 작업 키에 들어가지 않음 (같은 작업이면 같은 결과를 함께 씀)
      expect(await workKeyForBody({ ...body('autoVideo01', 60), auto: true })).toBe(await workKeyForBody(body('autoVideo01', 60)));
    });

    it('Gemini가 거절(4xx)하면 자동 준비 몫도 되돌린다', async () => {
      const g = createMockGemini();
      const store = makeStore();
      const c: AiCaps = { dailyVideoSec: 6 * 3600, dailyRequests: 5, maxVideoSec: 1800, dailyAutoRequests: 1 };
      const run = (key: string, b: unknown) => handleAiExtract({ idempotencyKey: key, body: b }, { store, gemini: g, caps: c, now: () => T });
      expect((await run(KEY(44), { ...body('mockBad0002', 60), auto: true })).body).toMatchObject({ code: 'gemini_rejected' });
      expect((await run(KEY(45), { ...body('autoVideo04', 60), auto: true })).body.state).toBe('pending');
    });

    it('요청 간격: 생성 요청 사이 15초 — 그 전에는 Gemini를 부르지 않고 잠시 뒤로(기록도 만들지 않음), 긴 영상은 앞뒤 60초', async () => {
      const g = createMockGemini();
      const store = makeStore();
      let t = T;
      const c: AiCaps = { dailyVideoSec: 6 * 3600, dailyRequests: 10, maxVideoSec: 1800, minGapMs: 15_000 };
      const run = (key: string, b: unknown) => handleAiExtract({ idempotencyKey: key, body: b }, { store, gemini: g, caps: c, now: () => t });
      expect((await run(KEY(50), body('gapVideo001', 60))).body.state).toBe('pending');
      t += 5_000;
      const wait = await run(KEY(51), body('gapVideo002', 60));
      expect(wait.status).toBe(202);
      expect(wait.body).toMatchObject({ state: 'pending', interactionId: null, retryAfterSec: 10 });
      expect(g.createCalls).toEqual(['gapVideo001']);
      expect(store.getUsage(pacificDate(T)).requests).toBe(1); // 기다리는 동안은 세지 않음
      t += 10_000;
      expect((await run(KEY(51), body('gapVideo002', 60))).body.state).toBe('pending');
      expect(g.createCalls).toEqual(['gapVideo001', 'gapVideo002']);
      // 긴 영상(추정 60K 토큰 초과)은 앞 요청 뒤 60초가 지나야
      t += 15_000;
      expect((await run(KEY(52), body('bigVideo001', 1200))).body).toMatchObject({ interactionId: null, retryAfterSec: 45 });
      t += 45_000;
      expect((await run(KEY(52), body('bigVideo001', 1200))).body.state).toBe('pending');
      // 긴 영상 다음 요청도 60초 뒤
      t += 15_000;
      expect((await run(KEY(53), body('gapVideo003', 60))).body).toMatchObject({ interactionId: null, retryAfterSec: 45 });
      expect(g.createCalls).toEqual(['gapVideo001', 'gapVideo002', 'bigVideo001']);
    });


    it('생성 결과를 모르면(네트워크·5xx) 결과 모름(consumed=true), 같은 식별자로 다시 물어도 재생성 없음', async () => {
      let calls = 0;
      const g: GeminiClient = { create: async () => (calls++, { kind: 'unknown', httpStatus: 503, message: 'x' }), get: async () => ({ kind: 'gone' }) };
      const { run, store } = setup(g);
      expect((await run(KEY(40))).body).toMatchObject({ ok: false, code: 'unknown', consumed: true });
      expect((await run(KEY(40))).body).toMatchObject({ code: 'unknown', consumed: true });
      expect(calls).toBe(1);
      expect(store.getUsage(pacificDate(T)).requests).toBe(1); // 사용한 것으로 셈
    });

    it('creating 점유가 끝났는데 결과가 없으면 조회·정리 때 결과 모름으로 (자동 재생성 없음)', async () => {
      let t = T;
      const never: GeminiClient = { create: () => new Promise(() => {}), get: async () => ({ kind: 'gone' }) };
      const { run, store } = setup(never, () => t);
      void run(KEY(50)); // 응답이 오지 않는 생성
      await new Promise((r) => setTimeout(r, 20));
      const w50 = (await workKeyForBody(body()))!;
      expect(store.get(w50)?.state).toBe('creating');
      expect((await run(KEY(50))).body.state).toBe('pending');
      t += 3 * 60_000;
      expect((await run(KEY(50))).body).toMatchObject({ code: 'unknown', consumed: true });
      // 정리 함수도 같은 결과 (여러 번 실행해도 같음)
      const store2 = makeStore();
      store2.put({ ...store.get(w50)!, state: 'creating', leaseUntil: T });
      sweepLedger(store2, T + 10 * 60_000, { resultMs: 86_400_000, rowMs: 7 * 86_400_000 });
      sweepLedger(store2, T + 10 * 60_000, { resultMs: 86_400_000, rowMs: 7 * 86_400_000 });
      expect(store2.get(w50)).toMatchObject({ state: 'failed', failureCode: 'unknown', consumed: true });
    });

    it('Gemini 실패·보관 기간 지남(404)은 consumed=true, 성공 결과는 24시간 뒤에도 보관 결과로 다시 받음', async () => {
      const g = createMockGemini();
      let t = T;
      const { run, store } = setup(g, () => t);
      await run(KEY(60), body('mockFail001', 300));
      await run(KEY(60), body('mockFail001', 300));
      expect((await run(KEY(60), body('mockFail001', 300))).body).toMatchObject({ code: 'gemini_failed', consumed: true });
      const gone: GeminiClient = { create: async () => ({ kind: 'created', interactionId: 'x', status: 'in_progress' }), get: async () => ({ kind: 'gone' }) };
      const s2 = setup(gone);
      await s2.run(KEY(61));
      expect((await s2.run(KEY(61))).body).toMatchObject({ code: 'expired', consumed: true });
      // 성공 결과도 24시간 뒤 본문 정리
      await run(KEY(62));
      await run(KEY(62));
      await run(KEY(62));
      t += 25 * 3_600_000;
      sweepLedger(store, t, { resultMs: 24 * 3_600_000, rowMs: 7 * 24 * 3_600_000 });
      expect((await run(KEY(62))).body).toMatchObject({ state: 'succeeded' });
      // 기록이 7일 뒤 지워져도 보관 결과는 남는다 (다시 생성하지 않음)
      t += 8 * 24 * 3_600_000;
      sweepLedger(store, t, { resultMs: 24 * 3_600_000, rowMs: 7 * 24 * 3_600_000 });
      const before = g.createCalls.length;
      expect((await run(KEY(63))).body).toMatchObject({ state: 'succeeded' });
      expect(g.createCalls.length).toBe(before);
    });

    it('여러 기기: 식별자가 달라도 같은 작업이면 생성 1회 — 진행 중이면 기다리고, 끝나면 보관 결과를 받음', async () => {
      const g = createMockGemini();
      const { run } = setup(g);
      const a = await Promise.all([run(KEY(70)), run(KEY(71)), run(KEY(72))]); // 세 기기가 동시에
      expect(g.createCalls).toHaveLength(1);
      expect(a.every((r) => r.body.ok)).toBe(true);
      expect(a.map((r) => r.body.requestId)).toEqual([KEY(70), KEY(71), KEY(72)]); // 응답 식별자는 각자 보낸 것
      let done = await run(KEY(71));
      if (done.body.state !== 'succeeded') done = await run(KEY(71));
      expect(done.body.state).toBe('succeeded');
      const later = await run(KEY(73)); // 나중에 연 다른 기기
      expect(later.body).toMatchObject({ state: 'succeeded' });
      expect(g.createCalls).toHaveLength(1);
    });

    it('결과를 모르는 실패는 같은 작업을 다시 보내도 재생성 없음, 사용자가 다시 시도(retryFailed)할 때만 1회 재생성', async () => {
      let calls = 0;
      const g: GeminiClient = { create: async () => (calls++, calls === 1 ? { kind: 'unknown', httpStatus: 503, message: 'x' } : { kind: 'created', interactionId: 'i2', status: 'in_progress' }), get: async () => ({ kind: 'running', status: 'in_progress' }) };
      const { run } = setup(g);
      expect((await run(KEY(80))).body).toMatchObject({ code: 'unknown', consumed: true });
      expect((await run(KEY(81))).body).toMatchObject({ code: 'unknown' }); // 다른 기기·새 식별자여도
      expect(calls).toBe(1);
      expect((await run(KEY(82), { ...body(), retryFailed: true })).body).toMatchObject({ state: 'pending' });
      expect((await run(KEY(83), { ...body(), retryFailed: true })).body).toMatchObject({ state: 'pending' }); // 이미 진행 중 → 조회만
      expect(calls).toBe(2);
    });

    it('무료 한도(429) 실패는 초기화 시각 전에는 다시 생성하지 않고, 지나면 이어서 생성', async () => {
      const g = createMockGemini();
      let t = T;
      const { run } = setup(g, () => t);
      await run(KEY(90), body('mockQuota02', 300));
      await run(KEY(91), body('mockQuota02', 300));
      expect(g.createCalls).toHaveLength(1);
      t = Date.parse(nextPacificMidnight(T)) + 1000;
      await run(KEY(92), body('mockQuota02', 300));
      expect(g.createCalls).toHaveLength(2);
    });
  });
}

for (const [label, makeStore] of [['메모리 장부', () => memoryLedgerStore()], ['SQLite 장부(Durable Object와 같은 코드)', nodeSqliteStore]] as const) {
  describe(`AI 질문 기능 제외 — ${label}`, () => {
    it('질문 요청(task: ask)은 받지 않는다 — Gemini 호출도, 사용량 집계도, 장부 기록도 없음', async () => {
      const store = makeStore();
      const g = createMockGemini();
      const caps: AiCaps = { dailyVideoSec: 3600, dailyRequests: 5, maxVideoSec: 1800 };
      const askBody = { task: 'ask', sessionId: 's1', turn: 1, context: { source: 'Day 11', dayNumber: 11, role: 'extra', base: 'look tired' }, history: [], question: '질문', promptVersion: 'q1' };
      const res = await handleAiExtract({ idempotencyKey: KEY(901), body: askBody }, { store, gemini: g, caps, now: () => T });
      expect(res.status).toBe(400);
      expect(g.createCalls).toHaveLength(0);
      expect(store.getUsage(pacificDate(T)).requests).toBe(0);
      expect(store.countCounted('ask', pacificDate(T))).toBe(0);
      expect(await workKeyForBody(askBody)).toBeNull();
      expect(parseCaps({})).toEqual({ dailyVideoSec: 6 * 3600, dailyRequests: 16, maxVideoSec: 30 * 60, dailyAutoRequests: 6, minGapMs: 15_000 });
      expect(parseCaps({ AI_DAILY_REQUEST_CAP: '4', AI_DAILY_AUTO_CAP: '9', AI_MIN_GAP_SEC: '0' })).toMatchObject({ dailyRequests: 4, dailyAutoRequests: 4, minGapMs: 0 });
    });
  });
}

describe('Gemini 실패 상세 기록', () => {
  it('상태 · 오류 코드 · 경과 · 토큰 · 작업 id 끝자리 · 추가 오류를 기존 메시지 앞뒤에 붙이고 1,000자로 자른다', () => {
    const msg = describeGeminiFailure('There was a problem processing your request.', { status: 'failed', errors: [{ code: 'INTERNAL/13', message: 'There was a problem processing your request.' }, { code: 'X', message: '두 번째' }], usage: { inputTokens: 1200, outputTokens: 0, videoTokens: null, thoughtTokens: 35 } }, 'v1_abcdef123456', 12);
    expect(msg).toBe('[Gemini 상태 failed · 오류 INTERNAL/13, X · 생성 후 12초 · 토큰 입력 1200 · 출력 0 · 생각 35 · 작업 …123456] There was a problem processing your request. (추가 오류: 두 번째)');
    expect(describeGeminiFailure('m', undefined, null, 3)).toBe('[Gemini 상태 알 수 없음 · 생성 후 3초] m');
    expect(describeGeminiFailure('x'.repeat(2000), undefined, null, 1)).toHaveLength(1000);
  });

  it('처리 중 실패하면 상세가 실패 메시지에 남고, 표 구조·사용량 집계는 그대로 (다시 생성하지 않음)', async () => {
    const store = memoryLedgerStore();
    const g = createMockGemini();
    const caps: AiCaps = { dailyVideoSec: 3600, dailyRequests: 5, maxVideoSec: 1800 };
    const run = (key: string) => handleAiExtract({ idempotencyKey: key, body: body('mockFail009', 300) }, { store, gemini: g, caps, now: () => T });
    expect((await run(KEY(950))).body.state).toBe('pending'); // 생성
    expect((await run(KEY(950))).body.state).toBe('pending'); // 첫 조회: 진행 중
    const r = await run(KEY(950)); // 다음 조회: 실패로 끝남
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ code: 'gemini_failed', consumed: true });
    expect((r.body as { message: string }).message).toMatch(/^\[Gemini 상태 failed · 오류 INTERNAL\/13 · 생성 후 0초 · 작업 …[\w-]{1,6}\] 가짜 실패$/);
    expect(g.createCalls).toEqual(['mockFail009']);
    expect(store.getUsage(pacificDate(T)).requests).toBe(1);
  });
});

describe('요청 토큰 추정·관문·사용량 조회', () => {
  it('토큰 추정: 영상은 1초 100토큰 + 출력 여유, 텍스트는 3자에 1토큰 + 출력 여유', () => {
    expect(estimateRequestTokens({ videoId: 'eNODHkrNuDA', durationSec: 300, promptVersion: 'v1' }, 300)).toBe(45_000);
    expect(estimateRequestTokens({ videoId: 'eNODHkrNuDA', durationSec: 1800, promptVersion: 'v1' }, 1800)).toBe(195_000); // 30분도 TPM 250K 안
    const text = estimateRequestTokens({ task: 'dialogue', chunks: [{ ref: 'a', text: 'could use', meaningKo: '필요하다', source: 'Day 11' }, { ref: 'b', text: 'look tired', meaningKo: '피곤해 보이다', source: 'Day 11' }], lineCount: 8, promptVersion: 'd2' } as never, 0);
    expect(text).toBeGreaterThan(15_000);
    expect(text).toBeLessThan(16_000);
  });
  it('관문: 첫 요청·간격 0은 대기 없음, 15초 간격, 큰 요청은 60초', () => {
    expect(gateWaitMs(null, 50_000, 0, 15_000)).toBe(0);
    expect(gateWaitMs({ at: 0, tokens: 20_000 }, 20_000, 1_000, 0)).toBe(0);
    expect(gateWaitMs({ at: 0, tokens: 20_000 }, 20_000, 1_000, 15_000)).toBe(14_000);
    expect(gateWaitMs({ at: 0, tokens: 20_000 }, 20_000, 20_000, 15_000)).toBe(0);
    expect(gateWaitMs({ at: 0, tokens: 20_000 }, 120_000, 20_000, 15_000)).toBe(40_000);
    expect(gateWaitMs({ at: 0, tokens: 120_000 }, 20_000, 20_000, 15_000)).toBe(40_000);
  });
  it('사용량 조회: 전체·자동 준비 사용량과 다음 초기화 시각 (읽기만)', async () => {
    const store = memoryLedgerStore();
    const g = createMockGemini();
    const c: AiCaps = { dailyVideoSec: 3600, dailyRequests: 16, maxVideoSec: 1800, dailyAutoRequests: 6 };
    await handleAiExtract({ idempotencyKey: KEY(970), body: { ...body('usageVideo1', 60), auto: true } }, { store, gemini: g, caps: c, now: () => T });
    expect(readUsage(store, c, T)).toMatchObject({ ok: true, requests: 1, dailyRequests: 16, auto: { used: 1, cap: 6 }, resetAt: nextPacificMidnight(T) });
  });
});
