/**
 * Worker 호출 출처(Origin) 검사 — 배포한 앱 화면에서 온 브라우저 요청만 받는다.
 *
 * 규칙 (모두 '닫힌 상태가 기본'):
 * - ALLOWED_ORIGIN이 설정되지 않았으면 모든 요청 거부 (설정 실수로 열려 있지 않게)
 * - Origin 헤더가 없으면 거부 (주소창 직접 접속·curl 등)
 * - 허용 목록에 없는 Origin이면 거부
 *
 * 주의: Origin 검사는 인증이 아니다. 브라우저가 아닌 프로그램은 Origin 값을 마음대로 위조할 수 있다.
 * 이 검사는 다른 웹사이트가 방문자의 브라우저로 내 프록시를 쓰는 것과 단순 직접 호출을 막을 뿐이며,
 * 비용 보호는 YouTube 무료 할당량(결제 계정 없음)·자체 상한·Workers 무료 한도가 맡는다.
 */

export type OriginDecision =
  | { ok: true; origin: string }
  | { ok: false; status: 403; reason: 'not_configured' | 'missing_origin' | 'origin_not_allowed' };

/** "https://a.pages.dev, https://b.example" → 정규화된 Origin 목록 (끝의 / 제거, 잘못된 값 무시) */
export function parseAllowedOrigins(value: string | undefined | null): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const raw of value.split(',')) {
    const v = raw.trim();
    if (!v) continue;
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
      out.push(u.origin);
    } catch {
      /* 잘못된 값은 무시 */
    }
  }
  return out;
}

export function checkOrigin(origin: string | null, allowedOrigins: string[]): OriginDecision {
  if (allowedOrigins.length === 0) return { ok: false, status: 403, reason: 'not_configured' };
  if (!origin || origin === 'null') return { ok: false, status: 403, reason: 'missing_origin' };
  if (!allowedOrigins.includes(origin)) return { ok: false, status: 403, reason: 'origin_not_allowed' };
  return { ok: true, origin };
}
