/**
 * YouTube 프록시 핸들러 (프레임워크 독립 — Vite 개발 서버와 Cloudflare Worker에서 공용)
 *
 * 보안: API 키는 서버 환경변수(YOUTUBE_API_KEY)로만 받고, Google에는 X-Goog-Api-Key 헤더로 전달한다.
 *       응답·로그·URL 어디에도 키를 포함하지 않는다.
 * 비용: YouTube Data API는 무료 할당량(기본 10,000 단위/일)을 넘으면 403(quotaExceeded)을 돌려줄 뿐
 *       과금되지 않는다. 그래도 자체 상한(QuotaTracker)에서 먼저 호출을 멈춘다.
 */
import type {
  YtCaptionsResponse,
  YtErrorCode,
  YtErrorResponse,
  YtPlaylistResponse,
  YtStatusResponse,
  YtUnavailableItem,
  YtVideoInfo,
  YtVideoResponse,
} from '../../src/types/youtubeApi.ts';
import { isValidPlaylistId, isValidVideoId } from '../../src/utils/youtubeUrl.ts';
import { QuotaTracker, UNIT_COST } from './quota.ts';
import { parseIsoDuration, parsePlaylistRss, pickThumbnail } from './parse.ts';

export interface HandlerDeps {
  apiKey: string | null;
  quota: QuotaTracker;
  fetch: typeof fetch;
  mock?: boolean;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

const API_BASE = 'https://www.googleapis.com/youtube/v3';
/** 재생목록 페이지 최대 수 (50개 × 100 = 5,000개) — 무한 루프 방지 */
const MAX_PLAYLIST_PAGES = 100;

class ApiError extends Error {
  constructor(
    public status: number,
    public code: YtErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const err = (status: number, code: YtErrorCode, message: string): HandlerResult => ({
  status,
  body: { ok: false, code, message } satisfies YtErrorResponse,
});

type Endpoint = keyof typeof UNIT_COST;

async function callApi<T>(deps: HandlerDeps, endpoint: Endpoint, params: Record<string, string>): Promise<T> {
  const cost = UNIT_COST[endpoint];
  if (!deps.quota.canSpend(cost)) {
    const q = deps.quota.snapshot();
    throw new ApiError(
      429,
      q.exhausted ? 'quota_exceeded' : 'local_cap_reached',
      q.exhausted
        ? 'YouTube API 오늘 무료 할당량을 모두 사용했습니다. 태평양 시간 자정(한국 시간 오후 4~5시)에 초기화됩니다.'
        : `이 앱의 하루 사용 상한(${q.cap} 단위)에 도달해 호출을 중단했습니다. 내일 다시 시도해 주세요.`,
    );
  }
  const resource = endpoint.split('.')[0];
  const url = `${API_BASE}/${resource}?${new URLSearchParams(params)}`;
  deps.quota.spend(cost);
  let res: Response;
  try {
    res = await deps.fetch(url, { headers: { 'X-Goog-Api-Key': deps.apiKey ?? '', Accept: 'application/json' } });
  } catch {
    throw new ApiError(502, 'network_error', 'YouTube API 서버에 연결하지 못했습니다.');
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) throw mapGoogleError(res.status, json, deps);
  return json as T;
}

function mapGoogleError(status: number, json: Record<string, unknown> | null, deps: HandlerDeps): ApiError {
  const error = (json?.error ?? {}) as { message?: string; errors?: { reason?: string }[]; status?: string; details?: { reason?: string }[] };
  const reasons = [
    ...(error.errors ?? []).map((e) => e.reason),
    ...(error.details ?? []).map((d) => d.reason),
    error.status,
  ].filter(Boolean) as string[];
  const has = (...r: string[]) => reasons.some((x) => r.includes(x));

  if (has('quotaExceeded', 'dailyLimitExceeded', 'RESOURCE_EXHAUSTED')) {
    deps.quota.markExhausted();
    return new ApiError(429, 'quota_exceeded', 'YouTube API 오늘 무료 할당량을 모두 사용했습니다. 추가 비용 없이 내일 다시 사용할 수 있습니다.');
  }
  if (has('rateLimitExceeded', 'userRateLimitExceeded')) {
    return new ApiError(429, 'quota_exceeded', '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.');
  }
  if (has('keyInvalid', 'API_KEY_INVALID') || /api key not valid/i.test(error.message ?? '')) {
    return new ApiError(401, 'invalid_key', 'YouTube API 키가 올바르지 않습니다. .env.local의 YOUTUBE_API_KEY를 확인해 주세요.');
  }
  if (has('accessNotConfigured', 'SERVICE_DISABLED')) {
    return new ApiError(403, 'forbidden', 'Google Cloud 프로젝트에서 YouTube Data API v3가 활성화되지 않았습니다.');
  }
  if (has('playlistNotFound', 'videoNotFound', 'notFound') || status === 404) {
    return new ApiError(404, 'not_found', '영상 또는 재생목록을 찾을 수 없습니다. 비공개이거나 삭제되었을 수 있습니다.');
  }
  if (status === 403) {
    return new ApiError(403, 'forbidden', `YouTube API 접근이 거부되었습니다. (${error.message ?? 'forbidden'}) API 키 제한 설정을 확인해 주세요.`);
  }
  if (status === 400) return new ApiError(400, 'bad_request', error.message ?? '잘못된 요청입니다.');
  return new ApiError(502, 'upstream_error', `YouTube API 오류 (${status})`);
}

interface ApiVideo {
  id: string;
  snippet?: { title?: string; channelTitle?: string; thumbnails?: Record<string, { url?: string }>; publishedAt?: string };
  contentDetails?: { duration?: string };
  status?: { privacyStatus?: string };
}

function toVideoInfo(v: ApiVideo, position: number | null): YtVideoInfo {
  return {
    videoId: v.id,
    title: v.snippet?.title ?? '(제목 없음)',
    channelTitle: v.snippet?.channelTitle ?? null,
    thumbnailUrl: pickThumbnail(v.snippet?.thumbnails),
    durationSec: parseIsoDuration(v.contentDetails?.duration),
    publishedAt: v.snippet?.publishedAt ?? null,
    position,
  };
}

async function fetchVideosByIds(deps: HandlerDeps, ids: string[]): Promise<Map<string, ApiVideo>> {
  const result = new Map<string, ApiVideo>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const json = await callApi<{ items?: ApiVideo[] }>(deps, 'videos.list', {
      part: 'snippet,contentDetails,status',
      id: batch.join(','),
      maxResults: '50',
    });
    for (const item of json.items ?? []) result.set(item.id, item);
  }
  return result;
}

// ─────────────────────────────────────────────

async function getVideo(deps: HandlerDeps, videoId: string): Promise<YtVideoResponse> {
  if (deps.apiKey) {
    const map = await fetchVideosByIds(deps, [videoId]);
    const v = map.get(videoId);
    if (!v) throw new ApiError(404, 'not_found', '영상을 찾을 수 없습니다. 비공개이거나 삭제되었을 수 있습니다.');
    return { ok: true, source: 'youtube_api', video: toVideoInfo(v, null), unitsUsed: 1 };
  }
  // 제한 모드: oEmbed (공식, 키 불필요) — 제목·채널·썸네일만, 길이는 제공되지 않음
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
  let res: Response;
  try {
    res = await deps.fetch(url);
  } catch {
    throw new ApiError(502, 'network_error', 'YouTube에 연결하지 못했습니다.');
  }
  if (res.status === 404 || res.status === 400) throw new ApiError(404, 'not_found', '영상을 찾을 수 없습니다.');
  if (res.status === 401 || res.status === 403)
    throw new ApiError(403, 'forbidden', '비공개 영상이거나 외부 정보 조회가 허용되지 않은 영상입니다.');
  if (!res.ok) throw new ApiError(502, 'upstream_error', `YouTube 오류 (${res.status})`);
  const o = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
  return {
    ok: true,
    source: 'oembed',
    video: {
      videoId,
      title: o.title ?? '(제목 없음)',
      channelTitle: o.author_name ?? null,
      thumbnailUrl: o.thumbnail_url ?? null,
      durationSec: null,
      publishedAt: null,
      position: null,
    },
    unitsUsed: 0,
  };
}

interface ApiPlaylistItem {
  snippet?: {
    title?: string;
    position?: number;
    resourceId?: { videoId?: string };
    thumbnails?: Record<string, { url?: string }>;
    videoOwnerChannelTitle?: string;
  };
  contentDetails?: { videoId?: string };
  status?: { privacyStatus?: string };
}

async function getPlaylist(deps: HandlerDeps, playlistId: string): Promise<YtPlaylistResponse> {
  if (!deps.apiKey) return getPlaylistViaRss(deps, playlistId);

  let units = 0;
  const meta = await callApi<{
    items?: { snippet?: { title?: string; channelTitle?: string; thumbnails?: Record<string, { url?: string }> }; contentDetails?: { itemCount?: number } }[];
  }>(deps, 'playlists.list', { part: 'snippet,contentDetails', id: playlistId });
  units += 1;
  const p = meta.items?.[0];
  if (!p) throw new ApiError(404, 'not_found', '재생목록을 찾을 수 없습니다. 비공개 재생목록은 불러올 수 없습니다.');
  const itemCount = p.contentDetails?.itemCount ?? null;

  // 예상 비용 확인: 페이지 수 + 길이 조회 수
  const estimated = itemCount != null ? Math.ceil(itemCount / 50) * 2 : 2;
  if (!deps.quota.canSpend(estimated)) {
    const q = deps.quota.snapshot();
    throw new ApiError(429, 'local_cap_reached', `재생목록을 불러오려면 약 ${estimated} 단위가 필요하지만 오늘 남은 사용량(${Math.max(0, q.cap - q.used)} 단위)이 부족합니다.`);
  }

  // 1) 재생목록 항목 — 페이지네이션으로 전체 수집
  const items: ApiPlaylistItem[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const params: Record<string, string> = { part: 'snippet,contentDetails,status', playlistId, maxResults: '50' };
    if (pageToken) params.pageToken = pageToken;
    const page = await callApi<{ items?: ApiPlaylistItem[]; nextPageToken?: string }>(deps, 'playlistItems.list', params);
    units += 1;
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
    pages++;
  } while (pageToken && pages < MAX_PLAYLIST_PAGES);
  const truncated = !!pageToken;

  // 2) 영상 길이 등 상세 정보 — 50개씩 묶어서 조회
  const ids = [...new Set(items.map((i) => i.contentDetails?.videoId ?? i.snippet?.resourceId?.videoId).filter(isValidVideoId))];
  const details = await fetchVideosByIds(deps, ids);
  units += Math.ceil(ids.length / 50);

  const videos: YtVideoInfo[] = [];
  const unavailable: YtUnavailableItem[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const videoId = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId ?? null;
    const position = item.snippet?.position ?? index;
    const title = item.snippet?.title ?? '';
    const detail = videoId ? details.get(videoId) : undefined;
    if (!videoId || !detail) {
      unavailable.push({
        videoId,
        position,
        title,
        reason: title === 'Private video' ? '비공개 영상' : title === 'Deleted video' ? '삭제된 영상' : '정보를 불러올 수 없음',
      });
      return;
    }
    if (seen.has(videoId)) return; // 같은 재생목록 안 중복 항목
    seen.add(videoId);
    videos.push(toVideoInfo(detail, position));
  });

  return {
    ok: true,
    source: 'youtube_api',
    complete: !truncated,
    playlist: {
      playlistId,
      title: p.snippet?.title ?? '(제목 없음)',
      channelTitle: p.snippet?.channelTitle ?? null,
      thumbnailUrl: pickThumbnail(p.snippet?.thumbnails),
      itemCount,
    },
    videos,
    unavailable,
    unitsUsed: units,
    note: truncated ? `영상이 너무 많아 처음 ${MAX_PLAYLIST_PAGES * 50}개까지만 가져왔습니다.` : undefined,
  };
}

async function getPlaylistViaRss(deps: HandlerDeps, playlistId: string): Promise<YtPlaylistResponse> {
  let res: Response;
  try {
    res = await deps.fetch(`https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(playlistId)}`);
  } catch {
    throw new ApiError(502, 'network_error', 'YouTube에 연결하지 못했습니다.');
  }
  if (res.status === 404 || res.status === 400) throw new ApiError(404, 'not_found', '재생목록을 찾을 수 없습니다.');
  if (!res.ok) throw new ApiError(502, 'upstream_error', `YouTube 오류 (${res.status})`);
  const feed = parsePlaylistRss(await res.text());
  return {
    ok: true,
    source: 'rss',
    complete: false,
    playlist: { playlistId, title: feed.title || '(제목 없음)', channelTitle: feed.author, thumbnailUrl: feed.entries[0]?.thumbnailUrl ?? null, itemCount: null },
    videos: feed.entries.map((e, i) => ({
      videoId: e.videoId,
      title: e.title,
      channelTitle: e.author,
      thumbnailUrl: e.thumbnailUrl,
      durationSec: null,
      publishedAt: e.published,
      position: i,
    })),
    unavailable: [],
    unitsUsed: 0,
    note: 'API 키가 없어 공개 RSS 피드로 가져왔습니다. RSS는 최근 15개 영상만 제공하며 영상 길이를 알 수 없습니다. 전체 목록과 길이는 YouTube API 키 설정 후 다시 불러오세요.',
  };
}

async function getCaptions(deps: HandlerDeps, videoId: string): Promise<YtCaptionsResponse> {
  if (!deps.apiKey) {
    throw new ApiError(400, 'not_configured', '자막 확인에는 YouTube API 키가 필요합니다.');
  }
  const json = await callApi<{ items?: { snippet?: { language?: string; name?: string; trackKind?: string } }[] }>(deps, 'captions.list', {
    part: 'snippet',
    videoId,
  });
  return {
    ok: true,
    tracks: (json.items ?? []).map((i) => ({
      language: i.snippet?.language ?? '',
      name: i.snippet?.name ?? '',
      kind: (i.snippet?.trackKind ?? 'standard').toLowerCase(),
    })),
    downloadable: false,
    reason:
      'YouTube Data API의 자막 다운로드(captions.download)는 OAuth 로그인과 영상 소유자 또는 편집 권한이 필요합니다. 다른 사람의 영상 자막은 공식 API로 내려받을 수 없어 자동 등록하지 않습니다.',
    unitsUsed: UNIT_COST['captions.list'],
  };
}

// ─────────────────────────────────────────────

/** /api/youtube/* 요청 처리. 해당 경로가 아니면 null */
export async function handleYouTubeApi(url: URL, deps: HandlerDeps): Promise<HandlerResult | null> {
  const prefix = '/api/youtube/';
  if (!url.pathname.startsWith(prefix)) return null;
  const route = url.pathname.slice(prefix.length).replace(/\/$/, '');

  try {
    switch (route) {
      case 'status': {
        const body: YtStatusResponse = { ok: true, mode: deps.apiKey ? 'api' : 'limited', quota: deps.quota.snapshot(), mock: !!deps.mock };
        return { status: 200, body };
      }
      case 'video': {
        const id = url.searchParams.get('id');
        if (!isValidVideoId(id)) return err(400, 'bad_request', '올바른 영상 ID가 아닙니다.');
        return { status: 200, body: await getVideo(deps, id) };
      }
      case 'playlist': {
        const id = url.searchParams.get('id');
        if (!isValidPlaylistId(id)) return err(400, 'bad_request', '올바른 재생목록 ID가 아닙니다.');
        return { status: 200, body: await getPlaylist(deps, id) };
      }
      case 'captions': {
        const id = url.searchParams.get('id');
        if (!isValidVideoId(id)) return err(400, 'bad_request', '올바른 영상 ID가 아닙니다.');
        return { status: 200, body: await getCaptions(deps, id) };
      }
      default:
        return err(404, 'not_found', '알 수 없는 API 경로입니다.');
    }
  } catch (e) {
    if (e instanceof ApiError) return err(e.status, e.code, e.message);
    return err(500, 'upstream_error', '서버 내부 오류가 발생했습니다.');
  }
}
