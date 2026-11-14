/**
 * YouTube URL 해석 (네트워크 호출 없음)
 *
 * 지원: youtube.com/watch?v=, youtu.be/, /shorts/, /embed/, /live/, /v/, m.youtube.com, music.youtube.com,
 *       youtube.com/playlist?list=, watch?v=...&list=..., youtube-nocookie.com/embed/, 영상 ID(11자) 단독 입력
 */
export type ParsedYouTubeUrl =
  | { kind: 'video'; videoId: string }
  | { kind: 'playlist'; playlistId: string }
  /** 영상 URL에 재생목록 정보도 함께 있는 경우 — 사용자가 선택 */
  | { kind: 'video_in_playlist'; videoId: string; playlistId: string }
  | { kind: 'invalid'; reason: string };

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{12,64}$/;
const YT_HOSTS = ['youtube.com', 'm.youtube.com', 'www.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'];

export function isValidVideoId(id: string | null | undefined): id is string {
  return !!id && VIDEO_ID_RE.test(id);
}

export function isValidPlaylistId(id: string | null | undefined): id is string {
  // 'WL'(나중에 볼 동영상), 'LL'(좋아요) 같은 개인 목록은 API 키로 조회할 수 없음
  return !!id && PLAYLIST_ID_RE.test(id);
}

export function parseYouTubeUrl(input: string): ParsedYouTubeUrl {
  const text = input.trim();
  if (!text) return { kind: 'invalid', reason: 'URL을 입력해 주세요.' };
  if (VIDEO_ID_RE.test(text)) return { kind: 'video', videoId: text };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { kind: 'invalid', reason: '올바른 URL 형식이 아닙니다.' };
  }
  const host = url.hostname.toLowerCase();
  const list = url.searchParams.get('list');
  const playlistId = isValidPlaylistId(list) ? list : null;

  let videoId: string | null = null;
  if (host === 'youtu.be') {
    videoId = url.pathname.split('/')[1] ?? null;
  } else if (YT_HOSTS.includes(host)) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'watch') videoId = url.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) videoId = parts[1] ?? null;
    else if (parts[0] === 'playlist') {
      if (playlistId) return { kind: 'playlist', playlistId };
      return { kind: 'invalid', reason: '재생목록 ID(list=)를 찾을 수 없습니다.' };
    }
  } else {
    return { kind: 'invalid', reason: 'YouTube 주소가 아닙니다.' };
  }

  const validVideo = isValidVideoId(videoId) ? videoId : null;
  if (validVideo && playlistId) return { kind: 'video_in_playlist', videoId: validVideo, playlistId };
  if (validVideo) return { kind: 'video', videoId: validVideo };
  if (playlistId) return { kind: 'playlist', playlistId };
  return { kind: 'invalid', reason: '영상 ID 또는 재생목록 ID를 찾을 수 없습니다.' };
}

export function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function playlistUrl(playlistId: string): string {
  return `https://www.youtube.com/playlist?list=${playlistId}`;
}

/** YouTube 공식 썸네일 경로 (API 없이도 영상 ID로 확인 가능) */
export function defaultThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

export function embedUrl(videoId: string, startSec?: number | null, autoplay = false): string {
  const params = new URLSearchParams({ rel: '0', modestbranding: '1' });
  if (startSec != null && startSec > 0) params.set('start', String(Math.floor(startSec)));
  if (autoplay) params.set('autoplay', '1');
  return `https://www.youtube-nocookie.com/embed/${videoId}?${params}`;
}
