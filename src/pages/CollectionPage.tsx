import { Link } from 'react-router-dom';
import { repos } from '@/repositories';
import { useLiveData } from '@/hooks/useLiveData';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Icon } from '@/components/ui/Icon';
import { Loading } from '@/components/ui/Loading';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { LinkButton } from '@/components/ui/Button';
import { Toki, tokiProgress } from '@/components/brand/Toki';
import { formatDateKo } from '@/utils/date';

/** 컬렉션 — 정복한 대화문과 톡이의 성장 (읽기 전용 화면) */
export function CollectionPage() {
  const data = useLiveData(async () => {
    const [dialogues, progress, expressions] = await Promise.all([
      repos.dialogues.list(),
      repos.dialogueProgress.list(),
      repos.expressions.list(),
    ]);
    const memorized = progress.filter((p) => p.memorized);
    const byId = new Map(dialogues.map((d) => [d.id, d]));
    const items = memorized
      .map((p) => ({ dialogue: byId.get(p.dialogueId), progress: p }))
      .filter((x): x is { dialogue: NonNullable<typeof x.dialogue>; progress: typeof x.progress } => !!x.dialogue)
      .sort((a, b) => (b.progress.memorizedAt ?? '').localeCompare(a.progress.memorizedAt ?? ''));
    return { items, expressionCount: expressions.length };
  }, []);

  if (!data) return <Loading />;
  const toki = tokiProgress(data.items.length);

  return (
    <div className="space-y-5">
      <PageHeader title="컬렉션" description="끝까지 외운 대화문이 여기에 모여요. 한 번 모은 건 사라지지 않아요." />

      <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <Card className="flex flex-col items-center gap-3 p-6 text-center" data-testid="toki-card">
          <div className="grid h-44 w-full place-items-center rounded-[28px] bg-brand-soft/70">
            <Toki stage={toki.current.stage} size={140} label={toki.current.name} />
          </div>
          <p className="text-2xl font-extrabold">{toki.current.name}</p>
          <p className="text-[15px] text-muted">
            대화문 <b className="num text-ink">{data.items.length}</b>개를 함께 외웠어요.
            {toki.next && (
              <>
                <br />
                {toki.remaining}개 더 외우면 ‘{toki.next.name}’가 돼요.
              </>
            )}
          </p>
          {toki.next && (
            <div className="w-full">
              <ProgressBar value={toki.percent} label={`${toki.next.name}까지 진행률`} />
            </div>
          )}
          <div className="mt-1 grid w-full grid-cols-2 gap-2 text-left">
            <div className="rounded-2xl bg-key p-3">
              <p className="num text-xl font-extrabold text-key-ink">{data.expressionCount}</p>
              <p className="text-xs text-key-ink">모은 핵심 표현</p>
            </div>
            <div className="rounded-2xl bg-butter p-3">
              <p className="num text-xl font-extrabold text-butter-ink">{data.items.length}</p>
              <p className="text-xs text-butter-ink">정복한 대화문</p>
            </div>
          </div>
        </Card>

        <section aria-label="정복한 대화문" className="space-y-3">
          <h2 className="text-lg font-extrabold">내가 정복한 대화문</h2>
          {data.items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-3xl border-2 border-dashed border-line-strong p-8 text-center">
              <p className="font-bold">첫 대화문을 끝까지 외우면 여기에 담겨요</p>
              <p className="text-sm text-muted">한 단계씩만 해도 괜찮아요.</p>
              <LinkButton to="/" variant="soft" className="mt-2">
                오늘의 대화문 보기
              </LinkButton>
            </div>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2" data-testid="collection-list">
              {data.items.map(({ dialogue, progress }) => (
                <li key={dialogue.id}>
                  <Link to={`/dialogues/${dialogue.id}`} className="block h-full">
                    <Card className="flex h-full flex-col gap-2 p-5 transition-colors hover:border-line-strong">
                      <span className="grid size-12 place-items-center rounded-2xl bg-butter text-butter-ink">
                        <Icon name="award" className="size-6" />
                      </span>
                      <p className="text-[17px] font-extrabold">{dialogue.title}</p>
                      <p className="line-clamp-2 text-sm text-muted">{dialogue.situation}</p>
                      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                        <Badge tone={dialogue.kind === 'combined' ? 'info' : 'brand'}>{dialogue.kind === 'combined' ? '다시 만든 대화' : '영상 대화'}</Badge>
                        {progress.memorizedAt && <span className="text-xs text-subtle">정복 {formatDateKo(progress.memorizedAt)}</span>}
                      </div>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm text-muted">배지 모으기와 톡이 꾸미기는 다음 개발 단계에서 더해져요. 순위나 비교는 없어요.</p>
          <div className="flex flex-wrap gap-2">
            <LinkButton to="/favorites" variant="secondary" size="sm">
              <Icon name="star" className="size-4" />
              즐겨찾기
            </LinkButton>
            <LinkButton to="/expressions" variant="secondary" size="sm">
              <Icon name="book" className="size-4" />
              표현 노트
            </LinkButton>
          </div>
        </section>
      </div>
    </div>
  );
}
