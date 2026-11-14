import { Link } from 'react-router-dom';
import { repos } from '@/repositories';
import { useLiveData } from '@/hooks/useLiveData';
import { loadDashboardStats } from '@/services/statsService';
import { PRIORITY_LABEL_KO, RECOMMENDED_INTERVAL_DAYS } from '@/services/scheduler';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, SectionTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { PlannedButton } from '@/components/ui/PlannedNotice';
import { Loading } from '@/components/ui/Loading';
import { Icon, type IconName } from '@/components/ui/Icon';
import { relativeDayLabel } from '@/utils/date';
import { weaknessTone } from '@/utils/labels';

const MODES: { key: string; icon: IconName; title: string; desc: string; stage: string }[] = [
  { key: 'A', icon: 'chat', title: '기존 대화문 복습', desc: '이전에 외운 원본 대화문을 5단계로 다시 외우고, 어려웠던 부분을 집중 연습합니다.', stage: '6단계' },
  { key: 'B', icon: 'flame', title: '취약 표현 집중 복습', desc: '여러 영상에서 누적된 어려운 표현만 모아 뜻 떠올리기 · 영어 떠올리기 · 빈칸으로 연습합니다.', stage: '6단계' },
  { key: 'C', icon: 'sparkle', title: '새로운 조합 대화문 복습', desc: '어려웠던 표현들을 모아 만든 새 대화문을 5단계로 외웁니다. (AI 연동 필요)', stage: '7단계' },
];

export function ReviewPage() {
  const stats = useLiveData(() => loadDashboardStats(repos), []);
  if (!stats) return <Loading />;

  return (
    <div className="space-y-6">
      <PageHeader title="복습" description="에빙하우스 망각 곡선을 기반으로 학습 결과에 따라 복습 간격을 조정합니다." />

      <section>
        <SectionTitle>복습 방식</SectionTitle>
        <div className="grid gap-3 md:grid-cols-3">
          {MODES.map((m) => (
            <Card key={m.key} className="flex flex-col p-4">
              <div className="flex items-center gap-2">
                <span className="grid size-9 place-items-center rounded-xl bg-brand-soft text-brand">
                  <Icon name={m.icon} className="size-5" />
                </span>
                <p className="font-bold">
                  <span className="text-subtle">{m.key}.</span> {m.title}
                </p>
              </div>
              <p className="mt-2 flex-1 text-sm text-muted">{m.desc}</p>
              <PlannedButton label="시작" stage={m.stage} className="mt-4 w-full" />
            </Card>
          ))}
        </div>
      </section>

      <section>
        <SectionTitle action={<span className="text-sm text-muted">{stats.dueItems.length}개</span>}>
          오늘 복습할 항목 (우선순위 순)
        </SectionTitle>
        <Card className="divide-y divide-line">
          {stats.dueItems.length === 0 && <p className="p-4 text-sm text-muted">오늘 예정된 복습이 없어요.</p>}
          {stats.dueItems.map((item, i) => (
            <Link key={item.state.id} to={item.href ?? '#'} className="flex items-center gap-3 px-4 py-3 hover:bg-canvas">
              <span className="w-5 text-center text-sm font-bold text-subtle">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="en truncate font-semibold">{item.title}</p>
                <p className="truncate text-xs text-muted">
                  {item.subtitle} · 정답 {item.state.correctCount} · 오답 {item.state.wrongCount} · 연속 정답 {item.state.streak}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Badge tone={item.priority <= 2 ? 'danger' : item.priority === 3 ? 'warn' : 'info'}>
                  {PRIORITY_LABEL_KO[item.priority]}
                </Badge>
                <span className="text-[11px] text-subtle">{relativeDayLabel(item.state.nextReviewAt)}</span>
              </div>
              <Badge tone={weaknessTone(item.state.weakness)} className="hidden sm:inline-flex">
                취약도 {item.state.weakness}
              </Badge>
            </Link>
          ))}
        </Card>
      </section>

      <section>
        <SectionTitle>복습 간격 규칙</SectionTitle>
        <Card className="p-4 text-sm text-muted">
          <div className="flex flex-wrap items-center gap-1.5">
            {RECOMMENDED_INTERVAL_DAYS.map((d, i) => (
              <span key={d} className="flex items-center gap-1.5">
                <span className="rounded-lg bg-canvas px-2.5 py-1 font-semibold text-ink ring-1 ring-line">
                  {d === 0 ? '학습 직후' : `${d}일 후`}
                </span>
                {i < RECOMMENDED_INTERVAL_DAYS.length - 1 && <Icon name="chevronRight" className="size-3.5 text-subtle" />}
              </span>
            ))}
          </div>
          <ul className="mt-3 list-disc space-y-1 pl-5">
            <li>
              <b className="text-ink">틀렸어요</b> → 처음 단계로 돌아가 10분 뒤 다시 복습, 취약도 크게 증가
            </li>
            <li>
              <b className="text-ink">겨우 기억했어요</b> → 단계를 유지하고 간격을 줄여 재복습
            </li>
            <li>
              <b className="text-ink">확실히 외웠어요</b> → 다음 간격으로 진행, 30일 이후에는 연속 정답에 따라 최대 180일까지 확장
            </li>
          </ul>
          <p className="mt-3 text-xs text-subtle">평가 버튼과 실제 일정 반영은 5·6단계 학습 화면에서 연결됩니다.</p>
        </Card>
      </section>
    </div>
  );
}
