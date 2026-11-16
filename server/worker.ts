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
 * 6. (B1-b) POST /api/ai/extract → AI 요청 장부 Durable Object(AI_LEDGER)로 넘긴다. 바인딩이 없으면 503이고 Gemini를 부르지 않는다.
 *    이 경로만 POST를 받는다 (사전 요청에 POST·Content-Type·Idempotency-Key 허용). YouTube 경로는 지금처럼 GET만.
 * Origin 검사와 접근 코드 모두 '위조·유출이 불가능한 인증'은 아니다. 비용 보호는 무료 할당량(결제 계정 없음)·자체 상한이 함께 맡는다.
 */
import { handleYouTubeApi } from './youtube/handler.ts';
import { QuotaTracker, memoryQuotaStore, DEFAULT_LOCAL_CAP } from './youtube/quota.ts';
import { checkOrigin, parseAllowedOrigins } from './originPolicy.ts';
import { AUTH_CHECK_PATH, memoryFailureLimiter, verifyAccess } from './accessAuth.ts';
import { AI_EXTRACT_PATH } from '../src/types/aiApi.ts';

/** AI 요청 장부 Durable Object 클래스 — 배포 설정(new_sqlite_classes)에서 이 이름으로 선언한다 */
export { AiLedger } from './ai/durableObject.ts';

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

interface Env {
  YOUTUBE_API_KEY?: string;
  /** 허용할 앱 주소 (예: https://my-english-study.pages.dev). 쉼표로 여러 개. 비어 있으면 모든 요청 거부 */
  ALLOWED_ORIGIN?: string;
  YOUTUBE_DAILY_UNIT_CAP?: string;
  /** 기기별 접근 코드 (wrangler secret put ACCESS_CODE 로만 설정). 비어 있거나 8자 미만이면 모든 요청 거부 */
  ACCESS_CODE?: string;
  /** (B1-b) AI 요청 장부 Durable Object 바인딩. 없으면 /api/ai/* 는 503 */
  AI_LEDGER?: DurableObjectNamespaceLike;
}

/** 장부 객체는 하나만 쓴다 → 모든 탭·기기의 요청 식별자가 한곳에 기록된다 */
const AI_LEDGER_NAME = 'ai-ledger';
/** 문장·Chunk 생성은 자막 텍스트(최대 6만 자)를 보낸다 */
const MAX_AI_BODY_BYTES = 256 * 1024;

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
    const isAi = url.pathname === AI_EXTRACT_PATH;
    if (request.method === 'OPTIONS') {
      const allow = isAi
        ? { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization, Accept, Content-Type, Idempotency-Key' }
        : { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Authorization, Accept' };
      return new Response(null, { status: 204, headers: { ...BASE_HEADERS, ...cors, ...allow, 'Access-Control-Max-Age': '600' } });
    }
    if (request.method !== (isAi ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { ...BASE_HEADERS, ...cors } });

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

    if (isAi) {
      const unavailable = { ok: false, state: 'failed', requestId: null, code: 'ledger_unavailable', message: 'AI 요청 장부를 쓸 수 없어 요청하지 않았어요.', consumed: false };
      if (!env.AI_LEDGER) return json(503, unavailable);
      const text = await request.text();
      if (text.length > MAX_AI_BODY_BYTES) return json(413, { ok: false, state: 'failed', requestId: null, code: 'bad_request', message: '요청이 너무 커요.', consumed: false });
      try {
        const stub = env.AI_LEDGER.get(env.AI_LEDGER.idFromName(AI_LEDGER_NAME));
        const res = await stub.fetch(
          new Request('https://ai-ledger/extract', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.headers.get('Idempotency-Key') ?? '' }, body: text }),
        );
        return json(res.status, await res.json());
      } catch {
        // 장부에 기록하지 못하면 Gemini도 부르지 않았다 (닫힌 상태가 기본)
        return json(503, unavailable);
      }
    }

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
