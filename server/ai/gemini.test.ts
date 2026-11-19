import { describe, expect, it, vi } from 'vitest';
import { createGeminiClient, DEFAULT_GEMINI_MODEL, extractOutputText } from './gemini.ts';

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('Gemini Interactions 클라이언트', () => {
  it('생성: POST /v1beta/interactions 한 번, gemini-3.6-flash · background · store · YouTube 주소 · JSON 스키마, 키는 헤더로만', async () => {
    const f = vi.fn(async () => ok({ id: 'v1_abc', status: 'in_progress' }));
    const c = createGeminiClient({ apiKey: 'TEST-KEY-123', fetch: f as unknown as typeof fetch });
    const r = await c.create({ videoId: 'eNODHkrNuDA', durationSec: 295, promptVersion: 'v1' });
    expect(r).toEqual({ kind: 'created', interactionId: 'v1_abc', status: 'in_progress' });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('TEST-KEY-123');
    expect(url).not.toContain('TEST-KEY');
    const b = JSON.parse(String(init.body));
    expect(b).toMatchObject({ model: DEFAULT_GEMINI_MODEL, background: true, store: true, response_format: { type: 'text', mime_type: 'application/json' } });
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-3.6-flash');
    expect(b.input[0]).toEqual({ type: 'video', uri: 'https://www.youtube.com/watch?v=eNODHkrNuDA' });
    expect(b.input[1].text).toContain('295초');
  });

  it('재시도하지 않는다: 5xx·네트워크 오류도 fetch 1번, 결과는 unknown', async () => {
    for (const impl of [async () => ok({ error: {} }, 503), async () => Promise.reject(new Error('net'))]) {
      const f = vi.fn(impl);
      const r = await createGeminiClient({ apiKey: 'k', fetch: f as unknown as typeof fetch }).create({ videoId: 'eNODHkrNuDA', durationSec: 10, promptVersion: 'v1' });
      expect(r.kind).toBe('unknown');
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('429는 무료 한도, 401·403은 키 문제, 그 밖 4xx는 거절 — 모두 처리 안 됨', async () => {
    const run = async (status: number) => createGeminiClient({ apiKey: 'k', fetch: (async () => ok({ error: { message: 'm' } }, status)) as unknown as typeof fetch }).create({ videoId: 'eNODHkrNuDA', durationSec: 10, promptVersion: 'v1' });
    expect(await run(429)).toMatchObject({ kind: 'rejected', reason: 'quota' });
    expect(await run(403)).toMatchObject({ kind: 'rejected', reason: 'not_configured' });
    const badKey = createGeminiClient({ apiKey: 'k', fetch: (async () => new Response(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }), { status: 400 })) as typeof fetch });
    expect(await badKey.create({ videoId: 'eNODHkrNuDA', durationSec: 10, promptVersion: 'v1' })).toMatchObject({ kind: 'rejected', reason: 'not_configured', httpStatus: 400 });
    expect(await run(400)).toMatchObject({ kind: 'rejected', reason: 'invalid' });
    const noKey = createGeminiClient({ apiKey: null, fetch: vi.fn() as unknown as typeof fetch });
    expect(await noKey.create({ videoId: 'eNODHkrNuDA', durationSec: 10, promptVersion: 'v1' })).toMatchObject({ kind: 'rejected', reason: 'not_configured' });
  });

  it('조회: 진행 중 / 완료(텍스트·모델·usage) / 실패 / 404 / 일시 오류', async () => {
    const completed = {
      id: 'v1_abc', status: 'completed', model: 'gemini-3.6-flash',
      steps: [{ type: 'user_input' }, { type: 'thought' }, { type: 'model_output', content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] }],
      usage: { total_input_tokens: 27127, total_output_tokens: 1546, input_tokens_by_modality: [{ modality: 'video', tokens: 26845 }] },
    };
    const get = async (res: () => Promise<Response>) => createGeminiClient({ apiKey: 'k', fetch: res as unknown as typeof fetch }).get('v1_abc');
    expect(await get(async () => ok({ status: 'in_progress' }))).toEqual({ kind: 'running', status: 'in_progress' });
    expect(await get(async () => ok(completed))).toEqual({ kind: 'completed', text: '{"a":1}', model: 'gemini-3.6-flash', usage: { inputTokens: 27127, outputTokens: 1546, videoTokens: 26845 } });
    expect(await get(async () => ok({ status: 'failed', errors: [{ message: 'bad' }] }))).toMatchObject({ kind: 'failed', message: 'bad' });
    // 원인 확인용 상세: 상태 이름 · 오류 코드(숫자·문자 모두) · 토큰
    expect(await get(async () => ok({ status: 'failed', errors: [{ code: 13, status: 'INTERNAL', message: 'There was a problem processing your request.' }], usage: { total_input_tokens: 900, total_output_tokens: 0, total_thought_tokens: 12 } }))).toMatchObject({
      kind: 'failed', message: 'There was a problem processing your request.',
      detail: { status: 'failed', errors: [{ code: 'INTERNAL/13', message: 'There was a problem processing your request.' }], usage: { inputTokens: 900, outputTokens: 0, thoughtTokens: 12 } },
    });
    expect(await get(async () => ok({ status: 'incomplete' }))).toMatchObject({ kind: 'failed', message: "Gemini 작업이 'incomplete' 상태로 끝났어요.", detail: { status: 'incomplete', errors: [], usage: null } });
    expect(await get(async () => ok({}, 404))).toEqual({ kind: 'gone' });
    expect(await get(async () => ok({}, 500))).toMatchObject({ kind: 'retry_later' });
    expect(extractOutputText({ steps: [] })).toBe('');
  });
});
