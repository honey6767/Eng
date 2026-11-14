import { Link, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { repos } from '@/repositories';
import { useLiveData } from '@/hooks/useLiveData';
import { useToast } from '@/hooks/useToast';
import {
  META_STUDY_QUEUE,
  reshuffleQueue,
  skipCurrent,
  startVideo,
  syncStudyQueue,
  viewQueue,
  type StudyQueueState,
} from '@/services/studyQueue';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { formatDuration } from '@/utils/date';
import { VIDEO_STATUS } from '@/utils/labels';
import { VideoThumb } from './VideoThumb';

/** 오늘의 신규 영상 (무작위 학습 순서) */
export function StudyQueueCard({ compact = false }: { compact?: boolean }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  /** 저장이 끝나기 전에도 체크 상태가 즉시 바뀌도록(낙관적 업데이트) */
  const [optimisticInclude, setOptimisticInclude] = useState<boolean | null>(null);

  // 화면 진입 시 순서를 영상 목록과 맞춘다 (변경이 있을 때만 저장)
  useEffect(() => {
    void syncStudyQueue(repos);
  }, []);

  const data = useLiveData(async () => {
    const [state, videos] = await Promise.all([repos.meta.get<StudyQueueState>(META_STUDY_QUEUE), repos.videos.list()]);
    return { view: viewQueue(state, videos), hasVideos: videos.length > 0, onlySample: videos.every((v) => v.isSample) };
  }, []);
  if (!data) return null;
  const { view } = data;
  const v = view.current;

  const act = async (fn: () => Promise<void>, msg?: string) => {
    setBusy(true);
    try {
      await fn();
      if (msg) toast(msg);
    } finally {
      setBusy(false);
      setOptimisticInclude(null);
    }
  };

  return (
    <Card className="p-4 sm:p-5" data-testid="study-queue">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-muted">오늘의 신규 영상 · 무작위 순서</p>
          {!view.allDone && view.total > 0 && (
            <p className="text-xs text-subtle" data-testid="queue-progress">
              {view.cycle}회차 · 이번 회차 남은 영상 {view.remaining}/{view.total}
              {view.includeCompleted && ' · 완료 영상 포함'}
            </p>
          )}
        </div>
        {!compact && data.hasVideos && (
          <label className="flex items-center gap-1.5 text-xs text-muted select-none">
            <input
              type="checkbox"
              checked={optimisticInclude ?? view.includeCompleted}
              disabled={busy}
              onChange={(e) => {
                setOptimisticInclude(e.target.checked);
                void act(
                  () => reshuffleQueue(repos, { includeCompleted: e.target.checked }),
                  e.target.checked ? '완료 영상도 포함해 다시 섞었어요' : '완료 영상을 빼고 다시 섞었어요',
                );
              }}
              className="size-4 accent-[var(--color-brand)]"
            />
            완료 영상 포함
          </label>
        )}
      </div>

      {!data.hasVideos ? (
        <p className="mt-3 text-sm text-muted">등록된 영상이 없어요. 재생목록이나 영상 URL을 등록해 주세요.</p>
      ) : view.allDone || !v ? (
        <div className="mt-3 text-sm text-muted">
          <p>모든 영상을 학습 완료했어요. 🎉</p>
          {!compact && <p className="mt-1 text-xs">‘완료 영상 포함’을 켜면 완료한 영상도 무작위로 다시 볼 수 있어요.</p>}
        </div>
      ) : (
        <div className={`mt-3 flex gap-3.5 ${compact ? 'items-center' : 'flex-col sm:flex-row'}`}>
          <Link to={`/videos/${v.id}`} className={compact ? 'w-24 shrink-0' : 'w-full shrink-0 sm:w-44'}>
            <VideoThumb title={v.title} thumbnailUrl={v.thumbnailUrl} className="w-full" />
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap gap-1">
              <Badge tone={VIDEO_STATUS[v.status].tone}>{VIDEO_STATUS[v.status].label}</Badge>
              {v.isSample && <Badge>샘플</Badge>}
            </div>
            <p className="mt-1 line-clamp-2 leading-snug font-semibold" data-testid="queue-current-title">
              {v.title}
            </p>
            <p className="mt-0.5 text-xs text-muted">{formatDuration(v.durationSec)}</p>
            {!compact && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await startVideo(repos, v);
                      navigate(`/videos/${v.id}`);
                    })
                  }
                >
                  <Icon name="play" className="size-4" />이 영상 학습 시작
                </Button>
                <Button variant="secondary" disabled={busy || view.remaining < 2} onClick={() => act(() => skipCurrent(repos, v.id), '이 영상은 이번 회차 맨 뒤로 보냈어요')}>
                  건너뛰기
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => act(() => reshuffleQueue(repos), '학습 순서를 다시 섞었어요')}>
                  <Icon name="review" className="size-4" />
                  다시 섞기
                </Button>
              </div>
            )}
          </div>
          {compact && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await startVideo(repos, v);
                  navigate(`/videos/${v.id}`);
                })
              }
            >
              학습 시작
            </Button>
          )}
        </div>
      )}
      {data.onlySample && data.hasVideos && !compact && (
        <p className="mt-3 text-xs text-subtle">실제 영상을 등록하면 샘플 영상은 학습 순서에서 자동으로 빠집니다.</p>
      )}
    </Card>
  );
}
