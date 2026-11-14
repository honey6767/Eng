import { Link } from 'react-router-dom';
import { useState } from 'react';
import { repos } from '@/repositories';
import { useLiveData } from '@/hooks/useLiveData';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { PlannedNotice } from '@/components/ui/PlannedNotice';
import { Loading } from '@/components/ui/Loading';
import { EmptyState } from '@/components/ui/EmptyState';
import { VideoThumb } from '@/components/video/VideoThumb';
import { formatDuration } from '@/utils/date';
import { TRANSCRIPT_STATUS, VIDEO_STATUS } from '@/utils/labels';
import type { VideoStatus } from '@/types/models';

const FILTERS: { key: VideoStatus | 'all'; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'new', label: '신규' },
  { key: 'in_progress', label: '학습 중' },
  { key: 'completed', label: '완료' },
];

export function VideosPage() {
  const [filter, setFilter] = useState<VideoStatus | 'all'>('all');
  const data = useLiveData(async () => {
    const [videos, sentences, dialogues] = await Promise.all([
      repos.videos.list(),
      repos.keySentences.list(),
      repos.dialogues.list('original'),
    ]);
    const transcripts = await Promise.all(videos.map((v) => repos.transcripts.getByVideo(v.id)));
    return videos.map((v, i) => ({
      video: v,
      transcript: transcripts[i],
      sentenceCount: sentences.filter((s) => s.videoId === v.id).length,
      dialogueCount: dialogues.filter((d) => d.videoId === v.id).length,
    }));
  }, []);

  if (!data) return <Loading />;
  const rows = filter === 'all' ? data : data.filter((r) => r.video.status === filter);

  return (
    <div>
      <PageHeader title="영상" description="영상별 학습 자료와 진행 상태를 확인합니다." />

      <div className="mb-5">
        <PlannedNotice title="재생목록 URL 등록 · 영상 목록 불러오기 · 무작위 학습 순서" stage="2단계">
          지금은 샘플 영상만 표시됩니다. 2단계에서 재생목록을 등록하고 영상 정보를 저장할 수 있게 됩니다.
        </PlannedNotice>
      </div>

      <div className="mb-4 flex gap-1.5 overflow-x-auto" role="tablist" aria-label="학습 상태 필터">
        {FILTERS.map((f) => {
          const count = f.key === 'all' ? data.length : data.filter((r) => r.video.status === f.key).length;
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(f.key)}
              className={`h-9 shrink-0 rounded-full px-3.5 text-sm font-semibold transition-colors ${
                active ? 'bg-ink text-white' : 'border border-line bg-surface text-muted hover:text-ink'
              }`}
            >
              {f.label} <span className="ml-0.5 opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState icon="video" title="해당하는 영상이 없어요" />
        </Card>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {rows.map(({ video, transcript, sentenceCount, dialogueCount }) => {
            const status = VIDEO_STATUS[video.status];
            const ts = TRANSCRIPT_STATUS[transcript?.status ?? 'none'];
            return (
              <li key={video.id}>
                <Link to={`/videos/${video.id}`} className="block h-full">
                  <Card className="flex h-full gap-3.5 p-3.5 transition-colors hover:border-line-strong">
                    <VideoThumb title={video.title} thumbnailUrl={video.thumbnailUrl} className="w-28 shrink-0 sm:w-32" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={status.tone}>{status.label}</Badge>
                        {video.isSample && <Badge>샘플</Badge>}
                      </div>
                      <p className="mt-1.5 line-clamp-2 leading-snug font-semibold">{video.title}</p>
                      <p className="mt-auto pt-2 text-xs text-muted">
                        {formatDuration(video.durationSec)} · 핵심 문장 {sentenceCount}/5 · 대화문 {dialogueCount}
                      </p>
                      <p className={`text-xs ${transcript?.status === 'failed' ? 'text-danger' : 'text-subtle'}`}>{ts.label}</p>
                    </div>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
