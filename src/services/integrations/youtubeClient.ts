import type {
  YtCaptionsResponse,
  YtErrorCode,
  YtErrorResponse,
  YtPlaylistResponse,
  YtStatusResponse,
  YtVideoResponse,
} from '@/types/youtubeApi';
import { integrationConfig } from './config';

/**
 * 브라우저 → 우리 서버 프록시(/api/youtube/*) 호출.
 * 브라우저는 YouTube API 키를 전혀 알지 못한다.
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

async function request<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base()}/api/youtube/${path}`, { headers: { Accept: 'application/json' } });
  } catch {
    throw new YouTubeApiError('proxy_unavailable', '영상 정보 서버(프록시)에 연결할 수 없습니다.');
  }
  const body = (await res.json().catch(() => null)) as (T & { ok: true }) | YtErrorResponse | null;
  if (!body || typeof body !== 'object' || !('ok' in body)) {
    throw new YouTubeApiError('proxy_unavailable', '영상 정보 서버(프록시)가 없습니다. npm run dev 또는 npm run preview로 실행해 주세요.');
  }
  if (!body.ok) throw new YouTubeApiError(body.code, body.message);
  return body as T;
}

export const youtubeClient = {
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

export type YouTubeClient = typeof youtubeClient;
