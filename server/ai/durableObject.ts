import { createGeminiClient } from './gemini.ts';
import { handleAiExtract, parseCaps, sweepLedger } from './extractHandler.ts';
import { RESULT_RETENTION_MS, ROW_RETENTION_MS, type LedgerRow, type LedgerStore, type UsageRow } from './ledger.ts';

/**
 * AI 요청 장부 Durable Object (SQLite, Workers Free에서 사용 가능)
 *
 * - 이름이 고정된 객체 하나('ai-ledger')가 모든 요청 식별자를 기록한다 → 탭·기기가 달라도 같은 식별자는 한 번만 생성.
 * - SQLite 연산은 동기라 한 덩어리 안에서는 다른 요청이 끼어들지 못한다 (Cloudflare 공식 동작).
 * - 알람: 만료된 creating 정리, 결과 본문 24시간·기록 7일 뒤 삭제. 알람은 절대 Gemini를 부르지 않는다.
 * - 이 클래스를 쓰려면 Worker 배포에 SQLite 클래스 선언(new_sqlite_classes)과 바인딩 AI_LEDGER가 필요하다.
 *   (새 Cloudflare 리소스 — 이번 단계에서는 만들지 않음, 배포 단계에서 따로 승인)
 */

/** Cloudflare 런타임이 넘겨주는 값 중 이 클래스가 쓰는 부분만 */
interface SqlCursor {
  toArray(): Record<string, unknown>[];
}
interface DoStorage {
  sql: { exec(query: string, ...bindings: unknown[]): SqlCursor };
  getAlarm(): Promise<number | null>;
  setAlarm(ms: number): Promise<void>;
}
interface DoState {
  storage: DoStorage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}
export interface AiLedgerEnv {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  AI_DAILY_VIDEO_SEC_CAP?: string;
  AI_DAILY_REQUEST_CAP?: string;
  AI_MAX_VIDEO_SEC?: string;
}

const COLS = 'key, body_hash, video_id, duration_sec, state, interaction_id, lease_until, pacific_date, counted, failure_code, failure_message, consumed, result_text, model, usage_json, created_at, updated_at';

function toRow(r: Record<string, unknown>): LedgerRow {
  return {
    key: String(r.key), bodyHash: String(r.body_hash), videoId: String(r.video_id), durationSec: Number(r.duration_sec), state: r.state as LedgerRow['state'],
    interactionId: (r.interaction_id as string | null) ?? null, leaseUntil: r.lease_until == null ? null : Number(r.lease_until), pacificDate: String(r.pacific_date),
    counted: Number(r.counted) === 1, failureCode: (r.failure_code as string | null) ?? null, failureMessage: (r.failure_message as string | null) ?? null,
    consumed: Number(r.consumed) === 1, resultText: (r.result_text as string | null) ?? null, model: (r.model as string | null) ?? null,
    usageJson: (r.usage_json as string | null) ?? null, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

export function sqliteLedgerStore(sql: DoStorage['sql']): LedgerStore {
  sql.exec(`CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, body_hash TEXT NOT NULL, video_id TEXT NOT NULL, duration_sec INTEGER NOT NULL, state TEXT NOT NULL, interaction_id TEXT, lease_until INTEGER, pacific_date TEXT NOT NULL, counted INTEGER NOT NULL, failure_code TEXT, failure_message TEXT, consumed INTEGER NOT NULL, result_text TEXT, model TEXT, usage_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS usage (pacific_date TEXT PRIMARY KEY, video_sec INTEGER NOT NULL, requests INTEGER NOT NULL)`);
  // 생성 결과 보관 (작업 키별, 영구·정리 안 함) — 기기 간 공유. 기존 표는 그대로
  sql.exec(`CREATE TABLE IF NOT EXISTS results (work_key TEXT PRIMARY KEY, result_text TEXT NOT NULL, model TEXT, usage_json TEXT, created_at INTEGER NOT NULL)`);
  return {
    getResult: (k) => {
      const rows = sql.exec('SELECT work_key, result_text, model, usage_json, created_at FROM results WHERE work_key = ?', k).toArray();
      if (!rows.length) return null;
      const r = rows[0];
      return { workKey: String(r.work_key), resultText: String(r.result_text), model: (r.model as string | null) ?? null, usageJson: (r.usage_json as string | null) ?? null, createdAt: Number(r.created_at) };
    },
    // 먼저 저장된 결과를 유지 (같은 작업 키는 한 번만)
    putResult: (r) => void sql.exec('INSERT OR IGNORE INTO results (work_key, result_text, model, usage_json, created_at) VALUES (?, ?, ?, ?, ?)', r.workKey, r.resultText, r.model, r.usageJson, r.createdAt),
    get: (key) => {
      const rows = sql.exec(`SELECT ${COLS} FROM requests WHERE key = ?`, key).toArray();
      return rows.length ? toRow(rows[0]) : null;
    },
    put: (r) => {
      sql.exec(
        `INSERT OR REPLACE INTO requests (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        r.key, r.bodyHash, r.videoId, r.durationSec, r.state, r.interactionId, r.leaseUntil, r.pacificDate, r.counted ? 1 : 0, r.failureCode, r.failureMessage,
        r.consumed ? 1 : 0, r.resultText, r.model, r.usageJson, r.createdAt, r.updatedAt,
      );
    },
    getUsage: (d): UsageRow => {
      const rows = sql.exec('SELECT video_sec, requests FROM usage WHERE pacific_date = ?', d).toArray();
      return rows.length ? { pacificDate: d, videoSec: Number(rows[0].video_sec), requests: Number(rows[0].requests) } : { pacificDate: d, videoSec: 0, requests: 0 };
    },
    putUsage: (u) => void sql.exec('INSERT OR REPLACE INTO usage (pacific_date, video_sec, requests) VALUES (?, ?, ?)', u.pacificDate, u.videoSec, u.requests),
    cleanup: (resultBefore, rowBefore) => {
      sql.exec('DELETE FROM requests WHERE updated_at < ?', rowBefore);
      sql.exec('UPDATE requests SET result_text = NULL WHERE updated_at < ? AND result_text IS NOT NULL', resultBefore);
    },
    expiredCreating: (now) => sql.exec(`SELECT ${COLS} FROM requests WHERE state = 'creating' AND lease_until < ?`, now).toArray().map(toRow),
  };
}

const ALARM_EVERY_MS = 60 * 60_000;

export class AiLedger {
  private store!: LedgerStore;

  constructor(
    private readonly state: DoState,
    private readonly env: AiLedgerEnv,
  ) {
    void state.blockConcurrencyWhile(async () => {
      this.store = sqliteLedgerStore(state.storage.sql);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null);
    const gemini = createGeminiClient({ apiKey: this.env.GEMINI_API_KEY?.trim() || null, model: this.env.GEMINI_MODEL, fetch: (i, init) => fetch(i, init) });
    const result = await handleAiExtract({ idempotencyKey: request.headers.get('Idempotency-Key'), body }, { store: this.store, gemini, caps: parseCaps(this.env) });
    // 정리 알람이 없으면 하나 예약 (setAlarm은 행 쓰기 1건)
    if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(Date.now() + ALARM_EVERY_MS);
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }

  async alarm(): Promise<void> {
    try {
      sweepLedger(this.store, Date.now(), { resultMs: RESULT_RETENTION_MS, rowMs: ROW_RETENTION_MS });
    } finally {
      await this.state.storage.setAlarm(Date.now() + ALARM_EVERY_MS);
    }
  }
}
