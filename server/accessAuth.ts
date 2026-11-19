/**
 * 기기별 접근 코드 검사 — YouTube 프록시를 쓰기 전에 사용자 본인인지 확인한다.
 *
 * - 정답 코드는 서버 비밀값(Cloudflare Worker Secret `ACCESS_CODE`)에만 있다. 앱 코드·빌드 결과물에는 없다.
 * - 브라우저는 `Authorization: Bearer <코드>` 헤더로 보낸다 (URL·쿼리에는 절대 넣지 않음).
 * - 비교는 SHA-256 해시를 고정 시간에 비교한다 (글자 수·앞부분 일치 여부가 응답 시간으로 새지 않게).
 * - 응답·오류 메시지·로그에 입력값이나 정답을 넣지 않는다.
 * - 비밀값이 없거나 너무 짧으면(8자 미만) '설정 안 됨'으로 모든 요청을 거부한다 (닫힌 상태가 기본).
 * - 남용 방지: 같은 접속 주소에서 10분 안에 5번 틀리면 15분 동안 잠근다 (Worker 메모리 기준 — 무료,
 *   인스턴스마다 따로 세므로 대략적인 방지책이다).
 *
 * 한계: 이 코드는 '내 프록시를 쓸 수 있는 사람'만 가린다. 기기에 저장된 코드는 그 기기를 쓸 수 있는 사람에게
 * 보일 수 있고, Origin 검사와 마찬가지로 코드를 아는 사람의 직접 호출은 막지 못한다.
 */

export const MIN_ACCESS_CODE_LENGTH = 8;
const MAX_ACCESS_CODE_LENGTH = 256;

export type AccessErrorCode = 'auth_required' | 'auth_invalid' | 'auth_locked' | 'auth_not_configured';

export type AccessResult =
  | { ok: true }
  | { ok: false; status: 401 | 429 | 503; code: AccessErrorCode; message: string; retryAfterSec?: number };

/** 실패 횟수 제한 (메모리) */
export interface FailureLimiter {
  isLocked(key: string, now: number): number; // 남은 잠금 초 (0이면 잠기지 않음)
  recordFailure(key: string, now: number): void;
  reset(key: string): void;
}

export function memoryFailureLimiter(opts = { maxFailures: 5, windowMs: 10 * 60_000, lockMs: 15 * 60_000, maxKeys: 1000 }): FailureLimiter {
  const map = new Map<string, { count: number; firstAt: number; lockedUntil: number }>();
  return {
    isLocked(key, now) {
      const e = map.get(key);
      if (!e || e.lockedUntil <= now) return 0;
      return Math.ceil((e.lockedUntil - now) / 1000);
    },
    recordFailure(key, now) {
      let e = map.get(key);
      if (!e || now - e.firstAt > opts.windowMs) e = { count: 0, firstAt: now, lockedUntil: 0 };
      e.count++;
      if (e.count >= opts.maxFailures) e.lockedUntil = now + opts.lockMs;
      map.delete(key);
      map.set(key, e);
      // 메모리 보호: 오래된 항목부터 정리
      while (map.size > opts.maxKeys) map.delete(map.keys().next().value as string);
    },
    reset(key) {
      map.delete(key);
    },
  };
}

/** "Bearer xxx" → xxx (형식이 아니거나 길이가 이상하면 null) */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return null;
  const code = m[1].trim();
  if (code.length === 0 || code.length > MAX_ACCESS_CODE_LENGTH) return null;
  return code;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** 고정 시간 비교 (두 값의 해시를 끝까지 비교) */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function isAccessConfigured(secret: string | null | undefined): boolean {
  return typeof secret === 'string' && secret.trim().length >= MIN_ACCESS_CODE_LENGTH;
}

export async function verifyAccess(input: {
  authorization: string | null | undefined;
  secret: string | null | undefined;
  clientKey: string;
  limiter: FailureLimiter;
  now?: number;
}): Promise<AccessResult> {
  const now = input.now ?? Date.now();
  if (!isAccessConfigured(input.secret)) {
    return { ok: false, status: 503, code: 'auth_not_configured', message: '서버에 접근 코드가 설정되지 않아 영상 정보 서버를 쓸 수 없어요.' };
  }
  const locked = input.limiter.isLocked(input.clientKey, now);
  if (locked > 0) {
    return {
      ok: false,
      status: 429,
      code: 'auth_locked',
      message: `접근 코드를 여러 번 틀려 잠시 막았어요. ${Math.ceil(locked / 60)}분 뒤에 다시 시도해 주세요.`,
      retryAfterSec: locked,
    };
  }
  const code = parseBearer(input.authorization);
  if (!code) return { ok: false, status: 401, code: 'auth_required', message: '접근 코드가 필요해요.' };
  if (!(await safeEqual(code, input.secret!.trim()))) {
    input.limiter.recordFailure(input.clientKey, now);
    return { ok: false, status: 401, code: 'auth_invalid', message: '접근 코드가 맞지 않아요. 다시 입력해 주세요.' };
  }
  input.limiter.reset(input.clientKey);
  return { ok: true };
}

/** 접근 코드 확인 전용 경로 — YouTube를 호출하지 않는다 */
export const AUTH_CHECK_PATH = '/api/youtube/auth';
