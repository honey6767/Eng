import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { handleAiExtract, sweepLedger, type AiCaps } from './extractHandler.ts';
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

    it('같은 식별자에 다른 내용은 409, 식별자 없음·형식 오류는 400 — Gemini 호출 없음', async () => {
      const g = createMockGemini();
      const { run } = setup(g);
      await run(KEY(3));
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
      for (let i = 0; i < 5; i++) await run(KEY(10 + i), body(`video00000${i}`, 300));
      const capped = await run(KEY(20), body('video000099', 300));
      expect(capped.body).toMatchObject({ ok: false, code: 'daily_cap', consumed: false, retryAt: nextPacificMidnight(T) });
      expect(g.createCalls).toHaveLength(5);
    });

    it('Gemini 무료 한도(429)·거절(400): consumed=false로 알리고 사용량을 되돌린다', async () => {
      const g = createMockGemini();
      const { run, store } = setup(g);
      const q = await run(KEY(30), body('mockQuota01', 300));
      expect(q.body).toMatchObject({ ok: false, code: 'gemini_quota', consumed: false });
      const b = await run(KEY(31), body('mockBad0001', 300));
      expect(b.body).toMatchObject({ ok: false, code: 'gemini_rejected', consumed: false });
      expect(store.getUsage(pacificDate(T))).toMatchObject({ requests: 0, videoSec: 0 });
      // 같은 식별자로 다시 물어도 다시 생성하지 않는다
      await run(KEY(30), body('mockQuota01', 300));
      expect(g.createCalls).toHaveLength(2);
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
      expect(store.get(KEY(50))?.state).toBe('creating');
      expect((await run(KEY(50))).body.state).toBe('pending');
      t += 3 * 60_000;
      expect((await run(KEY(50))).body).toMatchObject({ code: 'unknown', consumed: true });
      // 정리 함수도 같은 결과 (여러 번 실행해도 같음)
      const store2 = makeStore();
      store2.put({ ...store.get(KEY(50))!, state: 'creating', leaseUntil: T });
      sweepLedger(store2, T + 10 * 60_000, { resultMs: 86_400_000, rowMs: 7 * 86_400_000 });
      sweepLedger(store2, T + 10 * 60_000, { resultMs: 86_400_000, rowMs: 7 * 86_400_000 });
      expect(store2.get(KEY(50))).toMatchObject({ state: 'failed', failureCode: 'unknown', consumed: true });
    });

    it('Gemini 실패·보관 기간 지남(404)은 consumed=true, 결과 본문은 24시간 뒤 정리되어 expired', async () => {
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
      expect((await run(KEY(62))).body).toMatchObject({ code: 'expired' });
    });
  });
}
