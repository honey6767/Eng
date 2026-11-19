import { describe, expect, it } from 'vitest';
import { isAccessConfigured, memoryFailureLimiter, parseBearer, safeEqual, verifyAccess } from './accessAuth.ts';

const SECRET = 'correct-horse-battery';
const check = (authorization: string | null, opts: { secret?: string | null; limiter?: ReturnType<typeof memoryFailureLimiter>; now?: number; key?: string } = {}) =>
  verifyAccess({ authorization, secret: 'secret' in opts ? opts.secret : SECRET, clientKey: opts.key ?? 'ip-1', limiter: opts.limiter ?? memoryFailureLimiter(), now: opts.now });

describe('접근 코드 검사', () => {
  it('Bearer 형식만 읽고, 비었거나 너무 길면 무시', () => {
    expect(parseBearer('Bearer abc-123')).toBe('abc-123');
    expect(parseBearer('bearer   abc ')).toBe('abc');
    expect(parseBearer('Basic abc')).toBeNull();
    expect(parseBearer('Bearer ')).toBeNull();
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer(`Bearer ${'x'.repeat(257)}`)).toBeNull();
  });
  it('고정 시간 비교: 같으면 true, 한 글자·길이만 달라도 false', async () => {
    expect(await safeEqual('same-value', 'same-value')).toBe(true);
    expect(await safeEqual('same-value', 'same-valuE')).toBe(false);
    expect(await safeEqual('same-value', 'same-value-')).toBe(false);
  });
  it('비밀값 미설정·8자 미만 → 503 (모든 요청 거부)', async () => {
    expect(isAccessConfigured(undefined)).toBe(false);
    expect(isAccessConfigured('short')).toBe(false);
    expect(isAccessConfigured('12345678')).toBe(true);
    for (const secret of [undefined, null, '', '   ', 'short']) {
      expect(await check(`Bearer ${SECRET}`, { secret })).toMatchObject({ ok: false, status: 503, code: 'auth_not_configured' });
    }
  });
  it('정상 코드 허용 · 없음/틀림 401 · 메시지에 입력값·정답 없음', async () => {
    expect(await check(`Bearer ${SECRET}`)).toEqual({ ok: true });
    const missing = await check(null);
    expect(missing).toMatchObject({ ok: false, status: 401, code: 'auth_required' });
    const wrong = await check('Bearer guess-guess-guess');
    expect(wrong).toMatchObject({ ok: false, status: 401, code: 'auth_invalid' });
    for (const r of [missing, wrong]) {
      if (r.ok) continue;
      expect(r.message).not.toContain('guess');
      expect(r.message).not.toContain(SECRET);
    }
  });
  it('10분 안에 5번 틀리면 15분 잠금 (맞는 코드도 거부) → 시간이 지나면 풀림, 다른 주소는 영향 없음', async () => {
    const limiter = memoryFailureLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect((await check('Bearer nope-nope', { limiter, now: t0 + i })).ok).toBe(false);
    const locked = await check(`Bearer ${SECRET}`, { limiter, now: t0 + 10 });
    expect(locked).toMatchObject({ ok: false, status: 429, code: 'auth_locked' });
    if (!locked.ok) expect(locked.retryAfterSec).toBeGreaterThan(800);
    expect(await check(`Bearer ${SECRET}`, { limiter, now: t0 + 10, key: 'ip-2' })).toEqual({ ok: true });
    expect(await check(`Bearer ${SECRET}`, { limiter, now: t0 + 16 * 60_000 })).toEqual({ ok: true });
  });
  it('실패 사이 간격이 10분을 넘으면 다시 셈 / 성공하면 초기화', async () => {
    const limiter = memoryFailureLimiter();
    for (let i = 0; i < 4; i++) await check('Bearer nope-nope', { limiter, now: i });
    await check(`Bearer ${SECRET}`, { limiter, now: 10 });
    for (let i = 0; i < 4; i++) await check('Bearer nope-nope', { limiter, now: 20 + i });
    expect(await check(`Bearer ${SECRET}`, { limiter, now: 30 })).toEqual({ ok: true });
  });
});
