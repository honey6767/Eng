import type { Repositories } from '@/repositories/types';
import type { CaptionCheck, MetadataSource, Playlist, Video } from '@/types/models';
import type { YtUnavailableItem, YtVideoInfo } from '@/types/youtubeApi';
import { YouTubeApiError, type YouTubeClient } from './integrations/youtubeClient';
import { defaultThumbnailUrl, playlistUrl } from '@/utils/youtubeUrl';
import { nowISO } from '@/utils/date';
import { syncStudyQueue } from './studyQueue';

export interface ImportOutcome {
  kind: 'playlist' | 'video';
  playlist: Playlist | null;
  playlistCreated: boolean;
  /** 새로 추가된 영상 */
  added: number;
  /** 이미 등록된 영상에 이번 출처를 새로 연결 */
  linked: number;
  /** 이미 같은 출처로 등록되어 변경 없음(정보만 갱신) */
  unchanged: number;
  unavailable: YtUnavailableItem[];
  /** 전체를 가져왔는지 (RSS 제한 모드 = false) */
  complete: boolean;
  source: MetadataSource;
  note?: string;
  unitsUsed: number;
  videos: Video[];
}

const toInput = (v: YtVideoInfo, source: MetadataSource) => ({
  youtubeVideoId: v.videoId,
  title: v.title,
  channelTitle: v.channelTitle,
  thumbnailUrl: v.thumbnailUrl ?? defaultThumbnailUrl(v.videoId),
  durationSec: v.durationSec,
  metadataSource: source,
  position: v.position,
});

/** 재생목록 등록/다시 불러오기 — 같은 재생목록·같은 영상은 중복 생성하지 않는다 */
export async function importPlaylist(repos: Repositories, client: YouTubeClient, playlistId: string): Promise<ImportOutcome> {
  let res;
  try {
    res = await client.playlist(playlistId);
  } catch (e) {
    const existing = await repos.playlists.getByYouTubeId(playlistId);
    if (existing) {
      await repos.playlists.update(existing.id, { syncStatus: 'failed', syncError: e instanceof Error ? e.message : String(e) });
    }
    throw e;
  }
  const source: MetadataSource = res.source === 'youtube_api' ? 'youtube_api' : 'rss';
  const { playlist, created } = await repos.playlists.upsertByYouTubeId({
    youtubePlaylistId: playlistId,
    url: playlistUrl(playlistId),
    title: res.playlist.title,
    channelTitle: res.playlist.channelTitle,
    thumbnailUrl: res.playlist.thumbnailUrl,
    itemCount: res.playlist.itemCount,
  });
  const results = await repos.videos.upsertFromYouTube(
    res.videos.map((v) => toInput(v, source)),
    { kind: 'playlist', playlistId: playlist.id },
  );
  const added = results.filter((r) => r.created).length;
  const linked = results.filter((r) => r.linked).length;
  const summary = {
    totalItems: res.videos.length + res.unavailable.length,
    added,
    linked,
    unavailable: res.unavailable.length,
    complete: res.complete,
  };
  await repos.playlists.update(playlist.id, {
    lastSyncedAt: nowISO(),
    syncStatus: 'success',
    syncError: undefined,
    syncSource: source,
    lastSyncSummary: summary,
  });
  await syncStudyQueue(repos);
  return {
    kind: 'playlist',
    playlist: (await repos.playlists.get(playlist.id)) ?? playlist,
    playlistCreated: created,
    added,
    linked,
    unchanged: results.length - added - linked,
    unavailable: res.unavailable,
    complete: res.complete,
    source,
    note: res.note,
    unitsUsed: res.unitsUsed,
    videos: results.map((r) => r.video),
  };
}

/** 개별 영상 URL 등록 — 재생목록에 이미 있는 영상이면 기존 데이터를 유지하고 '개별 등록' 출처만 연결 */
export async function importVideo(repos: Repositories, client: YouTubeClient, videoId: string): Promise<ImportOutcome> {
  const res = await client.video(videoId);
  const source: MetadataSource = res.source === 'youtube_api' ? 'youtube_api' : 'oembed';
  return saveSingle(repos, toInput(res.video, source), source, res.unitsUsed);
}

/**
 * 서버 프록시 없이 등록 (정적 배포 등) — URL에서 추출한 ID와 공식 썸네일 경로만 저장.
 * 제목은 사용자가 입력하고, 길이는 알 수 없음으로 표시한다.
 */
export async function importVideoWithoutProxy(repos: Repositories, videoId: string, title: string): Promise<ImportOutcome> {
  const input = {
    youtubeVideoId: videoId,
    title: title.trim() || `YouTube 영상 (${videoId})`,
    channelTitle: null,
    thumbnailUrl: defaultThumbnailUrl(videoId),
    durationSec: null,
    metadataSource: 'manual' as const,
  };
  return saveSingle(repos, input, 'manual', 0);
}

async function saveSingle(
  repos: Repositories,
  input: Parameters<Repositories['videos']['upsertFromYouTube']>[0][number],
  source: MetadataSource,
  unitsUsed: number,
): Promise<ImportOutcome> {
  const [r] = await repos.videos.upsertFromYouTube([input], { kind: 'manual' });
  await syncStudyQueue(repos);
  return {
    kind: 'video',
    playlist: null,
    playlistCreated: false,
    added: r.created ? 1 : 0,
    linked: r.linked ? 1 : 0,
    unchanged: !r.created && !r.linked ? 1 : 0,
    unavailable: [],
    complete: true,
    source,
    unitsUsed,
    videos: [r.video],
  };
}

/**
 * 자막 자동 가져오기 시도.
 * 공식 API(captions.list)로 자막 트랙 존재 여부만 확인할 수 있고, 내용 다운로드(captions.download)는
 * 영상 소유자 권한(OAuth)이 필요하므로 자막을 자동 등록하지 않는다. 결과는 영상에 기록한다.
 */
export async function checkCaptions(repos: Repositories, client: YouTubeClient, video: Video): Promise<CaptionCheck> {
  if (!video.youtubeVideoId) throw new Error('YouTube 영상 ID가 없는 영상입니다.');
  let check: CaptionCheck;
  try {
    const res = await client.captions(video.youtubeVideoId);
    check = {
      checkedAt: nowISO(),
      result: res.tracks.length > 0 ? 'tracks_found_no_permission' : 'no_tracks',
      tracks: res.tracks,
      message:
        res.tracks.length > 0
          ? `자막 트랙 ${res.tracks.length}개를 확인했지만, ${res.reason}`
          : '이 영상에는 등록된 자막 트랙이 없습니다.',
    };
  } catch (e) {
    const code = e instanceof YouTubeApiError ? e.code : 'error';
    check = {
      checkedAt: nowISO(),
      result:
        code === 'quota_exceeded' || code === 'local_cap_reached'
          ? 'quota_exceeded'
          : code === 'not_configured' || code === 'proxy_unavailable'
            ? 'not_configured'
            : 'error',
      tracks: [],
      message: e instanceof Error ? e.message : '자막 확인 중 오류가 발생했습니다.',
    };
  }
  await repos.videos.update(video.id, { captionCheck: check });
  return check;
}
