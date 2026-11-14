/**
 * 외부 연동 설정
 *
 * 보안 원칙: YouTube Data API 키, AI API 키 등 비밀정보는 클라이언트에 절대 포함하지 않는다.
 * 브라우저는 우리 서버(예: Supabase Edge Function) 프록시만 호출하고,
 * 실제 API 키는 서버 환경변수에만 둔다. 여기서는 공개 가능한 프록시 주소만 읽는다.
 */
export const integrationConfig = {
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() || null,
};
