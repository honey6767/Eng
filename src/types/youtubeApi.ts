/**
 * 브라우저 ↔ 서버 프록시(/api/youtube/*) 사이의 응답 형식.
 * 서버 코드(server/)와 클라이언트 코드가 함께 사용한다. (API 키는 절대 포함하지 않음)
 */

/** api: YouTube Data API 키 설정됨 · limited: 키 없음(oEmbed/RSS 제한 모드) */
export type YtMode = 'api' | 'limited';

export interface YtQuota {
  /** 오늘(태평양 시간 기준) 이 서버가 사용한 추정 단위 */
  used: number;
  /** 이 앱이 스스로 정한 하루 사용 상한 (무료 할당량보다 낮게) */
  cap: number;
  /** YouTube Data API 기본 무료 할당량 */
  dailyLimit: number;
  /** 할당량 기준 날짜 (America/Los_Angeles, YYYY-MM-DD) */
  date: string;
  /** Google이 할당량 초과를 알려와 오늘은 더 호출하지 않는 상태 */
  exhausted: boolean;
}

export interface YtStatusResponse {
  ok: true;
  mode: YtMode;
  quota: YtQuota;
  /** 테스트용 가짜 응답 모드 (YOUTUBE_API_MOCK=1) */
  mock: boolean;
}

export interface YtVideoInfo {
  videoId: string;
  title: string;
  channelTitle: string | null;
  thumbnailUrl: string | null;
  durationSec: number | null;
  publishedAt: string | null;
  /** 재생목록 내 순서 (0부터) */
  position: number | null;
}

export interface YtVideoResponse {
  ok: true;
  source: 'youtube_api' | 'oembed';
  video: YtVideoInfo;
  unitsUsed: number;
}

export interface YtUnavailableItem {
  videoId: string | null;
  position: number | null;
  title: string;
  reason: string;
}

export interface YtPlaylistResponse {
  ok: true;
  source: 'youtube_api' | 'rss';
  /** 재생목록 전체를 가져왔는지 (RSS 제한 모드는 최근 15개만 → false) */
  complete: boolean;
  playlist: {
    playlistId: string;
    title: string;
    channelTitle: string | null;
    thumbnailUrl: string | null;
    itemCount: number | null;
  };
  videos: YtVideoInfo[];
  unavailable: YtUnavailableItem[];
  unitsUsed: number;
  note?: string;
}

export interface YtCaptionTrack {
  language: string;
  name: string;
  kind: string;
}

export interface YtCaptionsResponse {
  ok: true;
  tracks: YtCaptionTrack[];
  /** 공식 API(API 키)로 자막 내용을 내려받을 수 있는지 — 이 앱에서는 항상 false */
  downloadable: false;
  reason: string;
  unitsUsed: number;
}

export type YtErrorCode =
  | 'not_configured'
  | 'quota_exceeded'
  | 'local_cap_reached'
  | 'not_found'
  | 'invalid_key'
  | 'forbidden'
  | 'bad_request'
  | 'upstream_error'
  | 'network_error';

export interface YtErrorResponse {
  ok: false;
  code: YtErrorCode;
  message: string;
}
