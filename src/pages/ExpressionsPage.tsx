import { useEffect, useState } from 'react';
import { repos } from '@/repositories';
import { useLiveData } from '@/hooks/useLiveData';
import { useToast } from '@/hooks/useToast';
import { WEAK_THRESHOLD } from '@/services/statsService';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { FavoriteButton } from '@/components/ui/FavoriteButton';
import { Loading } from '@/components/ui/Loading';
import { EmptyState } from '@/components/ui/EmptyState';
import { relativeDayLabel } from '@/utils/date';
import { weaknessTone } from '@/utils/labels';

type Filter = 'all' | 'weak' | 'favorite';

export function ExpressionsPage() {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const data = useLiveData(async () => {
    const [expressions, states] = await Promise.all([repos.expressions.list(), repos.reviewStates.list('expression')]);
    const stateById = new Map(states.map((s) => [s.itemId, s]));
    return expressions.map((e) => ({ expr: e, state: stateById.get(e.id) }));
  }, []);

  if (!data) return <Loading />;
  const isWeak = (r: (typeof data)[number]) => r.expr.isMarkedDifficult || (r.state?.weakness ?? 0) >= WEAK_THRESHOLD;
  const q = query.trim().toLowerCase();
  const rows = data
    .filter((r) => (filter === 'weak' ? isWeak(r) : filter === 'favorite' ? r.expr.isFavorite : true))
    .filter((r) => !q || r.expr.text.toLowerCase().includes(q) || r.expr.meaningKo.includes(q))
    .sort((a, b) => (b.state?.weakness ?? 0) - (a.state?.weakness ?? 0));

  return (
    <div>
      <PageHeader title="표현 노트" description="여러 영상에서 배운 표현을 중복 없이 하나로 모아 학습 이력을 누적합니다." />

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex gap-1.5" role="tablist">
          {(
            [
              ['all', '전체', data.length],
              ['weak', '취약', data.filter(isWeak).length],
              ['favorite', '즐겨찾기', data.filter((r) => r.expr.isFavorite).length],
            ] as const
          ).map(([k, label, n]) => (
            <button
              key={k}
              role="tab"
              aria-selected={filter === k}
              onClick={() => setFilter(k)}
              className={`h-9 rounded-full px-3.5 text-sm font-semibold transition-colors ${
                filter === k ? 'bg-ink text-white' : 'border border-line bg-surface text-muted hover:text-ink'
              }`}
            >
              {label} <span className="opacity-70">{n}</span>
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="표현 또는 뜻 검색"
          aria-label="표현 검색"
          className="h-10 rounded-xl border border-line bg-surface px-3 text-[15px] outline-none focus:border-brand sm:ml-auto sm:w-60"
        />
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState title="해당하는 표현이 없어요" />
        </Card>
      ) : (
        <ul className="grid gap-2.5 md:grid-cols-2">
          {rows.map(({ expr, state }) => (
            <li key={expr.id}>
              <Card className="h-full p-4">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="en text-[17px] font-bold">{expr.text}</p>
                    <p className="text-sm text-muted">{expr.meaningKo}</p>
                  </div>
                  <FavoriteButton
                    active={expr.isFavorite}
                    label={expr.text}
                    onToggle={async () => {
                      await repos.expressions.setFavorite(expr.id, !expr.isFavorite);
                      toast(expr.isFavorite ? '즐겨찾기에서 해제했어요' : '즐겨찾기에 추가했어요');
                    }}
                  />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  {state ? (
                    <>
                      <Badge tone={weaknessTone(state.weakness)}>취약도 {state.weakness}</Badge>
                      <span>
                        정답 {state.correctCount} · 오답 {state.wrongCount} · 연속 {state.streak}
                      </span>
                      <span>· 다음 복습 {relativeDayLabel(state.nextReviewAt)}</span>
                    </>
                  ) : (
                    <Badge>학습 기록 없음</Badge>
                  )}
                  <span>· 출처 영상 {new Set(expr.sourceRefs.map((r) => r.videoId)).size}개</span>
                </div>
                <DifficultToggle
                  checked={expr.isMarkedDifficult}
                  onChange={async (checked) => {
                    await repos.expressions.setMarkedDifficult(expr.id, checked);
                    toast(checked ? '어려운 표현으로 표시했어요' : '어려운 표현 표시를 해제했어요');
                  }}
                />
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 저장 완료 전에도 즉시 반영되는(낙관적 업데이트) 체크박스. 저장 실패 시 원래 값으로 되돌린다. */
function DifficultToggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => Promise<void> }) {
  const [local, setLocal] = useState(checked);
  useEffect(() => setLocal(checked), [checked]);
  return (
    <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-sm text-muted select-none">
      <input
        type="checkbox"
        checked={local}
        onChange={async (e) => {
          const next = e.target.checked;
          setLocal(next);
          try {
            await onChange(next);
          } catch {
            setLocal(!next);
          }
        }}
        className="size-4 accent-[var(--color-danger)]"
      />
      어렵다고 표시
    </label>
  );
}
