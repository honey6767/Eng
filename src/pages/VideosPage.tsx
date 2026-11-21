import { Link } from 'react-router-dom';
import { useState } from 'react';
import { contentStore, repos } from '@/repositories';
import { daySeriesOf } from '@/services/days/daySeries';
import { useLiveData } from '@/hooks/useLiveData';
import { useToast } from '@/hooks/useToast';
import { useYouTubeStatus } from '@/hooks/useYouTubeStatus';
import { youtubeClient } from '@/services/integrations/youtubeClient';
import { importPlaylist } from '@/services/videoImportService';
import { enqueueNewVideos } from '@/services/prep';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, SectionTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Loading } from '@/components/ui/Loading';
import { EmptyState } from '@/components/ui/EmptyState';
import { VideoThumb } from '@/components/video/VideoThumb';
import { AddVideoForm } from '@/components/video/AddVideoForm';
import { StudyQueueCard } from '@/components/video/StudyQueueCard';
import { PrepBadge, PrepStatusCard } from '@/components/prep/PrepStatus';
import { formatDateKo, formatDuration } from '@/utils/date';
import { TRANSCRIPT_STATUS, VIDEO_STATUS } from '@/utils/labels';
import type { Playlist, VideoStatus } from '@/types/models';

const FILTERS: { key: VideoStatus | 'all'; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'new', label: '신규' },
  { key: 'in_progress', label: '학습 중' },
  { key: 'completed', label: '완료' },
];
const PAGE = 30;
type SeriesFilter = 'all' | 'day' | 'general';
const SERIES_FILTERS: { key: SeriesFilter; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'day', label: 'Day 1~100' },
  { key: 'general', label: '일반 영상' },
];

export function VideosPage() {
  const { status, refresh } = useYouTubeStatus();
  const [filter, setFilter] = useState<VideoStatus | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  // Day 1~100 / 일반 영상 / 전체 (기본: 전체)
  const [seriesFilter, setSeriesFilter] = useState<SeriesFilter>('all');
  const [limit, setLimit] = useState(PAGE);

  const data = useLiveData(async () => {
    const [videos, playlists, sentences, days] = await Promise.all([
      repos.videos.list(),
      repos.playlists.list(),
      repos.keySentences.list(),
      contentStore.listDayAssignments(),
    ]);
    const dayOf = new Map(days.map((d) => [d.videoId, d]));
    const ts = await Promise.all(videos.map((v) => repos.transcripts.getByVideo(v.id)));
    return {
      playlists,
      rows: videos.map((v, i) => ({
        video: v,
        transcript: ts[i],
        sentenceCount: sentences.filter((s) => s.videoId === v.id).length,
        // 샘플은 Day 시리즈로 보지 않는다
        series: v.isSample ? { isDay: false, dayNumber: null } : daySeriesOf(v, dayOf.get(v.id)),
      })),
    };
  }, []);

  if (!data) return <Loading />;
  const playlistById = new Map(data.playlists.map((p) => [p.id, p]));

  const bySeries = data.rows.filter((r) => seriesFilter === 'all' || (seriesFilter === 'day') === r.series.isDay);
  const bySource = bySeries.filter(({ video }) => {
    if (sourceFilter === 'all') return true;
    if (sourceFilter === 'manual') return video.sources?.some((s) => s.kind === 'manual');
    if (sourceFilter === 'sample') return video.isSample;
    return video.sources?.some((s) => s.kind === 'playlist' && s.playlistId === sourceFilter);
  });
  const rows = filter === 'all' ? bySource : bySource.filter((r) => r.video.status === filter);
  const hasManual = data.rows.some((r) => r.video.sources?.some((s) => s.kind === 'manual') && !r.video.isSample);

  return (
    <div className="space-y-6">
      <PageHeader title="영상" description="재생목록이나 영상을 등록하고, 무작위 순서 또는 원하는 영상으로 학습합니다." />

      <AddVideoForm status={status} onImported={refresh} />
      <StudyQueueCard />
      <PrepStatusCard />

      {data.playlists.length > 0 && (
        <section>
          <SectionTitle>재생목록</SectionTitle>
          <Card className="divide-y divide-line">
            {data.playlists.map((p) => (
              <PlaylistRow
                key={p.id}
                playlist={p}
                videoCount={data.rows.filter((r) => r.video.sources?.some((s) => s.kind === 'playlist' && s.playlistId === p.id)).length}
                canSync={status?.available === true}
                onSynced={refresh}
              />
            ))}
          </Card>
        </section>
      )}

      <section>
        <SectionTitle action={<span className="text-sm text-muted">{rows.length}개</span>}>영상 목록</SectionTitle>
        <div className="mb-2 flex gap-1.5 overflow-x-auto" role="tablist" aria-label="Day·일반 영상 필터" data-testid="series-filter">
          {SERIES_FILTERS.map((f) => {
            const count = f.key === 'all' ? data.rows.length : data.rows.filter((r) => (f.key === 'day') === r.series.isDay).length;
            const active = seriesFilter === f.key;
            return (
              <button
                key={f.key}
                role="tab"
                aria-selected={active}
                data-series={f.key}
                onClick={() => {
                  setSeriesFilter(f.key);
                  setLimit(PAGE);
                }}
                className={`h-9 shrink-0 rounded-full px-3.5 text-sm font-semibold transition-colors ${active ? 'bg-brand text-white' : 'border border-line bg-surface text-muted hover:text-ink'}`}
              >
                {f.label} <span className="ml-0.5 opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex gap-1.5 overflow-x-auto" role="tablist" aria-label="학습 상태 필터">
            {FILTERS.map((f) => {
              const count = f.key === 'all' ? bySource.length : bySource.filter((r) => r.video.status === f.key).length;
              const active = filter === f.key;
              return (
                <button
                  key={f.key}
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setFilter(f.key);
                    setLimit(PAGE);
                  }}
                  className={`h-9 shrink-0 rounded-full px-3.5 text-sm font-semibold transition-colors ${
                    active ? 'bg-ink text-white' : 'border border-line bg-surface text-muted hover:text-ink'
                  }`}
                >
                  {f.label} <span className="ml-0.5 opacity-70">{count}</span>
                </button>
              );
            })}
          </div>
          <select
            value={sourceFilter}
            onChange={(e) => {
              setSourceFilter(e.target.value);
              setLimit(PAGE);
            }}
            aria-label="출처 필터"
            className="h-9 rounded-xl border border-line bg-surface px-2.5 text-sm text-muted outline-none focus:border-brand sm:ml-auto sm:max-w-64"
          >
            <option value="all">모든 출처</option>
            {data.playlists.map((p) => (
              <option key={p.id} value={p.id}>
                재생목록: {p.title}
              </option>
            ))}
            {hasManual && <option value="manual">개별 등록 영상</option>}
            {data.rows.some((r) => r.video.isSample) && <option value="sample">샘플 데이터</option>}
          </select>
        </div>

        {rows.length === 0 ? (
          <Card>
            <EmptyState icon="video" title={data.rows.length === 0 ? '등록된 영상이 없어요' : '해당하는 영상이 없어요'}>
              {data.rows.length === 0 && '위에서 재생목록이나 영상 URL을 등록해 주세요.'}
            </EmptyState>
          </Card>
        ) : (
          <>
            <ul className="grid gap-3 md:grid-cols-2" data-testid="video-list">
              {rows.slice(0, limit).map(({ video, transcript, sentenceCount, series }) => {
                const st = VIDEO_STATUS[video.status];
                const tsKey = transcript?.status ?? 'none';
                const manual = video.sources?.some((s) => s.kind === 'manual');
                const pl = video.sources?.find((s) => s.kind === 'playlist');
                return (
                  <li key={video.id}>
                    <Link to={`/videos/${video.id}`} className="block h-full">
                      <Card className="flex h-full gap-3.5 p-3.5 transition-colors hover:border-line-strong">
                        <VideoThumb title={video.title} thumbnailUrl={video.thumbnailUrl} className="w-28 shrink-0 self-start sm:w-32" />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <div className="flex flex-wrap gap-1">
                            <Badge tone={st.tone}>{st.label}</Badge>
                            {series.isDay && <Badge tone="brand">Day {series.dayNumber}</Badge>}
                            {video.isSample && <Badge>샘플</Badge>}
                            {manual && !video.isSample && <Badge tone="info">개별 등록</Badge>}
                          </div>
                          <p className="mt-1.5 line-clamp-2 leading-snug font-semibold">{video.title}</p>
                          {!video.isSample && <span className="mt-1 inline-block"><PrepBadge videoId={video.id} /></span>}
                          <p className="mt-auto pt-2 text-xs text-muted">
                            {formatDuration(video.durationSec)}
                            {video.isSample ? ` · 핵심 문장 ${sentenceCount}/5` : video.channelTitle ? ` · ${video.channelTitle}` : ''}
                          </p>
                          <p className={`truncate text-xs ${tsKey === 'failed' ? 'text-danger' : 'text-subtle'}`}>
                            {TRANSCRIPT_STATUS[tsKey].label}
                            {pl && pl.kind === 'playlist' && playlistById.get(pl.playlistId) && !video.isSample
                              ? ` · ${playlistById.get(pl.playlistId)!.title}${pl.position != null ? ` #${pl.position + 1}` : ''}`
                              : ''}
                          </p>
                        </div>
                      </Card>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {rows.length > limit && (
              <div className="mt-4 text-center">
                <Button variant="secondary" onClick={() => setLimit((l) => l + PAGE)}>
                  더 보기 ({rows.length - limit}개 남음)
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function PlaylistRow({ playlist, videoCount, canSync, onSynced }: { playlist: Playlist; videoCount: number; canSync: boolean; onSynced: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const s = playlist.lastSyncSummary;
  return (
    <div className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center" data-testid="playlist-row">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="font-semibold">{playlist.title}</p>
          {playlist.isSample && <Badge>샘플</Badge>}
          {playlist.syncStatus === 'failed' && <Badge tone="danger">불러오기 실패</Badge>}
          {playlist.syncSource === 'rss' && <Badge tone="warn">일부만 (RSS 제한 모드)</Badge>}
        </div>
        <p className="text-xs text-muted">
          등록 영상 {videoCount}개
          {playlist.itemCount != null && ` · YouTube 기준 ${playlist.itemCount}개`}
          {s && s.unavailable > 0 && ` · 불러올 수 없는 영상 ${s.unavailable}개`}
          {playlist.lastSyncedAt && ` · 마지막 불러오기 ${formatDateKo(playlist.lastSyncedAt)}`}
        </p>
        {playlist.syncStatus === 'failed' && playlist.syncError && <p className="text-xs text-danger">{playlist.syncError}</p>}
      </div>
      {playlist.youtubePlaylistId && (
        <Button
          variant="secondary"
          size="sm"
          disabled={!canSync || busy}
          onClick={async () => {
            setBusy(true);
            try {
              const before = new Set((await repos.videos.list()).map((v) => v.id));
              const r = await importPlaylist(repos, youtubeClient, playlist.youtubePlaylistId!);
              void enqueueNewVideos(before, (await repos.videos.list()).map((v) => v.id));
              toast(`다시 불러왔어요 · 새 영상 ${r.added}개`);
            } catch (e) {
              toast(e instanceof Error ? e.message : '불러오기 실패', 'error');
            } finally {
              setBusy(false);
              onSynced();
            }
          }}
        >
          {busy ? '불러오는 중…' : '새 영상 확인'}
        </Button>
      )}
    </div>
  );
}
