import { Link, useParams } from 'react-router-dom';
import { useState, type ReactNode } from 'react';
import { repos } from '@/repositories';
import { useLiveData } from '@/hooks/useLiveData';
import { useToast } from '@/hooks/useToast';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, SectionTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { FavoriteButton } from '@/components/ui/FavoriteButton';
import { PlannedButton, PlannedNotice } from '@/components/ui/PlannedNotice';
import { Loading } from '@/components/ui/Loading';
import { Icon } from '@/components/ui/Icon';
import { DialogueView } from '@/components/dialogue/DialogueView';
import { STEP_NAMES, weaknessTone } from '@/utils/labels';
import { relativeDayLabel } from '@/utils/date';
import type { MemorizeStep } from '@/types/models';
import { NotFoundPage } from './NotFoundPage';

export function DialogueDetailPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const [showKorean, setShowKorean] = useState(true);
  const [highlight, setHighlight] = useState(true);

  const data = useLiveData(async () => {
    const dialogue = await repos.dialogues.get(id);
    if (!dialogue) return null;
    const keyIds = dialogue.lines.flatMap((l) => l.segments).flatMap((s) => (s.keySentenceId ? [s.keySentenceId] : []));
    const [sentences, expressions, progress, review, video] = await Promise.all([
      repos.keySentences.getMany(keyIds),
      repos.expressions.getMany(dialogue.expressionIds),
      repos.dialogueProgress.get(id),
      repos.reviewStates.get('dialogue', id),
      dialogue.videoId ? repos.videos.get(dialogue.videoId) : Promise.resolve(undefined),
    ]);
    const exprStates = await Promise.all(expressions.map((e) => repos.reviewStates.get('expression', e.id)));
    return { dialogue, sentences, expressions, exprStates, progress, review, video };
  }, [id]);

  if (data === undefined) return <Loading />;
  if (data === null) return <NotFoundPage message="대화문을 찾을 수 없어요." />;
  const { dialogue, sentences, expressions, exprStates, progress, review, video } = data;
  const completed = progress?.highestCompletedStep ?? 0;

  return (
    <div>
      <PageHeader
        back={{ to: '/dialogues', label: '대화문 목록' }}
        title={dialogue.title}
        action={
          <FavoriteButton
            active={dialogue.isFavorite}
            label={dialogue.title}
            onToggle={async () => {
              await repos.dialogues.setFavorite(dialogue.id, !dialogue.isFavorite);
              toast(dialogue.isFavorite ? '즐겨찾기에서 해제했어요' : '즐겨찾기에 추가했어요');
            }}
          />
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-4">
          <Card className="p-4">
            <p className="text-xs font-semibold text-muted">대화 상황</p>
            <p className="mt-1 text-[15px]">{dialogue.situation}</p>
            <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
              <Badge tone="brand">{dialogue.kind === 'original' ? '영상 원본 대화문' : '조합 대화문'}</Badge>
              {dialogue.isSample && <Badge>샘플</Badge>}
              {video && (
                <Link to={`/videos/${video.id}`} className="inline-flex items-center gap-1 font-semibold text-brand">
                  <Icon name="video" className="size-3.5" />
                  {video.title}
                </Link>
              )}
            </div>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[17px] font-bold">STEP 1 · 전체 대화문</h2>
            <div className="flex gap-1.5">
              <Toggle active={showKorean} onClick={() => setShowKorean((v) => !v)} icon={showKorean ? 'eye' : 'eyeOff'}>
                한국어
              </Toggle>
              <Toggle active={highlight} onClick={() => setHighlight((v) => !v)}>
                핵심 문장 표시
              </Toggle>
            </div>
          </div>

          <Card className="p-4 sm:p-5">
            <DialogueView lines={dialogue.lines} sentences={sentences} showKorean={showKorean} highlightKeys={highlight} />
            <p className="mt-4 flex items-center gap-2 border-t border-line pt-3 text-xs text-muted">
              <mark className="shrink-0 rounded bg-key px-1 whitespace-nowrap text-ink">노란 표시</mark> 영상의 핵심 문장(원문 그대로) · 나머지는
              자연스러운 대화를 위한 연결 문장
            </p>
          </Card>

          {dialogue.compositionNote && (
            <p className="rounded-xl bg-surface px-4 py-3 text-sm text-muted ring-1 ring-line">
              <b className="text-ink">구성 메모</b> · {dialogue.compositionNote}
            </p>
          )}

          <section>
            <SectionTitle>주요 표현</SectionTitle>
            <ul className="grid gap-2 sm:grid-cols-2">
              {expressions.map((e, i) => {
                const st = exprStates[i];
                return (
                  <li key={e.id}>
                    <Card className="flex items-start gap-2 p-3.5">
                      <div className="min-w-0 flex-1">
                        <p className="en font-semibold">{e.text}</p>
                        <p className="text-sm text-muted">{e.meaningKo}</p>
                      </div>
                      {st && <Badge tone={weaknessTone(st.weakness)}>취약도 {st.weakness}</Badge>}
                    </Card>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>

        <aside className="space-y-4">
          <Card className="p-4">
            <h2 className="font-bold">5단계 암기 진행</h2>
            <ol className="mt-3 space-y-2">
              {([1, 2, 3, 4, 5] as MemorizeStep[]).map((s) => {
                const done = s <= completed;
                const result = progress?.stepResults.find((r) => r.step === s);
                return (
                  <li key={s} className="flex items-center gap-2.5 text-sm">
                    <span
                      className={`grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold ${
                        done ? 'bg-brand text-white' : 'bg-canvas text-subtle ring-1 ring-line'
                      }`}
                    >
                      {done ? <Icon name="check" className="size-3.5" /> : s}
                    </span>
                    <span className={done ? 'font-semibold' : 'text-muted'}>{STEP_NAMES[s]}</span>
                    {result && <span className="ml-auto text-xs text-subtle">{Math.round(result.accuracy * 100)}%</span>}
                  </li>
                );
              })}
            </ol>
            {progress?.memorized && (
              <p className="mt-3 rounded-lg bg-ok-soft px-3 py-2 text-sm font-semibold text-ok">암기 완료한 대화문</p>
            )}
            {review && (
              <p className="mt-3 text-xs text-muted">
                다음 복습: <b className="text-ink">{relativeDayLabel(review.nextReviewAt)}</b>
              </p>
            )}
            <PlannedButton label="암기 시작" stage="5단계" className="mt-4 w-full" />
          </Card>
          <PlannedNotice title="듣고 따라 읽기(음성 재생)" stage="추후">
            음성 기능은 아직 구현되지 않았습니다. 지금은 화면의 문장을 소리 내어 읽어 보세요.
          </PlannedNotice>
        </aside>
      </div>
    </div>
  );
}

function Toggle({
  active,
  onClick,
  children,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  icon?: 'eye' | 'eyeOff';
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-semibold transition-colors ${
        active ? 'bg-brand-soft text-brand' : 'border border-line bg-surface text-subtle'
      }`}
    >
      {icon && <Icon name={icon} className="size-4" />}
      {children}
    </button>
  );
}
