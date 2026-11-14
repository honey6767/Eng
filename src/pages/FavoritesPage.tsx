import { Link } from 'react-router-dom';
import { repos } from '@/repositories';
import { useLiveData } from '@/hooks/useLiveData';
import { useToast } from '@/hooks/useToast';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, SectionTitle } from '@/components/ui/Card';
import { FavoriteButton } from '@/components/ui/FavoriteButton';
import { PlannedNotice } from '@/components/ui/PlannedNotice';
import { Loading } from '@/components/ui/Loading';
import { EmptyState } from '@/components/ui/EmptyState';

export function FavoritesPage() {
  const toast = useToast();
  const data = useLiveData(async () => {
    const [expressions, dialogues] = await Promise.all([repos.expressions.list(), repos.dialogues.list()]);
    return { expressions: expressions.filter((e) => e.isFavorite), dialogues: dialogues.filter((d) => d.isFavorite) };
  }, []);
  if (!data) return <Loading />;

  return (
    <div className="space-y-6">
      <PageHeader title="즐겨찾기" description="별표한 표현과 대화문을 모아 봅니다." />
      <PlannedNotice title="즐겨찾기 항목만 모아 학습 · 랜덤 테스트 포함" stage="8단계" />

      <section>
        <SectionTitle>대화문 {data.dialogues.length}</SectionTitle>
        {data.dialogues.length === 0 ? (
          <Card>
            <EmptyState icon="star" title="즐겨찾기한 대화문이 없어요">
              대화문 화면에서 ☆를 눌러 추가하세요.
            </EmptyState>
          </Card>
        ) : (
          <Card className="divide-y divide-line">
            {data.dialogues.map((d) => (
              <div key={d.id} className="flex items-center gap-2 px-4 py-3">
                <Link to={`/dialogues/${d.id}`} className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{d.title}</p>
                  <p className="truncate text-sm text-muted">{d.situation}</p>
                </Link>
                <FavoriteButton
                  active
                  label={d.title}
                  onToggle={async () => {
                    await repos.dialogues.setFavorite(d.id, false);
                    toast('즐겨찾기에서 해제했어요');
                  }}
                />
              </div>
            ))}
          </Card>
        )}
      </section>

      <section>
        <SectionTitle>표현 {data.expressions.length}</SectionTitle>
        {data.expressions.length === 0 ? (
          <Card>
            <EmptyState icon="star" title="즐겨찾기한 표현이 없어요">
              표현 노트에서 ☆를 눌러 추가하세요.
            </EmptyState>
          </Card>
        ) : (
          <Card className="divide-y divide-line">
            {data.expressions.map((e) => (
              <div key={e.id} className="flex items-center gap-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="en truncate font-semibold">{e.text}</p>
                  <p className="truncate text-sm text-muted">{e.meaningKo}</p>
                </div>
                <FavoriteButton
                  active
                  label={e.text}
                  onToggle={async () => {
                    await repos.expressions.setFavorite(e.id, false);
                    toast('즐겨찾기에서 해제했어요');
                  }}
                />
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}
