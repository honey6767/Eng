import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 브라우저별 저장소 흉내 (node 테스트 환경에는 localStorage가 없음) */
function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
    dump: () => Object.fromEntries(m),
  };
}

async function freshModules() {
  vi.resetModules();
  const { accessCodeStore, canSendAccessCode } = await import('./accessCode');
  const { youtubeClient } = await import('./youtubeClient');
  return { accessCodeStore, canSendAccessCode, youtubeClient };
}

let storage: ReturnType<typeof fakeStorage>;
beforeEach(() => {
  storage = fakeStorage();
  vi.stubGlobal('localStorage', storage);
});
afterEach(() => vi.unstubAllGlobals());

describe('접근 코드 저장 (이 브라우저의 localStorage만)', () => {
  it('저장 → 새로고침(모듈 다시 불러오기) 후에도 유지 → 지우기(로그아웃)', async () => {
    let { accessCodeStore } = await freshModules();
    expect(accessCodeStore.get()).toBeNull();
    accessCodeStore.save('  my-device-code-1  ');
    expect(storage.dump()).toEqual({ 'mes:accessCode': 'my-device-code-1' });
    ({ accessCodeStore } = await freshModules());
    expect(accessCodeStore.get()).toBe('my-device-code-1');
    accessCodeStore.clear();
    expect(accessCodeStore.get()).toBeNull();
    expect(storage.dump()).toEqual({});
  });
  it('다른 브라우저(다른 저장소)에는 없다', async () => {
    const { accessCodeStore } = await freshModules();
    accessCodeStore.save('code-in-browser-a');
    vi.stubGlobal('localStorage', fakeStorage());
    const other = await freshModules();
    expect(other.accessCodeStore.get()).toBeNull();
  });
  it('건너뛰기는 표시만 남기고, 서버가 거부한 옛 코드는 건너뛸 때 지운다', async () => {
    const { accessCodeStore } = await freshModules();
    accessCodeStore.save('old-code-value');
    accessCodeStore.markRejected();
    expect(accessCodeStore.isRejected()).toBe(true);
    accessCodeStore.skip();
    expect(accessCodeStore.isRejected()).toBe(false);
    expect(accessCodeStore.get()).toBeNull();
    expect(accessCodeStore.isSkipped()).toBe(true);
  });
  it('저장소를 못 쓰는 환경에서도 오류 없이 동작 (저장 안 됨)', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } });
    const { accessCodeStore } = await freshModules();
    expect(() => accessCodeStore.save('x-code-value')).not.toThrow();
    expect(accessCodeStore.get()).toBeNull();
  });
  it('http 원격 서버로는 코드를 보내지 않는다 (같은 주소·https·localhost만)', async () => {
    const { canSendAccessCode } = await freshModules();
    expect(canSendAccessCode(null)).toBe(true);
    expect(canSendAccessCode('https://proxy.example.workers.dev')).toBe(true);
    expect(canSendAccessCode('http://localhost:8787')).toBe(true);
    expect(canSendAccessCode('http://proxy.example.com')).toBe(false);
    expect(canSendAccessCode('not a url')).toBe(false);
  });
});

describe('프록시 호출 — Authorization 헤더로만 전송', () => {
  it('저장된 코드는 헤더로 보내고 URL에는 넣지 않는다', async () => {
    const { accessCodeStore, youtubeClient } = await freshModules();
    accessCodeStore.save('header-only-code');
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ ok: true, mode: 'api', quota: { used: 0, cap: 9000, dailyLimit: 10000, date: 'x', exhausted: false }, mock: false }));
    }));
    await youtubeClient.status();
    expect(calls[0].headers.Authorization).toBe('Bearer header-only-code');
    expect(calls[0].url).not.toContain('header-only-code');
  });
  it('저장된 코드를 서버가 거부하면 다시 입력하도록 표시한다', async () => {
    const { accessCodeStore, youtubeClient } = await freshModules();
    accessCodeStore.save('rotated-old-code');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, code: 'auth_invalid', message: '접근 코드가 맞지 않아요.' }), { status: 401 })));
    await expect(youtubeClient.video('dQw4w9WgXcQ')).rejects.toMatchObject({ code: 'auth_invalid' });
    expect(accessCodeStore.isRejected()).toBe(true);
  });
  it('checkAccess: 저장하지 않고 결과만 알려 준다 (맞음 / 틀림 / 필요 없음 / 연결 실패)', async () => {
    const { accessCodeStore, youtubeClient } = await freshModules();
    const respond = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
    respond(200, { ok: true, required: true });
    expect(await youtubeClient.checkAccess('typed-code-1')).toEqual({ result: 'ok', required: true });
    expect(accessCodeStore.get()).toBeNull();
    respond(401, { ok: false, code: 'auth_invalid', message: 'x' });
    expect((await youtubeClient.checkAccess('typed-code-2')).result).toBe('invalid');
    expect(accessCodeStore.isRejected()).toBe(false);
    respond(200, { ok: true, required: false });
    expect(await youtubeClient.checkAccess(null)).toEqual({ result: 'ok', required: false });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect((await youtubeClient.checkAccess(null)).result).toBe('unavailable');
  });
});
