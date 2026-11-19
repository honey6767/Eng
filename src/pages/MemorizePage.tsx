import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { contentStore, repos } from '@/repositories';
import { useLiveData } from '@/hooks/useLiveData';
import { useToast } from '@/hooks/useToast';
import { blankIndexes, blankPlanOf, DEFAULT_BLANK_LEVELS, normalizedRanks, tokensOf } from '@/services/prep/blanks';
import type { DialogueProgress, MemorizeStep, Rating, ReviewState, StudyLog } from '@/types/models';
import { dayLabelOf, isReviewDue, memorizedDate, recordReview, REVIEW_RATING_LABEL, reviewDateLabel, scheduleAfterMemorized, virtualState } from '@/services/dialogueReview';
import { intervalDaysForIndex } from '@/services/scheduler';
import { createId } from '@/utils/id';
import { toDateKey } from '@/utils/date';
import { STEP_NAMES } from '@/utils/labels';
import { wordsOf } from '@/utils/chunkMatch';
import { useUseful } from '@/components/dialogue/UsefulPanel';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Loading } from '@/components/ui/Loading';
import { NotFoundPage } from './NotFoundPage';

/**
 * 5단계 대화문 암기 — 저장된 대화문과 빈칸 자료만 쓴다 (Gemini 호출 없음)
 * 1 전체 대화문 → 2 핵심 Chunk 빈칸 → 3 주요 단어 빈칸 → 4 대부분 빈칸 → 5 보지 않고 말하기
 * 빈칸 양(3·4단계)은 사용자가 조절하고, 진도·조절값은 이 기기에 저장한다.
 */

const STEPS: MemorizeStep[] = [1, 2, 3, 4, 5];
const ACCURACY: Record<Rating, number> = { easy: 1, hard: 0.6, wrong: 0.2 };

export function MemorizePage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const data = useLiveData(async () => {
    const study = await contentStore.readDialogueStudy(id);
    return study ? { ...study, review: (await repos.reviewStates.get('dialogue', id)) ?? null } : study;
  }, [id]);
  const [step, setStep] = useState<MemorizeStep | null>(null);
  const [levels, setLevels] = useState<Record<3 | 4, number>>(DEFAULT_BLANK_LEVELS);
  const [firstLetter, setFirstLetter] = useState(true);
  const [korean, setKorean] = useState(true);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [revealAll, setRevealAll] = useState(false);

  // 저장된 진도·빈칸 양으로 시작
  useEffect(() => {
    if (!data || step !== null) return;
    const p = data.progress;
    // 오늘 복습할 차례면 5단계(보지 않고 말하기)로 바로 연다
    const at = memorizedDate(p);
    const review = data.review ?? (at ? virtualState(id, at) : null);
    setStep(p?.memorized && isReviewDue(review) ? 5 : (p?.currentStep ?? 1));
    setLevels({ 3: p?.blankLevels?.[3] ?? DEFAULT_BLANK_LEVELS[3], 4: p?.blankLevels?.[4] ?? DEFAULT_BLANK_LEVELS[4] });
  }, [data, step]);
  useEffect(() => {
    setRevealed(new Set());
    setRevealAll(false);
  }, [step]);

  const plan = useMemo(() => (data ? blankPlanOf(data.dialogue) : null), [data]);
  // ✨ 유용한 회화 표현 — 1단계 표시용 (기존 대화문의 분석 결과는 빈칸 자료를 바꾸지 않음)
  const useful = useUseful(data?.dialogue);
  if (data === undefined || step === null) return <Loading />;
  if (data === null || !plan) return <NotFoundPage message="대화문을 찾을 수 없어요." />;
  const { dialogue, progress } = data;
  const level = step === 3 || step === 4 ? levels[step] : 0;
  const memorizedAt = memorizedDate(progress);
  const reviewState: ReviewState | null = data.review ?? (memorizedAt ? virtualState(dialogue.id, memorizedAt) : null);

  const rateReview = async (rating: Rating) => {
    const next = recordReview(dialogue.id, data.review, memorizedAt, rating);
    await repos.reviewStates.put(next);
    await log(rating, true);
    toast(rating === 'wrong' ? '오늘 한 번 더 복습해요. 다시 외운 뒤 평가해 주세요.' : `복습 완료 — 다음 복습: ${reviewDateLabel(next.nextReviewAt)}`);
  };
  const numberOf = new Map(data.sentences.map((s) => [s.id, s.aiNumber ?? s.order]));

  const save = async (patch: Partial<DialogueProgress>) => {
    const now = new Date().toISOString();
    const base: DialogueProgress = progress ?? { id: dialogue.id, dialogueId: dialogue.id, currentStep: 1, highestCompletedStep: 0, stepResults: [], memorized: false, memorizedAt: null, blankMastery: {}, updatedAt: now };
    await contentStore.putDialogueProgress({ ...base, ...patch, blankLevels: { ...base.blankLevels, ...levels, ...patch.blankLevels }, updatedAt: now });
  };

  /** 학습 기록 한 줄 (홈의 '오늘 학습' 횟수) */
  const log = (rating: Rating, isReview: boolean) => {
    const now = new Date();
    const entry: StudyLog = { id: createId(), timestamp: now.toISOString(), date: toDateKey(now), activity: 'dialogue_step', itemType: 'dialogue', itemId: dialogue.id, step, rating, accuracy: ACCURACY[rating], isReview };
    return repos.studyLogs.add(entry);
  };

  const rate = async (rating: Rating) => {
    const done = rating !== 'wrong';
    const highest = (done ? Math.max(progress?.highestCompletedStep ?? 0, step) : (progress?.highestCompletedStep ?? 0)) as DialogueProgress['highestCompletedStep'];
    const next = (done && step < 5 ? step + 1 : step) as MemorizeStep;
    const memorized = (progress?.memorized ?? false) || (step === 5 && rating === 'easy');
    await save({
      stepResults: [...(progress?.stepResults ?? []), { step, accuracy: ACCURACY[rating], rating, completedAt: new Date().toISOString() }],
      highestCompletedStep: highest,
      currentStep: next,
      memorized,
      memorizedAt: memorized ? (progress?.memorizedAt ?? new Date().toISOString()) : null,
    });
    await log(rating, false);
    // 처음 암기를 마친 순간: 1일 뒤 첫 복습 일정 (이미 일정이 있으면 그대로)
    const first = memorized && !progress?.memorized ? scheduleAfterMemorized(dialogue.id, data.review) : null;
    if (first) await repos.reviewStates.put(first);
    if (first) toast('대화문을 통째로 외웠어요! 내일 첫 복습이 잡혔어요.');
    else if (memorized && step === 5) toast('대화문을 통째로 외웠어요!');
    else if (done) toast(`${step}단계 완료 — 다음 단계로 넘어가요`);
    else toast('이 단계를 한 번 더 해 봐요');
    if (next !== step) setStep(next);
  };

  return (
    <div className="space-y-4" data-testid="memorize-page">
      <PageHeader back={{ to: `/dialogues/${dialogue.id}`, label: '대화문' }} title={dialogue.title} description="대화문을 통째로 외워요. 단계마다 빈칸이 늘어나요." />

      {reviewState && progress?.memorized && (
        <ReviewCard
          due={isReviewDue(reviewState)}
          label={dayLabelOf(dialogue.sourceDays ?? [], '이 대화문')}
          state={reviewState}
          onRate={(r) => void rateReview(r)}
        />
      )}

      <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label="암기 단계">
        {STEPS.map((s) => {
          const done = (progress?.highestCompletedStep ?? 0) >= s;
          return (
            <button
              key={s}
              role="tab"
              aria-selected={step === s}
              onClick={() => setStep(s)}
              data-testid={`step-${s}`}
              className={`shrink-0 rounded-full px-3 py-2 text-sm font-semibold transition-colors ${step === s ? 'bg-ink text-white' : done ? 'bg-ok-soft text-ok' : 'border border-line bg-surface text-muted'}`}
            >
              {done ? '✓ ' : ''}
              {s}. {STEP_NAMES[s]}
            </button>
          );
        })}
      </div>

      <Card className="space-y-3 p-4">
        {(step === 3 || step === 4) && (
          <label className="flex flex-wrap items-center gap-3 text-sm" data-testid="blank-level">
            빈칸 양
            <input
              type="range"
              min={step === 3 ? 10 : 40}
              max={step === 3 ? 60 : 100}
              step={5}
              value={levels[step]}
              onChange={(e) => setLevels({ ...levels, [step]: Number(e.target.value) })}
              onPointerUp={() => void save({})}
              onKeyUp={() => void save({})}
              className="w-44"
              aria-label="빈칸 양"
            />
            <b className="tabular-nums">{levels[step]}%</b>
          </label>
        )}
        <div className="flex flex-wrap gap-2 text-sm">
          {step >= 2 && step <= 4 && (
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={firstLetter} onChange={(e) => setFirstLetter(e.target.checked)} /> 첫 글자 힌트
            </label>
          )}
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={korean} onChange={(e) => setKorean(e.target.checked)} /> 한국어 보기
          </label>
          {step >= 2 && (
            <Button size="sm" variant="ghost" onClick={() => setRevealAll((v) => !v)} data-testid="reveal-all">
              {revealAll ? '다시 가리기' : step === 5 ? '영어 전체 보기' : '정답 모두 보기'}
            </Button>
          )}
        </div>
        <p className="text-xs text-subtle">
          {step === 1 && '노란 표시 = 강사가 가르친 ★ 핵심 Chunk, 하늘색 표시 = ✨ 유용한 회화 표현이에요. 소리 내어 몇 번 읽어 보세요.'}
          {step === 2 && '핵심 Chunk가 빈칸이에요. 빈칸을 누르면 정답이 보여요.'}
          {step === 3 && '핵심 Chunk에 더해 ✨ 유용한 회화 표현과 주요 단어가 빈칸이에요. 빈칸 양을 조절할 수 있어요.'}
          {step === 4 && '문장 대부분이 빈칸이에요. 한국어를 보고 영어로 말해 보세요.'}
          {step === 5 && '영어를 보지 않고 한국어만 보고 대화 전체를 말해 보세요. 줄을 누르면 영어가 보여요.'}
        </p>
      </Card>

      <Card className="p-4 sm:p-5">
        <ol className="flex flex-col gap-3" data-testid="memorize-lines">
          {dialogue.lines.map((line) => {
            const en = line.segments.map((s) => s.text).join(' ');
            const ranks = normalizedRanks(plan, line.id);
            const wpos = wordsOf(en);
            const uspans = useful.model?.spans.get(line.id) ?? [];
            const blanks = blankIndexes(ranks, line.id, step, level);
            const lineOpen = revealAll || revealed.has(`${line.id}:all`);
            const isA = line.speaker === 'A';
            return (
              <li key={line.id} className={`flex items-start gap-2.5 ${isA ? '' : 'flex-row-reverse'}`}>
                <span className={`mt-1 grid size-8 shrink-0 place-items-center rounded-full text-sm font-bold text-white ${isA ? 'bg-brand' : 'bg-ink/80'}`}>{line.speaker}</span>
                <div className={`max-w-[88%] rounded-2xl px-4 py-3 ${isA ? 'rounded-tl-md bg-brand-soft' : 'rounded-tr-md border border-line bg-surface'}`}>
                  {line.sourceSentenceId && numberOf.has(line.sourceSentenceId) && <p className="mb-1 text-[11px] font-bold text-brand">원문 {numberOf.get(line.sourceSentenceId)}번 문장</p>}
                  {step === 5 && !lineOpen ? (
                    <button type="button" className="en text-left text-[15px] text-subtle underline decoration-dotted" onClick={() => setRevealed(new Set([...revealed, `${line.id}:all`]))} data-testid="line-hidden">
                      (영어 보기)
                    </button>
                  ) : (
                    <p className="en text-[16.5px] leading-relaxed text-ink" data-testid="memorize-line">
                      {tokensOf(en).map((t, i) => {
                        if (!t.word) return <span key={i}>{t.text}</span>;
                        const isChunk = ranks[t.index] === 1;
                        const isExtra = ranks[t.index] === 2 || (step === 1 && !isChunk && uspans.some((u) => wpos[t.index] && wpos[t.index].start >= u.s && wpos[t.index].end <= u.e));
                        const key = `${line.id}:${t.index}`;
                        const hidden = step !== 5 && blanks.has(t.index) && !revealAll && !revealed.has(key);
                        if (hidden)
                          return (
                            <button
                              key={i}
                              type="button"
                              onClick={() => setRevealed(new Set([...revealed, key]))}
                              data-testid="blank"
                              className={`mx-px inline-block rounded border-b-2 px-0.5 text-left align-baseline ${isChunk ? 'border-key-ink bg-key/60' : isExtra ? 'border-info bg-info-soft' : 'border-line-strong bg-canvas'}`}
                              style={{ minWidth: `${Math.max(2, t.text.length) * 0.62}em` }}
                              aria-label="빈칸 — 눌러서 정답 보기"
                            >
                              <span className="text-subtle">{firstLetter ? t.text[0] : ''}</span>
                            </button>
                          );
                        return (
                          <span key={i} className={step === 1 && isChunk ? 'rounded bg-key px-0.5' : step === 1 && isExtra ? 'rounded bg-info-soft px-0.5' : blanks.has(t.index) ? 'font-semibold text-brand' : ''}>
                            {t.text}
                          </span>
                        );
                      })}
                    </p>
                  )}
                  {(korean || step === 5) && <p className="mt-1.5 text-[14.5px] leading-relaxed text-muted">{line.korean}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      </Card>

      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="text-sm">
          <Badge tone="brand">{step}단계</Badge> <span className="text-muted">스스로 확인해 보세요</span>
          {progress?.memorized && <Badge tone="ok" className="ml-2">암기 완료</Badge>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => void rate('wrong')} data-testid="rate-wrong">
            못 했어요
          </Button>
          <Button size="sm" variant="soft" onClick={() => void rate('hard')} data-testid="rate-hard">
            헷갈려요
          </Button>
          <Button size="sm" onClick={() => void rate('easy')} data-testid="rate-easy">
            다 맞혔어요
          </Button>
        </div>
      </Card>
    </div>
  );
}

/** 누적 복습 — 오늘 복습할 차례면 평가 버튼, 아니면 다음 복습일 */
function ReviewCard({ due, label, state, onRate }: { due: boolean; label: string; state: ReviewState; onRate: (r: Rating) => void }) {
  const no = Math.max(1, state.reviewCount);
  if (!due)
    return (
      <p className="rounded-2xl bg-ok-soft px-4 py-3 text-sm text-ok" data-testid="review-next">
        암기 완료 · 다음 복습: <b>{reviewDateLabel(state.nextReviewAt)}</b> ({intervalDaysForIndex(state.intervalIndex)}일 간격)
      </p>
    );
  return (
    <Card className="space-y-3 border-brand/40 p-4" data-testid="review-card">
      <div>
        <p className="font-extrabold">
          오늘 복습할 차례예요 · {label} · {no}번째 복습
        </p>
        <p className="mt-1 text-sm text-muted">5단계 ‘보지 않고 말하기’로 대화문 전체를 떠올려 본 뒤, 얼마나 기억했는지 골라 주세요. 다음 복습일이 자동으로 정해져요.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => onRate('wrong')} data-testid="review-wrong">
          {REVIEW_RATING_LABEL.wrong}
        </Button>
        <Button size="sm" variant="soft" onClick={() => onRate('hard')} data-testid="review-hard">
          {REVIEW_RATING_LABEL.hard}
        </Button>
        <Button size="sm" onClick={() => onRate('easy')} data-testid="review-easy">
          {REVIEW_RATING_LABEL.easy}
        </Button>
      </div>
    </Card>
  );
}
