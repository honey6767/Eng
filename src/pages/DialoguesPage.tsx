import { Link } from 'react-router-dom';
import { useState } from 'react';
import { repos } from '@/repositories';
import { useLiveData } from '@/hooks/useLiveData';
import { useToast } from '@/hooks/useToast';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { StepDots } from '@/components/ui/ProgressBar';
import { FavoriteButton } from '@/components/ui/FavoriteButton';
import { LinkButton } from '@/components/ui/Button';
import { Loading } from '@/components/ui/Loading';
import { EmptyState } from '@/components/ui/EmptyState';
import type { DialogueKind } from '@/types/models';

export function DialoguesPage() {
  const [kind, setKind] = useState<DialogueKind>('original');
  const toast = useToast();
  const data = useLiveData(async () => {
    const [dialogues, progress, videos] = await Promise.all([
      repos.dialogues.list(),
      repos.dialogueProgress.list(),
      repos.videos.list(),
    ]);
    return { dialogues, progress, videos };
  }, []);

  if (!data) return <Loading />;
  const progressById = new Map(data.progress.map((p) => [p.dialogueId, p]));
  const videoById = new Map(data.videos.map((v) => [v.id, v]));
  const rows = data.dialogues.filter((d) => d.kind === kind);

  return (
    <div>
      <PageHeader title="외우기" description="대화문 하나를 통째로 외워요. 한 단계씩만 해도 충분해요." />

      <div className="mb-4 flex gap-1.5" role="tablist" aria-label="대화문 종류">
        {(
          [
            ['original', 'Day 대화문'],
            ['combined', '여러 Day 조합'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={kind === k}
            onClick={() => setKind(k)}
            className={`h-9 rounded-full px-3.5 text-sm font-semibold transition-colors ${
              kind === k ? 'bg-ink text-white' : 'border border-line bg-surface text-muted hover:text-ink'
            }`}
          >
            {label} <span className="opacity-70">{data.dialogues.filter((d) => d.kind === k).length}</span>
          </button>
        ))}
      </div>

      {kind === 'combined' && (
        <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 p-4" data-testid="combine-cta">
          <div className="min-w-0">
            <p className="font-bold">여러 Day의 Chunk로 통합 대화문 만들기</p>
            <p className="text-sm text-muted">최근 학습한 Day 2~3개의 Chunk를 한 상황의 자연스러운 대화로 엮어요.</p>
          </div>
          <LinkButton to="/dialogues/combine" size="sm">
            만들기
          </LinkButton>
        </Card>
      )}

      {rows.length === 0 ? (
        <Card>
          <EmptyState icon="chat" title="대화문이 없어요" />
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {rows.map((d) => {
            const p = progressById.get(d.id);
            const video = d.videoId ? videoById.get(d.videoId) : undefined;
            const keyCount = d.lines.flatMap((l) => l.segments).filter((s) => s.kind === 'key').length;
            return (
              <li key={d.id} className="min-w-0">
                <Link to={`/dialogues/${d.id}`} className="block h-full">
                  <Card className="flex h-full flex-col p-4 transition-colors hover:border-line-strong">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap gap-1">
                          {p?.memorized ? (
                            <Badge tone="ok">암기 완료</Badge>
                          ) : p && p.highestCompletedStep > 0 ? (
                            <Badge tone="warn">학습 중</Badge>
                          ) : (
                            <Badge>시작 전</Badge>
                          )}
                          {d.isSample && <Badge>샘플</Badge>}
                        </div>
                        <p className="mt-1.5 font-bold">{d.title}</p>
                      </div>
                      <FavoriteButton
                        active={d.isFavorite}
                        label={d.title}
                        onToggle={async () => {
                          await repos.dialogues.setFavorite(d.id, !d.isFavorite);
                          toast(d.isFavorite ? '즐겨찾기에서 해제했어요' : '즐겨찾기에 추가했어요');
                        }}
                      />
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-muted">{d.situation}</p>
                    <div className="mt-auto flex items-center justify-between gap-3 pt-3">
                      <span className="shrink-0">
                        <StepDots completed={p?.highestCompletedStep ?? 0} current={p?.currentStep} />
                      </span>
                      <span className="min-w-0 truncate text-xs text-subtle">
                        {d.lines.length}줄 · {d.kind === 'combined' ? 'Chunk' : '핵심'} {keyCount}
                        {d.sourceDays?.length ? ` · Day ${d.sourceDays.join(', ')}` : ''}
                        {video && ` · ${video.title.replace('[샘플] ', '')}`}
                      </span>
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
