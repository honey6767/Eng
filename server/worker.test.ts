import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './worker.ts';
import { checkOrigin, parseAllowedOrigins } from './originPolicy.ts';

const APP = 'https://my-english-study.pages.dev';
const CODE = 'test-access-code-123';
const env = (over: Record<string, string | undefined> = {}) => ({ ALLOWED_ORIGIN: APP, YOUTUBE_DAILY_UNIT_CAP: '9000', ACCESS_CODE: CODE, ...over });
const req = (path: string, init: RequestInit & { origin?: string | null; code?: string | null; ip?: string; scheme?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.origin) headers.set('Origin', init.origin);
  if (init.code) headers.set('Authorization', `Bearer ${init.code}`);
  headers.set('CF-Connecting-IP', init.ip ?? `198.51.100.${Math.floor(Math.random() * 250)}`);
  return new Request(`${init.scheme ?? 'https'}://proxy.example.workers.dev/api/youtube/${path}`, { method: init.method ?? 'GET', headers });
};

afterEach(() => vi.unstubAllGlobals());

describe('출처 검사 (originPolicy)', () => {
  it('허용 목록 정규화: 끝의 / 제거, 쉼표로 여러 개, 잘못된 값 무시', () => {
    expect(parseAllowedOrigins(` ${APP}/ , http://localhost:4173, not a url, ftp://x.example `)).toEqual([APP, 'http://localhost:4173']);
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });
  it('설정 없음·Origin 없음·"null"·다른 사이트는 거부, 허용된 Origin만 통과', () => {
    expect(checkOrigin(APP, [])).toMatchObject({ ok: false, reason: 'not_configured' });
    expect(checkOrigin(null, [APP])).toMatchObject({ ok: false, reason: 'missing_origin' });
    expect(checkOrigin('null', [APP])).toMatchObject({ ok: false, reason: 'missing_origin' });
    expect(checkOrigin('https://evil.example', [APP])).toMatchObject({ ok: false, reason: 'origin_not_allowed' });
    expect(checkOrigin(`${APP}.evil.example`, [APP])).toMatchObject({ ok: false, reason: 'origin_not_allowed' });
    expect(checkOrigin(APP, [APP])).toEqual({ ok: true, origin: APP });
  });
});

describe('Worker', () => {
  it('Origin 없는 요청은 403이고 YouTube를 호출하지 않는다', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const r = await worker.fetch(req('video?id=dQw4w9WgXcQ'), env({ YOUTUBE_API_KEY: 'k' }));
    expect(r.status).toBe(403);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
  });
  it('다른 사이트 Origin은 403', async () => {
    const r = await worker.fetch(req('status', { origin: 'https://evil.example' }), env());
    expect(r.status).toBe(403);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
  it('ALLOWED_ORIGIN이 비어 있으면 허용된 주소에서 와도 403 (닫힌 상태가 기본)', async () => {
    expect((await worker.fetch(req('status', { origin: APP }), env({ ALLOWED_ORIGIN: '' }))).status).toBe(403);
    expect((await worker.fetch(req('status', { origin: APP }), env({ ALLOWED_ORIGIN: undefined }))).status).toBe(403);
  });
  it('허용된 Origin + 맞는 접근 코드면 처리하고 CORS·보안 헤더를 붙인다', async () => {
    const r = await worker.fetch(req('status', { origin: APP, code: CODE }), env());
    expect(r.status).toBe(200);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(r.headers.get('Vary')).toBe('Origin');
    const body = (await r.json()) as { ok: boolean; mode: string };
    expect(body).toMatchObject({ ok: true, mode: 'limited' });
    expect(JSON.stringify(body)).not.toContain('k3y');
  });
  it('허용된 Origin이어도 GET 외 메서드는 405, 사전 요청(OPTIONS)은 204', async () => {
    expect((await worker.fetch(req('status', { origin: APP, method: 'POST' }), env())).status).toBe(405);
    const pre = await worker.fetch(req('status', { origin: APP, method: 'OPTIONS' }), env());
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Methods')).toBe('GET');
    expect(pre.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect((await worker.fetch(req('status', { method: 'OPTIONS' }), env())).status).toBe(403);
  });
  it('API 키는 응답에 들어가지 않는다', async () => {
    const r = await worker.fetch(req('status', { origin: APP, code: CODE }), env({ YOUTUBE_API_KEY: 'SECRET-k3y-value' }));
    const text = await r.text();
    expect(text).not.toContain('SECRET-k3y-value');
    expect(JSON.parse(text)).toMatchObject({ ok: true, mode: 'api' });
  });
});

describe('Worker — 접근 코드', () => {
  const upstreamSpy = () => {
    const upstream = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', upstream);
    return upstream;
  };
  const video = 'video?id=dQw4w9WgXcQ';

  it('정상 코드: 허용 (YouTube 호출이 일어남)', async () => {
    const upstream = upstreamSpy();
    const r = await worker.fetch(req(video, { origin: APP, code: CODE }), env({ YOUTUBE_API_KEY: 'k' }));
    expect(r.status).not.toBe(401);
    expect(upstream).toHaveBeenCalled();
  });
  it('잘못된 코드·코드 없음: 401이고 YouTube 호출 0회, 응답에 입력값·정답 없음', async () => {
    const upstream = upstreamSpy();
    const wrong = await worker.fetch(req(video, { origin: APP, code: 'wrong-code-value' }), env({ YOUTUBE_API_KEY: 'k' }));
    const missing = await worker.fetch(req(video, { origin: APP }), env({ YOUTUBE_API_KEY: 'k' }));
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(wrong.headers.get('WWW-Authenticate')).toContain('Bearer');
    expect(wrong.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    const texts = [await wrong.text(), await missing.text()];
    for (const t of texts) {
      expect(t).not.toContain('wrong-code-value');
      expect(t).not.toContain(CODE);
    }
    expect(JSON.parse(texts[0])).toMatchObject({ ok: false, code: 'auth_invalid' });
    expect(JSON.parse(texts[1])).toMatchObject({ ok: false, code: 'auth_required' });
    expect(upstream).toHaveBeenCalledTimes(0);
  });
  it('Worker Secret 미설정·짧음: 503이고 YouTube 호출 0회', async () => {
    const upstream = upstreamSpy();
    for (const ACCESS_CODE of [undefined, '', 'short']) {
      const r = await worker.fetch(req(video, { origin: APP, code: CODE }), env({ ACCESS_CODE, YOUTUBE_API_KEY: 'k' }));
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ ok: false, code: 'auth_not_configured' });
    }
    expect(upstream).toHaveBeenCalledTimes(0);
  });
  it('URL 쿼리에 넣은 코드는 인정하지 않는다 (헤더로만)', async () => {
    const upstream = upstreamSpy();
    const r = await worker.fetch(req(`${video}&access_code=${CODE}`, { origin: APP }), env({ YOUTUBE_API_KEY: 'k' }));
    expect(r.status).toBe(401);
    expect(upstream).toHaveBeenCalledTimes(0);
  });
  it('확인 전용 경로 /auth: 맞으면 200 { required: true }, YouTube 호출 없음 (역할 분리)', async () => {
    const upstream = upstreamSpy();
    const ok = await worker.fetch(req('auth', { origin: APP, code: CODE }), env({ YOUTUBE_API_KEY: 'k' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, required: true });
    expect((await worker.fetch(req('auth', { origin: APP, code: 'nope-nope-nope' }), env())).status).toBe(401);
    expect(upstream).toHaveBeenCalledTimes(0);
  });
  it('같은 접속 주소에서 5번 틀리면 429 + Retry-After (맞는 코드도 잠시 거부)', async () => {
    const upstream = upstreamSpy();
    const ip = '203.0.113.77';
    for (let i = 0; i < 5; i++) expect((await worker.fetch(req('auth', { origin: APP, code: `bad-${i}-xxxx`, ip }), env())).status).toBe(401);
    const locked = await worker.fetch(req(video, { origin: APP, code: CODE, ip }), env({ YOUTUBE_API_KEY: 'k' }));
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(upstream).toHaveBeenCalledTimes(0);
  });
  it('Origin 검사가 먼저: 다른 사이트에서 맞는 코드를 보내도 403', async () => {
    expect((await worker.fetch(req('auth', { origin: 'https://evil.example', code: CODE }), env())).status).toBe(403);
    expect((await worker.fetch(req('auth', { code: CODE }), env())).status).toBe(403);
  });
  it('HTTPS가 아니면 403', async () => {
    expect((await worker.fetch(req('auth', { origin: APP, code: CODE, scheme: 'http' }), env())).status).toBe(403);
  });
});
