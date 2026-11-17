import { Link } from 'react-router-dom';
import { contentStore } from '@/repositories';
import { useLiveData } from '@/hooks/useLiveData';
import { dialogueReviewSchedule, reviewDateLabel, todaySentence, type DialogueReviewItem } from '@/services/dialogueReview';
import { RECOMMENDED_INTERVAL_DAYS } from '@/services/scheduler';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, SectionTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Loading } from '@/components/ui/Loading';
import { Icon } from '@/components/ui/Icon';

/**
 * 누적 복습 — 통합 대화문 전체를 단위로, 암기를 마친 날부터 1·3·7·14·30일 뒤 복습한다.
 * 이 화면은 저장된 일정을 보여 주기만 한다 (평가·기록은 대화문 암기 화면에서).
 */
export function ReviewPage() {
  const sched = useLiveData(async () => dialogueReviewSchedule(await contentStore.readReviewInput()), []);
  if (!sched) return <Loading />;
  const { due, upcoming } = sched;

  return (
    <div className="space-y-6" data-testid="review-page">
      <PageHeader title="복습" description="외운 대화문을 잊지 않도록, 암기를 마친 날부터 정해진 간격으로 다시 외워요." />

      <section>
        <SectionTitle action={<span className="text-sm text-muted">{due.length}개</span>}>오늘 복습할 대화문</SectionTitle>
        {due.length === 0 ? (
          <Card className="p-4 text-sm text-muted">
            {upcoming.length ? (
              <>
                오늘 복습할 대화문은 없어요. 다음 복습: <b className="text-ink">{reviewDateLabel(upcoming[0].dueAt)}</b> · {upcoming[0].label}
              </>
            ) : (
              '아직 복습할 대화문이 없어요. 대화문을 5단계까지 외우면 복습 일정이 자동으로 잡혀요.'
            )}
          </Card>
        ) : (
          <>
            <p className="mb-2 font-semibold">{todaySentence(due)}</p>
            <Card className="divide-y divide-line">
              {due.map((x) => (
                <ReviewRow key={x.dialogue.id} x={x} />
              ))}
            </Card>
          </>
        )}
      </section>

      {upcoming.length > 0 && (
        <section>
          <SectionTitle action={<span className="text-sm text-muted">{upcoming.length}개</span>}>다가오는 복습 일정</SectionTitle>
          <Card className="divide-y divide-line" data-testid="review-upcoming">
            {upcoming.slice(0, 30).map((x) => (
              <ReviewRow key={x.dialogue.id} x={x} upcoming />
            ))}
          </Card>
        </section>
      )}

      <section>
        <SectionTitle>복습 간격 규칙</SectionTitle>
        <Card className="p-4 text-sm text-muted">
          <div className="flex flex-wrap items-center gap-1.5">
            {RECOMMENDED_INTERVAL_DAYS.map((d, i) => (
              <span key={d} className="flex items-center gap-1.5">
                <span className="rounded-lg bg-canvas px-2.5 py-1 font-semibold text-ink ring-1 ring-line">{d === 0 ? '암기 완료' : `${d}일 후`}</span>
                {i < RECOMMENDED_INTERVAL_DAYS.length - 1 && <Icon name="chevronRight" className="size-3.5 text-subtle" />}
              </span>
            ))}
          </div>
          <ul className="mt-3 list-disc space-y-1 pl-5">
            <li>
              복습 단위는 <b className="text-ink">통합 대화문 전체</b>예요. 대화문 암기 화면의 5단계 ‘보지 않고 말하기’로 떠올려 본 뒤 평가해요.
            </li>
            <li>
              <b className="text-ink">잘 기억했어요</b> → 다음 간격으로 (30일 뒤부터는 최대 180일까지 늘어나요)
            </li>
            <li>
              <b className="text-ink">헷갈렸어요</b> → 간격을 줄여 조금 일찍 다시 복습
            </li>
            <li>
              <b className="text-ink">다시 외워야 해요</b> → 처음 간격부터, 오늘 한 번 더 복습
            </li>
          </ul>
        </Card>
      </section>
    </div>
  );
}

function ReviewRow({ x, upcoming = false }: { x: DialogueReviewItem; upcoming?: boolean }) {
  return (
    <Link to={`/dialogues/${x.dialogue.id}/memorize`} className="flex items-center gap-3 px-4 py-3 hover:bg-canvas" data-testid={upcoming ? 'review-upcoming-row' : 'review-due-row'}>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{x.label}</p>
        <p className="truncate text-xs text-muted">{x.dialogue.title}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Badge tone={upcoming ? 'neutral' : 'brand'}>{x.reviewNo}번째 복습</Badge>
        <span className="text-[11px] text-subtle">{upcoming ? reviewDateLabel(x.dueAt) : x.overdueDays > 0 ? `${x.overdueDays}일 지남` : '오늘'}</span>
      </div>
    </Link>
  );
}
