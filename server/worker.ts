/**
 * (선택) Cloudflare Workers 무료 플랜용 YouTube 프록시 — 앱을 인터넷에 배포해 휴대폰 등에서 쓸 때만 필요.
 * 로컬에서 `npm run dev`로 사용할 때는 필요 없다. 자세한 설정은 README의 '배포(선택)' 참고.
 *
 * 비밀정보: `wrangler secret put YOUTUBE_API_KEY` 로 Cloudflare에만 저장한다(코드·GitHub에 넣지 않음).
 * 비용: Workers Free 플랜은 하루 요청 한도를 넘으면 요청이 거부될 뿐 자동 과금되지 않는다.
 * 할당량 추적은 Worker 인스턴스 메모리 기준이라 정확하지 않을 수 있지만, Google이 무료 할당량을
 * 강제하므로(초과 시 403) 비용은 발생하지 않는다.
 *
 * 처리 순서 (앞 단계에서 막히면 뒤 단계와 YouTube 호출은 하지 않는다):
 * 1. HTTPS만 허용
 * 2. 출처 검사(originPolicy.ts): ALLOWED_ORIGIN 미설정·Origin 없음·허용되지 않은 Origin → 403
 * 3. GET만 허용 (사전 요청 OPTIONS는 204)
 * 4. 접근 코드 검사(accessAuth.ts): Secret `ACCESS_CODE` 미설정 503 · 코드 없음/틀림 401 · 반복 실패 429
 * 5. /api/youtube/auth → 확인 결과만 응답 (YouTube 호출 없음), 그 밖의 경로 → YouTube 프록시
 * Origin 검사와 접근 코드 모두 '위조·유출이 불가능한 인증'은 아니다. 비용 보호는 무료 할당량(결제 계정 없음)·자체 상한이 함께 맡는다.
 */
import { handleYouTubeApi } from './youtube/handler.ts';
import { QuotaTracker, memoryQuotaStore, DEFAULT_LOCAL_CAP } from './youtube/quota.ts';
import { checkOrigin, parseAllowedOrigins } from './originPolicy.ts';
import { AUTH_CHECK_PATH, memoryFailureLimiter, verifyAccess } from './accessAuth.ts';

interface Env {
  YOUTUBE_API_KEY?: string;
  /** 허용할 앱 주소 (예: https://my-english-study.pages.dev). 쉼표로 여러 개. 비어 있으면 모든 요청 거부 */
  ALLOWED_ORIGIN?: string;
  YOUTUBE_DAILY_UNIT_CAP?: string;
  /** 기기별 접근 코드 (wrangler secret put ACCESS_CODE 로만 설정). 비어 있거나 8자 미만이면 모든 요청 거부 */
  ACCESS_CODE?: string;
}

const store = memoryQuotaStore();
const failures = memoryFailureLimiter();
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', Vary: 'Origin' };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== 'https:') return new Response('HTTPS required', { status: 403, headers: BASE_HEADERS });
    // 허용된 앱 화면에서 온 요청만 처리 (Origin 없음·다른 사이트·설정 누락은 모두 거부)
    const decision = checkOrigin(request.headers.get('Origin'), parseAllowedOrigins(env.ALLOWED_ORIGIN));
    if (!decision.ok) return new Response('Forbidden', { status: 403, headers: BASE_HEADERS });
    const cors: Record<string, string> = { 'Access-Control-Allow-Origin': decision.origin };
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...BASE_HEADERS, ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Authorization, Accept', 'Access-Control-Max-Age': '600' } });
    }
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...BASE_HEADERS, ...cors } });

    // 접근 코드 — YouTube를 부르기 전에 확인. 응답에는 입력값·정답을 넣지 않는다.
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...cors, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
    const access = await verifyAccess({
      authorization: request.headers.get('Authorization'),
      secret: env.ACCESS_CODE,
      clientKey: request.headers.get('CF-Connecting-IP') ?? 'unknown',
      limiter: failures,
    });
    if (!access.ok) {
      const extra: Record<string, string> = access.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="my-english-study"' } : {};
      if (access.retryAfterSec) extra['Retry-After'] = String(access.retryAfterSec);
      return json(access.status, { ok: false, code: access.code, message: access.message }, extra);
    }
    if (url.pathname === AUTH_CHECK_PATH) return json(200, { ok: true, required: true });

    const quota = new QuotaTracker(store, Number(env.YOUTUBE_DAILY_UNIT_CAP) || DEFAULT_LOCAL_CAP);
    const result = await handleYouTubeApi(url, {
      apiKey: env.YOUTUBE_API_KEY?.trim() || null,
      quota,
      fetch: (input, init) => fetch(input, init),
    });
    if (!result) return new Response('Not found', { status: 404, headers: { ...BASE_HEADERS, ...cors } });
    return json(result.status, result.body);
  },
};
