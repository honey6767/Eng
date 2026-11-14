import { Link } from 'react-router-dom';
import { useState } from 'react';
import { repos } from '@/repositories';
import { useLiveData } from '@/hooks/useLiveData';
import { loadDashboardStats, type DashboardStats } from '@/services/statsService';
import { PRIORITY_LABEL_KO, type ReviewPriority } from '@/services/scheduler';
import { Card, SectionTitle } from '@/components/ui/Card';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { LinkButton } from '@/components/ui/Button';
import { PlannedButton } from '@/components/ui/PlannedNotice';
import { ProgressBar, StepDots } from '@/components/ui/ProgressBar';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Loading } from '@/components/ui/Loading';
import { EmptyState } from '@/components/ui/EmptyState';
import { relativeDayLabel, weekdayKo } from '@/utils/date';
import { STEP_NAMES } from '@/utils/labels';

const PRIORITY_TONE: Record<ReviewPriority, BadgeTone> = {
  1: 'danger',
  2: 'danger',
  3: 'warn',
  4: 'info',
  5: 'neutral',
};

function todayLabel() {
  const d = new Date();
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${'일월화수목금토'[d.getDay()]}요일`;
}

export function DashboardPage() {
  const stats = useLiveData(() => loadDashboardStats(repos), []);
  const hasSample = useLiveData(() => repos.maintenance.hasSampleData(), []);

  if (!stats) return <Loading />;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-muted">{todayLabel()}</p>
        <h1 className="mt-0.5 text-2xl font-extrabold tracking-tight">오늘의 학습</h1>
      </div>

      {hasSample && (
        <div className="flex items-start gap-2.5 rounded-xl border border-info/20 bg-info-soft px-3.5 py-3 text-sm text-info">
          <Icon name="alert" className="mt-0.5 size-4.5 shrink-0" />
          <p>
            지금 보이는 영상·대화문·학습 기록은 기능 확인용 <b>샘플 데이터</b>입니다. 실제 재생목록 영상이 아니며{' '}
            <Link to="/settings" className="font-semibold underline underline-offset-2">
              설정
            </Link>
            에서 한 번에 삭제할 수 있어요.
          </p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-5">
        <TodayReviewCard stats={stats} />
        <ContinueCard stats={stats} />
      </div>

      <section aria-labelledby="overview-title">
        <h2 id="overview-title" className="sr-only">
          학습 현황
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard icon="video" label="학습 영상" value={stats.totalVideos} sub={`완료 ${stats.completedVideos} · 학습 중 ${stats.inProgressVideos}`} to="/videos" />
          <StatCard icon="chat" label="학습한 대화문" value={stats.studiedDialogues} sub={`암기 완료 ${stats.memorizedDialogues} / 전체 ${stats.totalDialogues}`} to="/dialogues" />
          <StatCard icon="book" label="누적 핵심 표현" value={stats.totalExpressions} sub={`취약 표현 ${stats.weakExpressions}개`} to="/expressions" highlight={stats.weakExpressions > 0} />
          <StatCard icon="review" label="누적 복습" value={stats.totalReviews} sub="회" />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <WeeklyCard stats={stats} />
        <ProgressCard stats={stats} />
      </div>
    </div>
  );
}

function TodayReviewCard({ stats }: { stats: DashboardStats }) {
  const [expanded, setExpanded] = useState(false);
  const items = expanded ? stats.dueItems : stats.dueItems.slice(0, 4);
  return (
    <Card className="p-5 lg:col-span-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-muted">오늘 복습할 항목</p>
          <p className="mt-1 text-3xl font-extrabold tracking-tight">
            {stats.dueItems.length}
            <span className="ml-1 text-base font-semibold text-muted">개</span>
          </p>
        </div>
        <div className="grid size-11 place-items-center rounded-2xl bg-brand-soft text-brand">
          <Icon name="review" className="size-6" />
        </div>
      </div>

      {stats.dueItems.length === 0 ? (
        <p className="mt-4 rounded-xl bg-canvas px-4 py-3 text-sm text-muted">오늘 예정된 복습이 없어요.</p>
      ) : (
        <>
          <ul className="mt-4 divide-y divide-line" aria-label="우선순위 순 복습 목록">
            {items.map((item) => (
              <li key={item.state.id}>
                <Link to={item.href ?? '#'} className="flex items-center gap-3 py-2.5 hover:opacity-80">
                  <Badge tone={PRIORITY_TONE[item.priority]}>{PRIORITY_LABEL_KO[item.priority]}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="en truncate font-semibold">{item.title}</p>
                    <p className="truncate text-xs text-muted">{item.subtitle}</p>
                  </div>
                  <span className="shrink-0 text-xs text-subtle">{relativeDayLabel(item.state.nextReviewAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
          {stats.dueItems.length > 4 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-sm font-semibold text-brand"
            >
              {expanded ? '접기' : `${stats.dueItems.length - 4}개 더 보기`}
            </button>
          )}
        </>
      )}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <PlannedButton label="복습 시작" stage="6단계" className="w-full sm:w-auto" />
        <LinkButton to="/review" variant="secondary" className="w-full sm:w-auto">
          복습 목록 보기
        </LinkButton>
      </div>
    </Card>
  );
}

function ContinueCard({ stats }: { stats: DashboardStats }) {
  const c = stats.continueDialogue;
  return (
    <Card className="flex flex-col p-5 lg:col-span-2">
      <p className="text-sm font-semibold text-muted">이어서 학습할 대화문</p>
      {c ? (
        <>
          <p className="mt-2 text-lg leading-snug font-bold">{c.dialogue.title}</p>
          <p className="mt-1 line-clamp-2 text-sm text-muted">{c.dialogue.situation}</p>
          <div className="mt-4 space-y-1.5">
            <StepDots completed={c.progress?.highestCompletedStep ?? 0} current={c.progress?.currentStep ?? 1} />
            <p className="text-xs text-muted">
              {c.progress && c.progress.highestCompletedStep > 0
                ? `STEP ${c.progress.highestCompletedStep} 완료 · 다음: STEP ${c.progress.currentStep} ${STEP_NAMES[c.progress.currentStep]}`
                : '아직 시작하지 않았어요'}
            </p>
          </div>
          <div className="mt-auto flex flex-col gap-2 pt-5">
            <LinkButton to={`/dialogues/${c.dialogue.id}`}>
              대화문 보기
              <Icon name="chevronRight" className="size-4" />
            </LinkButton>
            <PlannedButton label="5단계 암기" stage="5단계" />
          </div>
        </>
      ) : (
        <EmptyState icon="chat" title="학습할 대화문이 없어요">
          영상을 등록하고 대화문을 만들면 여기에 표시됩니다.
        </EmptyState>
      )}
    </Card>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  to,
  highlight,
}: {
  icon: IconName;
  label: string;
  value: number;
  sub: string;
  to?: string;
  highlight?: boolean;
}) {
  const body = (
    <Card className={`h-full p-4 ${to ? 'transition-colors hover:border-line-strong' : ''}`}>
      <div className="flex items-center gap-1.5 text-muted">
        <Icon name={icon} className="size-4" />
        <span className="text-[13px] font-semibold">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-extrabold tracking-tight" data-testid={`stat-${label}`}>
        {value.toLocaleString()}
      </p>
      <p className={`mt-0.5 text-xs ${highlight ? 'font-semibold text-warn' : 'text-subtle'}`}>{sub}</p>
    </Card>
  );
  return to ? (
    <Link to={to} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

function WeeklyCard({ stats }: { stats: DashboardStats }) {
  const max = Math.max(1, ...stats.weekly.map((d) => d.count));
  return (
    <Card className="p-5">
      <SectionTitle>학습량</SectionTitle>
      <div className="flex gap-6">
        <div>
          <p className="text-xs font-semibold text-muted">오늘</p>
          <p className="text-2xl font-extrabold">
            {stats.todayCount}
            <span className="ml-0.5 text-sm font-semibold text-muted">회</span>
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold text-muted">최근 7일</p>
          <p className="text-2xl font-extrabold">
            {stats.weekTotal}
            <span className="ml-0.5 text-sm font-semibold text-muted">회</span>
          </p>
        </div>
      </div>
      <div className="mt-5 flex h-32 items-end gap-2" role="img" aria-label={`최근 7일 학습 횟수: ${stats.weekly.map((d) => `${weekdayKo(d.date)} ${d.count}회`).join(', ')}`}>
        {stats.weekly.map((d, i) => {
          const isToday = i === stats.weekly.length - 1;
          const h = d.count === 0 ? 0 : Math.max(6, (d.count / max) * 100);
          return (
            <div key={d.date} className="group relative flex h-full flex-1 flex-col items-center justify-end gap-1.5" title={`${d.date} · ${d.count}회`}>
              <span className="text-[11px] font-semibold text-muted">{d.count > 0 ? d.count : ''}</span>
              <div className="flex w-full max-w-8 flex-1 items-end">
                <div
                  className={`w-full rounded-t-[4px] transition-opacity group-hover:opacity-80 ${isToday ? 'bg-brand' : 'bg-brand/45'}`}
                  style={{ height: `${h}%` }}
                />
              </div>
              <span className={`text-[11px] ${isToday ? 'font-bold text-ink' : 'text-subtle'}`}>
                {isToday ? '오늘' : weekdayKo(d.date)}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

const RETENTION_SEGMENTS = [
  { key: 'longTerm', label: '장기 (14일+)', color: '#244a40' },
  { key: 'midTerm', label: '중기 (3~7일)', color: '#4f8676' },
  { key: 'shortTerm', label: '단기 (직후~1일)', color: '#9cc2b6' },
  { key: 'notStarted', label: '복습 전', color: '#e2e6e3' },
] as const;

function ProgressCard({ stats }: { stats: DashboardStats }) {
  const r = stats.retention;
  const total = r.longTerm + r.midTerm + r.shortTerm + r.notStarted;
  return (
    <Card className="p-5">
      <SectionTitle>전체 진도</SectionTitle>
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 flex justify-between text-sm">
            <span className="font-semibold">영상 학습 완료</span>
            <span className="text-muted">
              {stats.completedVideos}/{stats.totalVideos} · <b className="text-ink">{stats.videoProgress}%</b>
            </span>
          </div>
          <ProgressBar value={stats.videoProgress} label="영상 학습 완료율" />
        </div>
        <div>
          <div className="mb-1.5 flex justify-between text-sm">
            <span className="font-semibold">대화문 5단계 진행</span>
            <span className="text-muted">
              <b className="text-ink">{stats.stepProgress}%</b>
            </span>
          </div>
          <ProgressBar value={stats.stepProgress} label="대화문 5단계 진행률" />
        </div>
      </div>

      <h3 className="mt-6 text-sm font-semibold">장기 기억 유지 현황</h3>
      <p className="text-xs text-subtle">표현과 대화문의 복습 간격 단계 분포</p>
      {total === 0 ? (
        <p className="mt-3 text-sm text-muted">아직 복습 대상이 없어요.</p>
      ) : (
        <>
          <div className="mt-3 flex h-3 gap-[2px] overflow-hidden rounded-full" role="img" aria-label="장기 기억 유지 분포">
            {RETENTION_SEGMENTS.map((s) =>
              r[s.key] > 0 ? (
                <div key={s.key} title={`${s.label}: ${r[s.key]}개`} style={{ flex: r[s.key], background: s.color }} />
              ) : null,
            )}
          </div>
          <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px]">
            {RETENTION_SEGMENTS.map((s) => (
              <li key={s.key} className="flex items-center gap-2">
                <span className="size-2.5 shrink-0 rounded-sm" style={{ background: s.color }} />
                <span className="text-muted">{s.label}</span>
                <span className="ml-auto font-semibold">{r[s.key]}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
