import type { AiExtractRequest, AiExtractResponse, AiFailureCode } from '../../src/types/aiApi.ts';
import { isValidVideoId } from '../../src/utils/youtubeUrl.ts';
import { bodyHashSource, taskOf, validateTaskRequest } from './tasks.ts';
import type { GeminiClient } from './gemini.ts';
import { CREATE_LEASE_MS, nextPacificMidnight, pacificDate, type LedgerRow, type LedgerStore } from './ledger.ts';

/**
 * POST /api/ai/extract 처리 (Durable Object와 개발 서버 공용)
 *
 * 같은 Idempotency-Key로 다시 보내면 = 그 요청의 상태 조회. Gemini 생성 요청은 식별자당 최대 1회.
 * - 새 식별자: 상한 확인 → creating 기록 + 사용량 미리 더하기(한 덩어리) → Gemini 생성(background) 1회 → id 기록
 * - running: 같은 interaction id로 조회만 한다 (새로 생성하지 않음)
 * - creating인데 점유 시간이 지남: 결과 모름(사용한 것으로 셈). 서버는 절대 자동으로 다시 생성하지 않는다.
 * - Gemini가 처리하지 않은 것이 확실한 거절(429·4xx·키 없음)만 사용량을 되돌리고 consumed=false로 알린다.
 */

export interface AiCaps {
  /** 하루 영상 분량 상한 (초) — 무료 등급 하루 8시간보다 낮게 */
  dailyVideoSec: number;
  /** 하루 생성 요청 수 상한 — AI Studio에 보이는 무료 RPD보다 낮게 */
  dailyRequests: number;
  /** 한 번에 처리할 최대 영상 길이 (초) */
  maxVideoSec: number;
  /** 하루 AI 질문 수 상한 — 전체 요청 상한 안에서, 학습 자료 생성 몫을 남겨 두기 위해 */
  dailyAsk?: number;
}

export const DEFAULT_AI_CAPS: AiCaps = { dailyVideoSec: 6 * 3600, dailyRequests: 20, maxVideoSec: 30 * 60, dailyAsk: 10 };

export function parseCaps(env: { AI_DAILY_VIDEO_SEC_CAP?: string; AI_DAILY_REQUEST_CAP?: string; AI_MAX_VIDEO_SEC?: string; AI_DAILY_ASK_CAP?: string }): AiCaps {
  const pos = (v: string | undefined, d: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : d;
  };
  return {
    // 무료 등급 하루 YouTube 8시간을 넘지 못하게 막는다
    dailyVideoSec: pos(env.AI_DAILY_VIDEO_SEC_CAP, DEFAULT_AI_CAPS.dailyVideoSec, 8 * 3600),
    dailyRequests: pos(env.AI_DAILY_REQUEST_CAP, DEFAULT_AI_CAPS.dailyRequests, 10_000),
    maxVideoSec: pos(env.AI_MAX_VIDEO_SEC, DEFAULT_AI_CAPS.maxVideoSec, 3 * 3600),
    dailyAsk: pos(env.AI_DAILY_ASK_CAP, DEFAULT_AI_CAPS.dailyAsk ?? 10, 10_000),
  };
}

export interface ExtractDeps {
  store: LedgerStore;
  gemini: GeminiClient;
  caps: AiCaps;
  now?: () => number;
}

export interface ExtractResult {
  status: number;
  body: AiExtractResponse;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POLL_AFTER_SEC = 15;

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fail(requestId: string | null, code: AiFailureCode, message: string, consumed: boolean, status = 200, retryAt?: string): ExtractResult {
  return { status, body: { ok: false, state: 'failed', requestId, code, message, consumed, ...(retryAt ? { retryAt } : {}) } };
}

/** 실패 종류별 HTTP 상태 — 화면에 그대로 보여 준다 (본문의 code·consumed가 실제 판단 기준) */
const FAILURE_HTTP: Partial<Record<AiFailureCode, number>> = {
  daily_cap: 429,
  gemini_quota: 429,
  too_long: 413,
  gemini_not_configured: 503,
  gemini_rejected: 502,
  gemini_failed: 502,
  unknown: 502,
  expired: 410,
};

/** 저장된 기록을 응답으로 */
function respond(row: LedgerRow): ExtractResult {
  if (row.state === 'succeeded') {
    if (row.resultText === null) return fail(row.key, 'expired', '결과 보관 기간이 지났어요.', true, FAILURE_HTTP.expired);
    return {
      status: 200,
      body: { ok: true, state: 'succeeded', requestId: row.key, interactionId: row.interactionId ?? '', model: row.model, resultText: row.resultText, usage: row.usageJson ? JSON.parse(row.usageJson) : null },
    };
  }
  if (row.state === 'failed') {
    const retryAt = row.failureCode === 'daily_cap' || row.failureCode === 'gemini_quota' ? nextPacificMidnight(row.updatedAt) : undefined;
    const code = (row.failureCode as AiFailureCode) ?? 'unknown';
    return fail(row.key, code, row.failureMessage ?? '', row.consumed, FAILURE_HTTP[code] ?? 500, retryAt);
  }
  return { status: 202, body: { ok: true, state: 'pending', requestId: row.key, interactionId: row.interactionId, retryAfterSec: POLL_AFTER_SEC } };
}

export function validateRequest(raw: unknown): AiExtractRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.videoId !== 'string' || !isValidVideoId(r.videoId)) return null;
  if (typeof r.durationSec !== 'number' || !Number.isInteger(r.durationSec) || r.durationSec < 1 || r.durationSec > 24 * 3600) return null;
  if (typeof r.promptVersion !== 'string' || r.promptVersion.length > 20) return null;
  return { videoId: r.videoId, durationSec: r.durationSec, promptVersion: r.promptVersion };
}

/** 작업 키: 요청 내용(작업 종류·입력·프롬프트 버전)의 해시 — 기기·식별자가 달라도 같은 작업이면 같은 키 */
export const workKeyOf = (bodyHash: string) => `w:${bodyHash}`;

function cachedResult(row: { key: string }, cached: { resultText: string; model: string | null; usageJson: string | null }, requestId: string): ExtractResult {
  void row;
  return { status: 200, body: { ok: true, state: 'succeeded', requestId, interactionId: '', model: cached.model, resultText: cached.resultText, usage: cached.usageJson ? JSON.parse(cached.usageJson) : null } };
}

/**
 * 요청 처리
 * - 식별자(Idempotency-Key)로 남은 예전 기록이 있으면 그 기록대로 (배포 전에 시작한 요청 이어가기)
 * - 아니면 작업 키로: 보관된 결과 → 돌려줌 / 진행 중 → 같은 작업을 기다림(조회만) / 없음 → 생성 1회
 * - 실패 기록: Gemini가 처리하지 않은 것이 확실한 실패(consumed=false)만 다시 생성한다.
 *   결과를 모르는 실패는 사용자가 '실패만 다시 시도'를 눌러 retryFailed=true로 보낼 때만 다시 생성한다.
 */
export async function handleAiExtract(input: { idempotencyKey: string | null; body: unknown }, deps: ExtractDeps): Promise<ExtractResult> {
  const out = await handleInner(input, deps);
  // 응답의 요청 식별자는 항상 앱이 보낸 식별자
  const key = input.idempotencyKey?.trim() ?? '';
  if (UUID.test(key) && out.body.requestId !== null) return { ...out, body: { ...out.body, requestId: key } };
  return out;
}

/** 실패한 작업을 다시 생성해도 되는지 (Gemini가 처리하지 않은 것이 확실하거나, 사용자가 '실패만 다시 시도'를 누름) */
function canRecreate(row: LedgerRow, t: number, retryFailed: boolean): boolean {
  if (row.state !== 'failed' || row.failureCode === 'too_long') return false;
  if (retryFailed) return true;
  if (row.consumed) return false;
  switch (row.failureCode) {
    case 'daily_cap': // 서버 상한 — 다시 확인할 때 상한을 다시 검사 (Gemini 호출 없음)
    case 'gemini_not_configured': // 키 문제 — 키를 고친 뒤 이어서
      return true;
    case 'gemini_quota': // Gemini 무료 한도 — 초기화 시각 이후에만
      return t >= Date.parse(nextPacificMidnight(row.updatedAt));
    default: // 거절(비공개 영상 등)은 사용자가 다시 시도할 때만
      return false;
  }
}

async function handleInner(input: { idempotencyKey: string | null; body: unknown }, deps: ExtractDeps): Promise<ExtractResult> {
  const now = deps.now ?? Date.now;
  const key = input.idempotencyKey?.trim() ?? '';
  if (!UUID.test(key)) return fail(null, 'bad_request', 'Idempotency-Key(요청 식별자, UUID v4)가 필요해요.', false, 400);
  const req = validateTaskRequest(input.body);
  if (!req) return fail(key, 'bad_request', '요청 형식이 올바르지 않아요.', false, 400);
  const retryFailed = (input.body as { retryFailed?: unknown }).retryFailed === true;
  const bodyHash = await sha256(bodyHashSource(req));
  const workKey = workKeyOf(bodyHash);
  // 자막 추출만 영상 분량을 쓴다. 문장·Chunk·대화문은 텍스트만 보내므로 요청 수만 센다
  const task = taskOf(req);
  const ledgerVideoId = req.task === 'dialogue' ? 'dialogue' : req.task === 'ask' ? 'ask' : req.videoId;
  const videoSec = task === 'extract' ? (req as { durationSec: number }).durationSec : 0;
  const { store, caps } = deps;

  // ── 한 덩어리 (await 없음): 조회·예약 ──
  const t = now();
  const legacy = store.get(key);
  if (legacy && legacy.bodyHash !== bodyHash) return fail(key, 'key_conflict', '같은 요청 식별자에 다른 내용이 왔어요.', false, 409);
  if (legacy) return continueRow(legacy, deps, t);

  const existing = store.get(workKey);
  if (existing && existing.state !== 'failed') return continueRow(existing, deps, t);
  // 보관된 결과가 있으면 Gemini를 부르지 않는다 (다른 기기가 먼저 만든 결과)
  const cached = store.getResult(workKey);
  if (cached) return cachedResult({ key: workKey }, cached, workKey);
  if (existing && !canRecreate(existing, t, retryFailed)) return continueRow(existing, deps, t);

  const date = pacificDate(t);
  const base: LedgerRow = {
    key: workKey, bodyHash, videoId: ledgerVideoId, durationSec: videoSec, state: 'creating', interactionId: null, leaseUntil: t + CREATE_LEASE_MS,
    pacificDate: date, counted: false, failureCode: null, failureMessage: null, consumed: false, resultText: null, model: null, usageJson: null, createdAt: existing?.createdAt ?? t, updatedAt: t,
  };
  if (task === 'extract' && videoSec > caps.maxVideoSec) {
    const row = { ...base, state: 'failed' as const, leaseUntil: null, failureCode: 'too_long', failureMessage: `한 번에 처리할 수 있는 길이(${Math.round(caps.maxVideoSec / 60)}분)를 넘는 영상이에요.` };
    store.put(row);
    return respond(row);
  }
  const askCap = caps.dailyAsk ?? DEFAULT_AI_CAPS.dailyAsk!;
  if (task === 'ask' && store.countCounted('ask', date) + 1 > askCap) {
    const row = { ...base, state: 'failed' as const, leaseUntil: null, failureCode: 'daily_cap', failureMessage: `오늘 AI 질문 한도(${askCap}회)에 도달했어요. 학습 자료 생성 몫을 남겨 두려고 질문 수를 따로 제한해요. 태평양 시간 자정 이후 다시 질문할 수 있어요.` };
    store.put(row);
    return respond(row);
  }
  const usage = store.getUsage(date);
  if (usage.requests + 1 > caps.dailyRequests || usage.videoSec + videoSec > caps.dailyVideoSec) {
    const row = { ...base, state: 'failed' as const, leaseUntil: null, failureCode: 'daily_cap', failureMessage: '오늘 사용 상한에 도달했어요. 태평양 시간 자정 이후 다시 시작해요.' };
    store.put(row);
    return respond(row);
  }
  store.put({ ...base, counted: true });
  store.putUsage({ pacificDate: date, videoSec: usage.videoSec + videoSec, requests: usage.requests + 1 });

  // ── Gemini 생성 요청 — 정확히 1회 ──
  const created = await deps.gemini.create(req);

  // ── 한 덩어리: 결과 기록 ──
  const t2 = now();
  const cur = store.get(workKey) ?? { ...base, counted: true };
  if (created.kind === 'created') {
    const row: LedgerRow = { ...cur, state: 'running', interactionId: created.interactionId, leaseUntil: null, updatedAt: t2 };
    store.put(row);
    return respond(row);
  }
  if (created.kind === 'rejected') {
    // Gemini가 처리하지 않은 것이 확실함 → 사용량 되돌림
    const u = store.getUsage(cur.pacificDate);
    store.putUsage({ pacificDate: cur.pacificDate, videoSec: Math.max(0, u.videoSec - cur.durationSec), requests: Math.max(0, u.requests - 1) });
    const code: AiFailureCode = created.reason === 'quota' ? 'gemini_quota' : created.reason === 'not_configured' ? 'gemini_not_configured' : 'gemini_rejected';
    const upstream = created.httpStatus ? ` (Gemini HTTP ${created.httpStatus})` : '';
    const row: LedgerRow = { ...cur, state: 'failed', counted: false, consumed: false, leaseUntil: null, failureCode: code, failureMessage: `${created.message}${upstream}`, updatedAt: t2 };
    store.put(row);
    return respond(row);
  }
  const row: LedgerRow = { ...cur, state: 'failed', consumed: true, leaseUntil: null, failureCode: 'unknown', failureMessage: `${created.message}${created.httpStatus ? ` (Gemini HTTP ${created.httpStatus})` : ''}`, updatedAt: t2 };
  store.put(row);
  return respond(row);
}

/** 이미 있는 기록 이어가기: 진행 중이면 조회만, 끝났으면 그 결과 */
function continueRow(row: LedgerRow, deps: ExtractDeps, t: number): Promise<ExtractResult> | ExtractResult {
  const { store } = deps;
  if (row.state === 'creating') {
    if ((row.leaseUntil ?? 0) >= t) return respond(row);
    const unknown: LedgerRow = { ...row, state: 'failed', failureCode: 'unknown', failureMessage: '생성 요청의 결과를 확인하지 못했어요(사용한 것으로 셉니다).', consumed: true, leaseUntil: null, updatedAt: t };
    store.put(unknown);
    return respond(unknown);
  }
  if (row.state === 'running') return poll(row, deps);
  if (row.state === 'succeeded' && row.resultText === null) {
    const cached = store.getResult(workKeyOf(row.bodyHash));
    if (cached) return cachedResult(row, cached, row.key);
  }
  return respond(row);
}

/** running 기록 — 같은 interaction id로 조회만 한다 */
async function poll(row: LedgerRow, deps: ExtractDeps): Promise<ExtractResult> {
  const now = deps.now ?? Date.now;
  const r = await deps.gemini.get(row.interactionId!);
  const cur = deps.store.get(row.key) ?? row;
  if (cur.state !== 'running') return respond(cur); // 그사이 다른 조회가 끝냄
  const t = now();
  if (r.kind === 'running' || r.kind === 'retry_later') return respond(cur);
  let next: LedgerRow;
  if (r.kind === 'completed') {
    next = { ...cur, state: 'succeeded', resultText: r.text, model: r.model, usageJson: r.usage ? JSON.stringify(r.usage) : null, updatedAt: t };
    // 다른 기기·나중 요청이 같은 작업을 다시 생성하지 않도록 결과를 보관
    deps.store.putResult({ workKey: workKeyOf(cur.bodyHash), resultText: r.text, model: r.model, usageJson: next.usageJson, createdAt: t });
  } else if (r.kind === 'gone') next = { ...cur, state: 'failed', consumed: true, failureCode: 'expired', failureMessage: 'Gemini 결과 보관 기간(무료 1일)이 지나 조회할 수 없어요.', updatedAt: t };
  else next = { ...cur, state: 'failed', consumed: true, failureCode: 'gemini_failed', failureMessage: r.message, updatedAt: t };
  deps.store.put(next);
  return respond(next);
}

/** 알람·정리: 만료된 creating → 결과 모름, 오래된 본문·기록 삭제 (여러 번 실행돼도 결과 같음) */
export function sweepLedger(store: LedgerStore, now: number, retention: { resultMs: number; rowMs: number }) {
  for (const r of store.expiredCreating(now)) {
    store.put({ ...r, state: 'failed', failureCode: 'unknown', failureMessage: '생성 요청의 결과를 확인하지 못했어요(사용한 것으로 셉니다).', consumed: true, leaseUntil: null, updatedAt: now });
  }
  store.cleanup(now - retention.resultMs, now - retention.rowMs);
}

/** 테스트·점검용: 요청 본문의 작업 키 */
export async function workKeyForBody(body: unknown): Promise<string | null> {
  const req = validateTaskRequest(body);
  return req ? workKeyOf(await sha256(bodyHashSource(req))) : null;
}
