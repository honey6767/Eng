import { Link } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { contentStore, repos } from '@/repositories';
import { dialogueReviewSchedule, reviewDateLabel, todaySentence } from '@/services/dialogueReview';
import { useLiveData } from '@/hooks/useLiveData';
import { loadDashboardStats, type DashboardStats } from '@/services/statsService';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { LinkButton } from '@/components/ui/Button';
import { StepBar } from '@/components/ui/ProgressBar';
import { Icon } from '@/components/ui/Icon';
import { Loading } from '@/components/ui/Loading';
import { Toki, tokiProgress } from '@/components/brand/Toki';
import { joinSegments } from '@/utils/text';
import { weekdayKo } from '@/utils/date';
import { STEP_NAMES } from '@/utils/labels';

/**
 * 홈 — "오늘은 이 대화문 하나만 해볼까?"
 * 화면 표시만 담당한다. 데이터는 기존 통계(loadDashboardStats)를 읽기만 하고 아무것도 저장하지 않는다.
 */

/** 같은 문구가 이어지지 않도록 날짜마다 바뀌고, 톡이를 누르면 다음 문구 */
const CHEERS = [
  '딱 한 단계만 해볼까?',
  '오늘도 조금씩 쌓이는 중!',
  '완벽하게 외우지 않아도 괜찮아.',
  '3분이면 충분해요.',
  '어제 못 했어도 괜찮아요. 오늘 하나면 돼요.',
  '틀려도 괜찮아요. 확인하면서 외우는 거예요.',
  '천천히 해도 기억은 쌓여요.',
];

function todayLabel(d = new Date()) {
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${'일월화수목금토'[d.getDay()]}요일`;
}

function dayIndex(d = new Date()) {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86400000);
}

export function DashboardPage() {
  const stats = useLiveData(() => loadDashboardStats(repos), []);
  const hasSample = useLiveData(() => repos.maintenance.hasSampleData(), []);
  const [cheerOffset, setCheerOffset] = useState(0);
  const cheer = useMemo(() => CHEERS[(dayIndex() + cheerOffset) % CHEERS.length], [cheerOffset]);

  if (!stats) return <Loading />;
  const toki = tokiProgress(stats.memorizedDialogues);

  return (
    <div className="space-y-5">
      <h1 className="sr-only">오늘의 학습</h1>
      <header className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => setCheerOffset((n) => n + 1)}
          className="shrink-0 rounded-2xl transition-transform active:scale-95"
          aria-label="톡이에게 다른 응원 듣기"
        >
          <Toki stage={toki.current.stage} size={64} />
        </button>
        <div className="min-w-0">
          <p className="text-[15px] text-muted">{todayLabel()}</p>
          <p className="text-2xl font-extrabold tracking-tight text-balance" data-testid="home-cheer" aria-live="polite">
            {cheer}
          </p>
        </div>
      </header>

      {hasSample && (
        <p className="flex items-start gap-2 rounded-2xl bg-info-soft px-4 py-3 text-sm text-info">
          <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
          <span>
            지금 보이는 대화문과 기록은 기능 확인용 <b>샘플 데이터</b>예요.{' '}
            <Link to="/settings" className="font-semibold underline underline-offset-2">
              설정
            </Link>
            에서 한 번에 지울 수 있어요.
          </span>
        </p>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <TodayDialogueCard stats={stats} />
        <div className="flex flex-col gap-5">
          <SmallGoalCard todayCount={stats.todayCount} />
          <TodayReviewCard />
        </div>
      </div>

      <GrowthCard stats={stats} />
    </div>
  );
}

// ─────────────────────────────────────────────

function TodayDialogueCard({ stats }: { stats: DashboardStats }) {
  const c = stats.continueDialogue;

  if (!c) {
    const hasVideos = stats.totalVideos > 0;
    return (
      <Card className="flex flex-col items-center gap-3 p-8 text-center shadow-[0_10px_30px_rgba(91,79,209,0.10)]" data-testid="today-dialogue">
        <Toki stage="egg" size={96} />
        <p className="text-xl font-extrabold">{hasVideos ? '대화문을 준비해 볼까요?' : '학습할 대화문이 없어요'}</p>
        <p className="max-w-sm text-[15px] text-muted">
          {hasVideos
            ? '영상의 학습 자료(핵심 Chunk · 통합 대화문)가 준비되면 여기에 오늘 외울 대화문이 나타나요.'
            : '영상을 등록하고 핵심 표현을 정리하면, 여기에 오늘 외울 대화문이 나타나요.'}
        </p>
        <LinkButton to="/videos" size="lg" className="mt-2">
          콘텐츠 준비하기
        </LinkButton>
      </Card>
    );
  }

  const { dialogue, progress } = c;
  const done = progress?.highestCompletedStep ?? 0;
  const nextStep = progress?.currentStep ?? 1;
  const minutes = Math.max(2, Math.round(dialogue.lines.length * 0.6));
  const preview = dialogue.lines.slice(0, 2);

  return (
    <Card className="flex flex-col gap-5 p-6 shadow-[0_10px_30px_rgba(91,79,209,0.10)] sm:p-7 min-w-0 lg:self-start" data-testid="today-dialogue">
      <div className="flex items-center justify-between gap-3">
        <Badge tone="brand" className="px-3 py-1 text-sm">
          오늘의 대화문
        </Badge>
        <span className="inline-flex items-center gap-1.5 text-[15px] text-muted">
          <Icon name="clock" className="size-4" />약 {minutes}분
        </span>
      </div>

      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <h2 className="text-[30px] leading-tight font-extrabold tracking-tight text-balance">{dialogue.title}</h2>
          <p className="mt-2 line-clamp-2 text-base text-muted">{dialogue.situation}</p>
          {dialogue.expressionIds.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge tone="key">핵심 표현 {dialogue.expressionIds.length}</Badge>
            </div>
          )}
        </div>
        <div className="flex w-full min-w-0 shrink-0 flex-col gap-2 rounded-3xl bg-brand-soft/70 p-4 sm:w-56" aria-hidden="true">
          {preview.map((l, i) => (
            <span
              key={l.id}
              className={`en max-w-full truncate rounded-2xl px-3 py-2 text-[13px] font-semibold ${
                i % 2 === 0 ? 'self-start rounded-bl-md bg-surface' : 'self-end rounded-br-md bg-brand text-white'
              }`}
            >
              {joinSegments(l.segments)}
            </span>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <StepBar completed={done} current={nextStep} />
        <p className="text-[15px] text-muted" data-testid="today-step">
          {done > 0 ? (
            <>
              지난번 <b className="text-ink">{done}단계</b>까지 했어요 · 다음은 <b className="text-ink">{nextStep}단계 {STEP_NAMES[nextStep]}</b>
            </>
          ) : (
            <>
              처음이에요 · <b className="text-ink">1단계 {STEP_NAMES[1]}</b>부터 가볍게
            </>
          )}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <LinkButton to={`/dialogues/${dialogue.id}/memorize`} size="xl" className="w-full" data-testid="today-memorize">
          <Icon name="play" className="size-5" />
          {done > 0 ? `${nextStep}단계 이어서 외우기` : '5단계 암기 시작'}
        </LinkButton>
        <Link to={`/dialogues/${dialogue.id}`} className="text-center text-sm font-semibold text-brand">
          대화문 먼저 읽어 보기
        </Link>
      </div>
    </Card>
  );
}

function SmallGoalCard({ todayCount }: { todayCount: number }) {
  const done = todayCount > 0;
  return (
    <section aria-label="오늘의 작은 목표" className="flex items-center gap-4 rounded-3xl bg-butter-soft p-5" data-testid="small-goal">
      <svg width="72" height="72" viewBox="0 0 84 84" role="img" aria-label={done ? '오늘 목표 달성' : '오늘 목표: 한 번'}>
        <circle cx="42" cy="42" r="34" stroke="#f3e2a6" strokeWidth="10" fill="none" />
        {done && <circle cx="42" cy="42" r="34" stroke="#e0a92a" strokeWidth="10" fill="none" className="tok-pop" />}
        {done ? (
          <path d="M29 43l9 9 17-18" stroke="#6e5200" strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <text x="42" y="49" textAnchor="middle" fontSize="20" fontWeight="800" fill="#6e5200" className="num">
            1번
          </text>
        )}
      </svg>
      <div className="min-w-0">
        <p className="text-lg font-extrabold">{done ? '오늘 목표 달성!' : '오늘은 한 번만 해도 충분해!'}</p>
        <p className="mt-1 text-sm text-butter-ink">
          {done ? `오늘 ${todayCount}번 학습했어요. 더 해도, 여기서 쉬어도 좋아요.` : '못 채워도 괜찮아요. 내일 또 하면 되니까.'}
        </p>
      </div>
    </section>
  );
}

/** 누적 복습 — 오늘 복습할 대화문 (통합 대화문 전체 단위). 없으면 다음 복습 예정일 */
function TodayReviewCard() {
  const sched = useLiveData(async () => dialogueReviewSchedule(await contentStore.readReviewInput()), []);
  if (!sched) return null;
  const { due, upcoming } = sched;
  return (
    <Card className="flex flex-col gap-3 p-5" data-testid="today-review">
      <p className="text-lg font-extrabold">오늘의 복습</p>
      {due.length > 0 ? (
        <>
          <p className="text-[15px] font-semibold text-ink" data-testid="review-sentence">
            {todaySentence(due)}
          </p>
          <ul className="flex flex-col gap-2" aria-label="오늘 복습할 대화문">
            {due.map((x) => (
              <li key={x.dialogue.id}>
                <Link to={`/dialogues/${x.dialogue.id}/memorize`} className="flex items-center gap-3 rounded-2xl bg-info-soft/60 px-3.5 py-3 hover:bg-info-soft" data-testid="review-due">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface text-info">
                    <Icon name="review" className="size-4.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-bold">{x.label}</span>
                    <span className="block truncate text-xs text-muted">{x.dialogue.title}</span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-muted">
                    {x.reviewNo}번째 복습
                    {x.overdueDays > 0 && <span className="block font-semibold text-warn">{x.overdueDays}일 지남</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : upcoming.length > 0 ? (
        <p className="rounded-2xl bg-canvas px-4 py-3 text-sm text-muted" data-testid="review-next-date">
          오늘 복습할 대화문은 없어요. 다음 복습은 <b className="text-ink">{reviewDateLabel(upcoming[0].dueAt)}</b> · {upcoming.filter((x) => x.dueAt.slice(0, 10) === upcoming[0].dueAt.slice(0, 10)).map((x) => x.label).join(', ')}
        </p>
      ) : (
        <p className="rounded-2xl bg-canvas px-4 py-3 text-sm text-muted" data-testid="review-empty">
          아직 복습할 대화문이 없어요. 대화문을 5단계까지 외우면 1일 · 3일 · 7일 · 14일 · 30일 뒤 복습이 자동으로 잡혀요.
        </p>
      )}
      {upcoming.length > 0 && due.length > 0 && (
        <p className="text-xs text-subtle">
          그다음 복습: {reviewDateLabel(upcoming[0].dueAt)} · {upcoming[0].label}
        </p>
      )}
      <p className="text-sm text-muted">
        <Link to="/review" className="font-semibold text-brand">
          복습 일정 전체 보기
        </Link>
      </p>
    </Card>
  );
}

function GrowthCard({ stats }: { stats: DashboardStats }) {
  const max = Math.max(1, ...stats.weekly.map((d) => d.count));
  const items = [
    { label: '외운 대화문', value: stats.memorizedDialogues, unit: '개' },
    { label: '모은 핵심 표현', value: stats.totalExpressions, unit: '개' },
    { label: '이번 주 학습', value: stats.weekTotal, unit: '번' },
  ];
  return (
    <Card className="p-5 sm:p-6" data-testid="growth">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-extrabold">나의 성장 기록</h2>
        <Link to="/collection" className="text-sm font-bold text-brand">
          컬렉션 보기
        </Link>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,1.4fr)]">
        {items.map((it) => (
          <div key={it.label} className="rounded-2xl bg-canvas p-4">
            <p className="text-[13px] text-muted">{it.label}</p>
            <p className="num mt-1 text-[28px] leading-none font-extrabold">
              <span data-testid={`stat-${it.label}`}>{it.value.toLocaleString()}</span>
              <span className="ml-1 text-sm font-semibold text-muted">{it.unit}</span>
            </p>
          </div>
        ))}
        <div className="rounded-2xl bg-canvas p-4">
          <p className="text-[13px] text-muted">최근 7일 · 쉬는 날은 표시하지 않아요</p>
          <div
            className="mt-2 flex h-16 items-end gap-1.5"
            role="img"
            aria-label={`최근 7일 학습: ${stats.weekly.filter((d) => d.count > 0).map((d) => `${weekdayKo(d.date)} ${d.count}번`).join(', ') || '아직 없음'}`}
          >
            {stats.weekly.map((d, i) => (
              <div key={d.date} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                {d.count > 0 && (
                  <div
                    className={`w-full max-w-6 rounded-lg ${i === stats.weekly.length - 1 ? 'bg-brand' : 'bg-brand-tint'}`}
                    style={{ height: `${Math.max(14, (d.count / max) * 100)}%` }}
                  />
                )}
                <span className={`text-[10px] ${i === stats.weekly.length - 1 ? 'font-bold text-ink' : 'text-subtle'}`}>
                  {i === stats.weekly.length - 1 ? '오늘' : weekdayKo(d.date)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      {stats.weakExpressions > 0 && (
        <Link
          to="/expressions"
          className="mt-3 flex items-center gap-2 rounded-2xl bg-peach/60 px-4 py-3 text-sm font-semibold text-peach-ink hover:bg-peach"
          data-testid="weak-count"
        >
          <Icon name="sparkle" className="size-4" />
          다시 만나면 좋은 표현 {stats.weakExpressions}개 — 조금씩 내 것으로 만들어요
          <Icon name="chevronRight" className="ml-auto size-4" />
        </Link>
      )}
    </Card>
  );
}
