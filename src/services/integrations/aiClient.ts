import { AI_EXTRACT_PATH, type AiTaskRequest, type AiExtractResponse } from '@/types/aiApi';
import { integrationConfig } from './config';
import { accessCodeStore, canSendAccessCode } from './accessCode';

/**
 * 브라우저 → 우리 서버 /api/ai/extract. 브라우저는 Gemini 키를 전혀 모른다.
 * 같은 요청 식별자로 다시 보내면 서버는 Gemini를 다시 부르지 않고 그 요청의 상태·결과를 돌려준다.
 * 이 함수도 자동 재시도하지 않는다 (재시도 여부는 실행기가 정한다).
 */
export type AiTransportResult =
  | { kind: 'response'; httpStatus: number; body: AiExtractResponse }
  /** 서버에 닿지 못했거나 알 수 없는 응답 — 같은 식별자로 나중에 다시 물으면 된다 */
  | { kind: 'transport_error'; message: string; httpStatus?: number }
  /** 접근 코드 문제 */
  | { kind: 'auth_error'; httpStatus: number; message: string };

export type AiClient = { extract(requestId: string, req: AiTaskRequest): Promise<AiTransportResult> };

export const aiClient: AiClient = {
  async extract(requestId, req) {
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': requestId };
    const code = accessCodeStore.get();
    if (code && canSendAccessCode(integrationConfig.apiBaseUrl)) headers.Authorization = `Bearer ${code}`;
    const base = (integrationConfig.apiBaseUrl ?? '').replace(/\/$/, '');
    let res: Response;
    try {
      res = await fetch(`${base}${AI_EXTRACT_PATH}`, { method: 'POST', headers, body: JSON.stringify(req) });
    } catch {
      return { kind: 'transport_error', message: 'AI 서버에 연결하지 못했어요.' };
    }
    const body = (await res.json().catch(() => null)) as (AiExtractResponse & { code?: string }) | null;
    if (res.status === 401 || (res.status === 429 && body?.code === 'auth_locked') || body?.code === 'auth_not_configured') {
      if (res.status === 401 && code) accessCodeStore.markRejected();
      return { kind: 'auth_error', httpStatus: res.status, message: (body as { message?: string } | null)?.message ?? '접근 코드를 확인해 주세요.' };
    }
    if (!body || typeof body !== 'object' || !('state' in body)) return { kind: 'transport_error', httpStatus: res.status, message: `AI 서버 응답을 읽지 못했어요 (HTTP ${res.status}).` };
    return { kind: 'response', httpStatus: res.status, body };
  },
};
