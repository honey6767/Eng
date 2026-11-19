/**
 * 배포용 기본 보안 헤더 — Cloudflare Pages의 `_headers` 파일과 `npm run preview` 서버가 같은 값을 쓴다.
 * (preview에 같은 헤더를 적용해 모든 E2E 점검이 실제 배포와 같은 보안 정책 아래에서 돌도록 한다)
 *
 * 앱이 실제로 쓰는 외부 자원만 허용한다:
 * - 영상 썸네일: https://i.ytimg.com (YouTube 공식 썸네일)
 * - 영상 재생: https://www.youtube-nocookie.com (공식 임베드 플레이어, iframe)
 * - YouTube 프록시: 같은 주소(/api/youtube) 또는 VITE_API_BASE_URL에 적은 Worker 주소
 * 글꼴·스크립트·스타일은 모두 앱에 포함되어 같은 주소에서만 불러온다.
 *
 * 넣지 않은 것: COEP(YouTube 임베드가 깨짐), upgrade-insecure-requests(로컬 http 미리보기와 충돌),
 * HSTS의 includeSubDomains/preload(*.pages.dev는 내 도메인이 아님).
 */

/** VITE_API_BASE_URL → Origin (잘못되었거나 비어 있으면 null) */
export function apiOrigin(apiBaseUrl: string | undefined | null): string | null {
  const v = apiBaseUrl?.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

export function contentSecurityPolicy(apiBaseUrl?: string | null): string {
  const api = apiOrigin(apiBaseUrl);
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'"]],
    ['style-src', ["'self'"]],
    ['img-src', ["'self'", 'data:', 'https://i.ytimg.com']],
    ['font-src', ["'self'", 'data:']], // Vite가 아주 작은 글꼴 조각을 data: 로 묶어 넣음 (앱에 포함된 글꼴)
    ['connect-src', ["'self'", ...(api ? [api] : [])]],
    ['frame-src', ['https://www.youtube-nocookie.com']],
    ['media-src', ["'none'"]],
    ['object-src', ["'none'"]],
    ['worker-src', ["'self'"]],
    ['manifest-src', ["'self'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ];
  return directives.map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

export function securityHeaders(apiBaseUrl?: string | null): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(apiBaseUrl),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Strict-Transport-Security': 'max-age=31536000',
  };
}

/** Cloudflare Pages `_headers` 파일 내용 (모든 경로에 적용) */
export function pagesHeadersFile(apiBaseUrl?: string | null): string {
  const lines = Object.entries(securityHeaders(apiBaseUrl)).map(([k, v]) => `  ${k}: ${v}`);
  return ['# 자동 생성 (server/securityHeaders.ts) — 직접 고치지 마세요', '/*', ...lines, ''].join('\n');
}
