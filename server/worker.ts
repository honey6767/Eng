/**
 * (선택) Cloudflare Workers 무료 플랜용 YouTube 프록시 — 앱을 인터넷에 배포해 휴대폰 등에서 쓸 때만 필요.
 * 로컬에서 `npm run dev`로 사용할 때는 필요 없다. 자세한 설정은 README의 '배포(선택)' 참고.
 *
 * 비밀정보: `wrangler secret put YOUTUBE_API_KEY` 로 Cloudflare에만 저장한다(코드·GitHub에 넣지 않음).
 * 비용: Workers Free 플랜은 하루 요청 한도를 넘으면 요청이 거부될 뿐 자동 과금되지 않는다.
 * 할당량 추적은 Worker 인스턴스 메모리 기준이라 정확하지 않을 수 있지만, Google이 무료 할당량을
 * 강제하므로(초과 시 403) 비용은 발생하지 않는다.
 */
import { handleYouTubeApi } from './youtube/handler.ts';
import { QuotaTracker, memoryQuotaStore, DEFAULT_LOCAL_CAP } from './youtube/quota.ts';

interface Env {
  YOUTUBE_API_KEY?: string;
  /** 허용할 앱 주소 (예: https://my-english-study.pages.dev) — CORS */
  ALLOWED_ORIGIN?: string;
  YOUTUBE_DAILY_UNIT_CAP?: string;
}

const store = memoryQuotaStore();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const allowed = env.ALLOWED_ORIGIN ?? '';
    const cors: Record<string, string> =
      origin && origin === allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: cors });
    // 허용되지 않은 사이트에서의 호출 차단 (다른 사람이 내 할당량을 쓰지 못하게)
    if (origin && origin !== allowed) return new Response('Forbidden', { status: 403 });

    const quota = new QuotaTracker(store, Number(env.YOUTUBE_DAILY_UNIT_CAP) || DEFAULT_LOCAL_CAP);
    const result = await handleYouTubeApi(new URL(request.url), {
      apiKey: env.YOUTUBE_API_KEY?.trim() || null,
      quota,
      fetch: (input, init) => fetch(input, init),
    });
    if (!result) return new Response('Not found', { status: 404, headers: cors });
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  },
};
