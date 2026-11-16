/**
 * AI 요청 장부 — 요청 식별자(Idempotency-Key)마다 상태를 기록해 Gemini 생성 요청이 식별자당 최대 1회만 나가게 한다.
 *
 * 저장소는 동기 함수만 가진 인터페이스다. Durable Object(SQLite, 동기 SQL)와 메모리(개발 서버·테스트)가 같은 규칙을 쓴다.
 * 상태를 읽고 바꾸는 일은 항상 await 없는 한 덩어리에서 한다 → 같은 식별자가 동시에 와도 하나만 'creating'을 만든다.
 */

export type LedgerState = 'creating' | 'running' | 'succeeded' | 'failed';

export interface LedgerRow {
  key: string;
  bodyHash: string;
  videoId: string;
  durationSec: number;
  state: LedgerState;
  interactionId: string | null;
  /** creating 상태의 만료 시각 (ms) — 지나면 결과 모름으로 정리 */
  leaseUntil: number | null;
  /** 사용량을 센 날짜 (태평양 시간) */
  pacificDate: string;
  /** 사용량에 넣었는지 (Gemini가 처리하지 않은 것이 확실하면 되돌려 false) */
  counted: boolean;
  failureCode: string | null;
  failureMessage: string | null;
  /** 실패가 사용량을 썼을 수 있는지 */
  consumed: boolean;
  resultText: string | null;
  model: string | null;
  usageJson: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UsageRow {
  pacificDate: string;
  videoSec: number;
  requests: number;
}

/** 생성 결과 보관 (작업 키별, 영구) — 다른 기기가 같은 작업을 요청하면 Gemini 없이 이 결과를 돌려준다 */
export interface ResultRow {
  workKey: string;
  resultText: string;
  model: string | null;
  usageJson: string | null;
  createdAt: number;
}

export interface LedgerStore {
  get(key: string): LedgerRow | null;
  getResult(workKey: string): ResultRow | null;
  putResult(row: ResultRow): void;
  put(row: LedgerRow): void;
  getUsage(pacificDate: string): UsageRow;
  putUsage(row: UsageRow): void;
  /** 오래된 기록 정리: 결과 본문은 resultMs 이전, 기록 전체는 rowMs 이전 */
  cleanup(resultBefore: number, rowBefore: number): void;
  /** 만료된 creating 기록 (알람 정리용) */
  expiredCreating(now: number): LedgerRow[];
}

export function memoryLedgerStore(): LedgerStore & { rows: Map<string, LedgerRow> } {
  const rows = new Map<string, LedgerRow>();
  const usage = new Map<string, UsageRow>();
  const results = new Map<string, ResultRow>();
  return {
    rows,
    getResult: (k) => {
      const r = results.get(k);
      return r ? { ...r } : null;
    },
    putResult: (r) => void (results.has(r.workKey) || results.set(r.workKey, { ...r })),
    get: (k) => {
      const r = rows.get(k);
      return r ? { ...r } : null;
    },
    put: (r) => void rows.set(r.key, { ...r }),
    getUsage: (d) => ({ ...(usage.get(d) ?? { pacificDate: d, videoSec: 0, requests: 0 }) }),
    putUsage: (u) => void usage.set(u.pacificDate, { ...u }),
    cleanup: (resultBefore, rowBefore) => {
      for (const [k, r] of rows) {
        if (r.updatedAt < rowBefore) rows.delete(k);
        else if (r.updatedAt < resultBefore && r.resultText !== null) rows.set(k, { ...r, resultText: null });
      }
    },
    expiredCreating: (now) => [...rows.values()].filter((r) => r.state === 'creating' && (r.leaseUntil ?? 0) < now).map((r) => ({ ...r })),
  };
}

// ── 시간 ──
const PACIFIC = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
/** 태평양 시간 기준 날짜 YYYY-MM-DD (Gemini·YouTube 일일 한도가 이 날짜로 초기화) */
export const pacificDate = (ms: number) => PACIFIC.format(new Date(ms));
/** 다음 태평양 시간 자정 (ISO) */
export function nextPacificMidnight(ms: number): string {
  const today = pacificDate(ms);
  let t = Math.ceil(ms / 3_600_000) * 3_600_000;
  for (let i = 0; i < 48 && pacificDate(t) === today; i++) t += 3_600_000;
  return new Date(t).toISOString();
}

/** creating 상태 점유 시간 — 생성 요청 시간 제한(60초)보다 넉넉히 */
export const CREATE_LEASE_MS = 2 * 60_000;
/** 결과 본문 보관 24시간, 기록 7일 */
export const RESULT_RETENTION_MS = 24 * 3_600_000;
export const ROW_RETENTION_MS = 7 * 24 * 3_600_000;
