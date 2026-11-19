import type {
  YtAuthResponse,
  YtCaptionsResponse,
  YtErrorCode,
  YtErrorResponse,
  YtPlaylistResponse,
  YtStatusResponse,
  YtVideoResponse,
} from '@/types/youtubeApi';
import { integrationConfig } from './config';
import { accessCodeStore, canSendAccessCode } from './accessCode';

/**
 * 브라우저 → 우리 서버 프록시(/api/youtube/*) 호출.
 * 브라우저는 YouTube API 키를 전혀 알지 못한다.
 * 접근 코드가 저장돼 있으면 Authorization 헤더로만 보낸다 (URL에는 넣지 않음).
 */
export class YouTubeApiError extends Error {
  constructor(
    public code: YtErrorCode | 'proxy_unavailable',
    message: string,
  ) {
    super(message);
  }
}

export type ProxyStatus =
  | { available: true; status: YtStatusResponse }
  | { available: false; reason: string };

function base(): string {
  return (integrationConfig.apiBaseUrl ?? '').replace(/\/$/, '');
}

const AUTH_ERRORS = new Set<string>(['auth_required', 'auth_invalid']);

async function request<T>(path: string, codeOverride?: string | null): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const code = codeOverride !== undefined ? codeOverride : accessCodeStore.get();
  if (code && canSendAccessCode(integrationConfig.apiBaseUrl)) headers.Authorization = `Bearer ${code}`;
  let res: Response;
  try {
    res = await fetch(`${base()}/api/youtube/${path}`, { headers });
  } catch {
    throw new YouTubeApiError('proxy_unavailable', '영상 정보 서버(프록시)에 연결할 수 없습니다.');
  }
  const body = (await res.json().catch(() => null)) as (T & { ok: true }) | YtErrorResponse | null;
  if (!body || typeof body !== 'object' || !('ok' in body)) {
    throw new YouTubeApiError('proxy_unavailable', '영상 정보 서버(프록시)가 없습니다. npm run dev 또는 npm run preview로 실행해 주세요.');
  }
  if (!body.ok) {
    // 저장된 코드를 서버가 거부하면(코드 변경 등) 다시 입력 화면을 띄우도록 표시
    if (codeOverride === undefined && code && AUTH_ERRORS.has(body.code)) accessCodeStore.markRejected();
    throw new YouTubeApiError(body.code, body.message);
  }
  return body as T;
}

export type AccessCheck =
  /** 접근 코드가 맞음 (또는 서버가 요구하지 않음) */
  | { result: 'ok'; required: boolean }
  /** 코드가 필요함 / 틀림 / 잠김 / 서버에 설정 안 됨 */
  | { result: 'required' | 'invalid' | 'locked' | 'not_configured'; message: string }
  /** 서버에 연결하지 못함 */
  | { result: 'unavailable'; message: string };

export const youtubeClient = {
  /**
   * 접근 코드 확인 전용 (YouTube는 호출하지 않음). code를 주면 그 값으로, null이면 코드 없이 확인한다.
   * 저장은 하지 않는다 — 맞는 코드일 때만 호출한 쪽에서 accessCodeStore.save()를 부른다.
   */
  async checkAccess(code: string | null): Promise<AccessCheck> {
    try {
      const r = await request<YtAuthResponse>('auth', code);
      return { result: 'ok', required: r.required };
    } catch (e) {
      if (!(e instanceof YouTubeApiError)) return { result: 'unavailable', message: '확인 중 오류가 발생했어요.' };
      const map: Record<string, AccessCheck['result']> = {
        auth_required: 'required',
        auth_invalid: 'invalid',
        auth_locked: 'locked',
        auth_not_configured: 'not_configured',
      };
      const result = map[e.code];
      if (result && result !== 'ok') return { result, message: e.message } as AccessCheck;
      return { result: 'unavailable', message: e.message };
    }
  },
  async status(): Promise<ProxyStatus> {
    try {
      return { available: true, status: await request<YtStatusResponse>('status') };
    } catch (e) {
      return { available: false, reason: e instanceof Error ? e.message : '연결 실패' };
    }
  },
  video: (videoId: string) => request<YtVideoResponse>(`video?id=${encodeURIComponent(videoId)}`),
  playlist: (playlistId: string) => request<YtPlaylistResponse>(`playlist?id=${encodeURIComponent(playlistId)}`),
  captions: (videoId: string) => request<YtCaptionsResponse>(`captions?id=${encodeURIComponent(videoId)}`),
};

/** 영상 정보 가져오기에 쓰는 부분만 (접근 코드 확인은 별도 역할) */
export type YouTubeClient = Pick<typeof youtubeClient, 'status' | 'video' | 'playlist' | 'captions'>;
