import type { AiTaskRequest } from '@/types/aiApi';
import type { AiClient } from '@/services/integrations/aiClient';
import type { AiTaskState, ContentStore } from '@/repositories/contentStore';

/**
 * 텍스트 AI 작업(문장·Chunk, 통합 대화문) 실행 — 요청 식별자 하나로 생성 1회, 이후 같은 식별자로 조회만.
 *
 * - 식별자와 보낸 내용을 먼저 기기에 저장하고 보낸다 → 앱을 닫았다 열어도 같은 식별자로 이어서 조회(새로 생성하지 않음)
 * - 결과를 받으면 저장 전까지 보관한다 → 저장 도중 앱이 꺼져도 다시 요청하지 않는다
 * - Gemini가 처리하지 않은 것이 확실한 실패(consumed=false)만 다음에 새 식별자로 다시 요청한다
 * - 자동 재시도 없음. 서버에 닿지 못하면 몇 번만 다시 묻고 멈춘다(다음에 누르면 같은 식별자로 이어서)
 */

export type TaskProgress =
  | { phase: 'sending' }
  | { phase: 'processing'; since: string; note?: string }
  | { phase: 'failed'; httpStatus: number | null; code: string; message: string };

export type TaskOutcome =
  | { ok: true; requestId: string; text: string; reused: boolean }
  | { ok: false; httpStatus: number | null; code: string; message: string };

export interface TaskDeps {
  store: Pick<ContentStore, 'getTask' | 'putTask'>;
  client: AiClient;
  now?: () => Date;
  newId?: () => string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollMs?: number;
}

const MAX_TRANSPORT_RETRIES = 3;

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

function hintFor(code: string, body: AiTaskRequest): string {
  // 예전 서버(Worker)는 새 작업 종류를 모른다 → 형식 오류로 거절
  if (code === 'bad_request' && (body.task === 'content' || body.task === 'dialogue')) return ' 서버(Worker)가 아직 새 기능으로 업데이트되지 않았을 수 있어요.';
  return '';
}

export async function runAiTask(key: string, makeBody: () => AiTaskRequest, deps: TaskDeps, onProgress: (p: TaskProgress) => void, signal?: AbortSignal): Promise<TaskOutcome> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = deps.pollMs ?? 5_000;
  let st = await deps.store.getTask(key);
  if (st?.status === 'succeeded' && st.resultText) return { ok: true, requestId: st.requestId, text: st.resultText, reused: true };

  if (!st || st.status === 'failed' || st.status === 'applied') {
    const iso = now().toISOString();
    st = { requestId: (deps.newId ?? (() => crypto.randomUUID()))(), body: makeBody(), status: 'sent', startedAt: iso, updatedAt: iso, resultText: null, error: null };
    await deps.store.putTask(key, st);
    onProgress({ phase: 'sending' });
  } else {
    onProgress({ phase: 'processing', since: st.startedAt, note: '이전에 보낸 요청의 결과를 확인하는 중이에요.' });
  }
  const save = async (patch: Partial<AiTaskState>) => {
    st = { ...st!, ...patch, updatedAt: now().toISOString() };
    await deps.store.putTask(key, st);
  };

  let transportFails = 0;
  while (!signal?.aborted) {
    const r = await deps.client.extract(st.requestId, st.body);
    if (r.kind === 'transport_error') {
      if (++transportFails > MAX_TRANSPORT_RETRIES) return { ok: false, httpStatus: r.httpStatus ?? null, code: 'network', message: `${r.message} 다시 누르면 같은 요청으로 이어서 확인해요(새로 생성하지 않음).` };
      onProgress({ phase: 'processing', since: st.startedAt, note: `${r.message} 다시 확인하는 중… (${transportFails}/${MAX_TRANSPORT_RETRIES})` });
      await sleep(pollMs * 2, signal);
      continue;
    }
    transportFails = 0;
    if (r.kind === 'auth_error') return { ok: false, httpStatus: r.httpStatus, code: 'auth', message: r.message };
    const body = r.body;
    if (body.state === 'pending') {
      onProgress({ phase: 'processing', since: st.startedAt, note: 'Gemini가 만드는 중이에요. 보통 30초~2분 걸려요.' });
      await sleep(pollMs, signal);
      continue;
    }
    if (body.state === 'succeeded') {
      await save({ status: 'succeeded', resultText: body.resultText, error: null });
      return { ok: true, requestId: st.requestId, text: body.resultText, reused: false };
    }
    const err = { code: body.code, message: `${body.message}${hintFor(body.code, st.body)}`, httpStatus: r.httpStatus };
    // 하루 상한·무료 한도처럼 처리 안 된 실패는 다음에 새 식별자로. 결과를 모르는 실패도 사용자가 다시 누를 때만 새로 요청한다
    await save({ status: 'failed', error: err });
    return { ok: false, ...err };
  }
  return { ok: false, httpStatus: null, code: 'cancelled', message: '멈췄어요. 다시 누르면 같은 요청으로 이어서 확인해요.' };
}

/** 결과를 저장한 뒤: 큰 결과 텍스트는 지우고 '저장함'으로 (같은 결과를 다시 쓰지 않게) */
export async function markApplied(store: Pick<ContentStore, 'getTask' | 'putTask'>, key: string, now = new Date()): Promise<void> {
  const st = await store.getTask(key);
  if (st) await store.putTask(key, { ...st, status: 'applied', resultText: null, updatedAt: now.toISOString() });
}
