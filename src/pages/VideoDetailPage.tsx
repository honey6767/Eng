import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useState } from 'react';
import { repos } from '@/repositories';
import { useLiveData } from '@/hooks/useLiveData';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { PlannedNotice } from '@/components/ui/PlannedNotice';
import { Loading } from '@/components/ui/Loading';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { VideoThumb } from '@/components/video/VideoThumb';
import { formatDuration, formatTimestamp } from '@/utils/date';
import { LEARNING_STATUS, ORIGIN, TRANSCRIPT_STATUS, VIDEO_STATUS } from '@/utils/labels';
import type { Dialogue, DialogueComposition, ExpressionNote, KeySentence, Transcript } from '@/types/models';
import { NotFoundPage } from './NotFoundPage';

const TABS = [
  { key: 'preview', label: '주요 표현' },
  { key: 'sentences', label: '핵심 문장' },
  { key: 'dialogues', label: '대화문' },
  { key: 'transcript', label: '자막' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export function VideoDetailPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get('tab'))?.key ?? 'preview') as TabKey;

  const data = useLiveData(async () => {
    const video = await repos.videos.get(id);
    if (!video) return null;
    const [transcript, notes, sentences, dialogues, composition] = await Promise.all([
      repos.transcripts.getByVideo(id),
      repos.expressionNotes.listByVideo(id),
      repos.keySentences.listByVideo(id),
      repos.dialogues.listByVideo(id),
      repos.compositions.getByVideo(id),
    ]);
    return { video, transcript, notes, sentences, dialogues, composition };
  }, [id]);

  if (data === undefined) return <Loading />;
  if (data === null) return <NotFoundPage message="영상을 찾을 수 없어요." />;

  const { video, transcript, notes, sentences, dialogues, composition } = data;
  const status = VIDEO_STATUS[video.status];
  const counts: Record<TabKey, number | null> = {
    preview: new Set(notes.map((n) => n.expression)).size,
    sentences: sentences.length,
    dialogues: dialogues.length,
    transcript: null,
  };

  return (
    <div>
      <PageHeader back={{ to: '/videos', label: '영상 목록' }} title={video.title} />

      <Card className="mb-5 flex flex-col gap-4 p-4 sm:flex-row">
        <VideoThumb title={video.title} thumbnailUrl={video.thumbnailUrl} className="w-full sm:w-48" />
        <div className="min-w-0 flex-1 space-y-2 text-sm">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={status.tone}>{status.label}</Badge>
            <Badge tone={TRANSCRIPT_STATUS[transcript?.status ?? 'none'].tone}>
              {TRANSCRIPT_STATUS[transcript?.status ?? 'none'].label}
            </Badge>
            {video.isSample && <Badge>샘플 데이터</Badge>}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted">
            <dt>길이</dt>
            <dd className="text-ink">{formatDuration(video.durationSec)}</dd>
            <dt>원본</dt>
            <dd className="min-w-0 truncate text-ink">
              {video.url ? (
                <a href={video.url} target="_blank" rel="noreferrer" className="text-brand underline underline-offset-2">
                  YouTube에서 보기
                </a>
              ) : (
                <span className="text-subtle">URL 없음 (샘플)</span>
              )}
            </dd>
          </dl>
          <p className="text-xs text-subtle">학습 완료 여부 변경 · 영상 정보 수정은 2단계에서 제공됩니다.</p>
        </div>
      </Card>

      <div className="sticky top-14 z-20 -mx-4 mb-4 border-b border-line bg-canvas/95 px-4 backdrop-blur sm:-mx-6 sm:px-6 lg:top-0 lg:-mx-10 lg:px-10">
        <div className="flex gap-1 overflow-x-auto" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setParams({ tab: t.key }, { replace: true })}
              className={`-mb-px shrink-0 border-b-2 px-3 py-3 text-[15px] font-semibold transition-colors ${
                tab === t.key ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              {t.label}
              {counts[t.key] != null && <span className="ml-1 text-xs opacity-70">{counts[t.key]}</span>}
            </button>
          ))}
        </div>
      </div>

      {tab === 'preview' && <PreviewNotes notes={notes} />}
      {tab === 'sentences' && <SentenceList sentences={sentences} dialogues={dialogues} />}
      {tab === 'dialogues' && <DialogueList dialogues={dialogues} composition={composition} sentences={sentences} />}
      {tab === 'transcript' && <TranscriptView transcript={transcript} />}
    </div>
  );
}

function PreviewNotes({ notes }: { notes: ExpressionNote[] }) {
  if (notes.length === 0) {
    return (
      <div className="space-y-3">
        <Card className="p-5">
          <div className="flex items-center gap-2">
            <Badge tone="warn">
              <Icon name="alert" className="size-3.5" />
              설명 내용 확인 필요
            </Badge>
          </div>
          <p className="mt-2 text-sm text-muted">
            영상 앞부분의 주요 표현 설명을 아직 확보하지 못했습니다. 영상에서 설명하지 않은 내용을 임의로 만들어 표시하지
            않습니다.
          </p>
        </Card>
        <PlannedNotice title="주요 표현 노트 직접 입력 · 자막 기반 정리" stage="3단계" />
      </div>
    );
  }

  // 같은 표현의 '영상 설명'과 'AI 보충'을 묶어서 표시
  const groups = new Map<string, ExpressionNote[]>();
  for (const n of notes) groups.set(n.expression, [...(groups.get(n.expression) ?? []), n]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        영상을 보기 전에 앞부분에서 설명하는 주요 표현을 먼저 복습하세요. <Badge tone="brand">영상 설명</Badge>은 영상에서
        확인한 내용, <Badge tone="info">AI 보충</Badge>은 추가 설명입니다.
      </p>
      {[...groups.entries()].map(([expression, items]) => (
        <Card key={expression} className="p-5">
          <h3 className="en text-lg font-bold">{expression}</h3>
          <p className="text-[15px] text-muted">{items[0].meaningKo}</p>
          <div className="mt-3 space-y-3">
            {items.map((n) => (
              <div
                key={n.id}
                className={`rounded-xl p-3.5 text-sm ${n.origin === 'video' ? 'bg-brand-soft/60' : 'border border-dashed border-info/30 bg-info-soft/40'}`}
              >
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <Badge tone={ORIGIN[n.origin].tone}>{ORIGIN[n.origin].label}</Badge>
                  {n.verification === 'needs_check' && <Badge tone="warn">확인 필요</Badge>}
                  {n.sourceTimestampSec != null && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted">
                      <Icon name="clock" className="size-3.5" />
                      {formatTimestamp(n.sourceTimestampSec)}
                    </span>
                  )}
                </div>
                <dl className="space-y-1.5">
                  {n.usageContext && (
                    <div>
                      <dt className="inline font-semibold">사용 상황 </dt>
                      <dd className="inline text-muted">{n.usageContext}</dd>
                    </div>
                  )}
                  {n.nuance && (
                    <div>
                      <dt className="inline font-semibold">뉘앙스 </dt>
                      <dd className="inline text-muted">{n.nuance}</dd>
                    </div>
                  )}
                </dl>
                {n.examples.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {n.examples.map((ex, i) => (
                      <li key={i} className="border-l-2 border-line-strong pl-2.5">
                        <p className="en text-ink">{ex.en}</p>
                        <p className="text-xs text-muted">{ex.ko}</p>
                      </li>
                    ))}
                  </ul>
                )}
                {n.similar.length > 0 && (
                  <div className="mt-2">
                    <p className="font-semibold">비슷한 표현</p>
                    <ul className="mt-0.5 space-y-0.5 text-muted">
                      {n.similar.map((s, i) => (
                        <li key={i}>
                          <span className="en font-medium text-ink">{s.expression}</span> — {s.difference}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

function SentenceList({ sentences, dialogues }: { sentences: KeySentence[]; dialogues: Dialogue[] }) {
  if (sentences.length === 0) {
    return (
      <div className="space-y-3">
        <Card>
          <EmptyState icon="book" title="핵심 문장이 아직 없어요">
            영상에서 선정한 핵심 문장 5개를 입력하면 여기에 표시됩니다.
          </EmptyState>
        </Card>
        <PlannedNotice title="핵심 문장 5개 입력 · 수정" stage="3단계" />
      </div>
    );
  }
  const usedIn = (sid: string) =>
    dialogues.find((d) => d.lines.some((l) => l.segments.some((s) => s.keySentenceId === sid)));

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">영상에서 제공한 영어 문장을 원문 그대로 보존합니다.</p>
      <ol className="space-y-3">
        {sentences.map((s) => {
          const d = usedIn(s.id);
          const st = LEARNING_STATUS[s.status];
          return (
            <li key={s.id}>
              <Card className="p-4">
                <div className="flex gap-3">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-key text-sm font-bold text-key-ink">
                    {s.order}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="en text-[17px] leading-snug font-semibold">{s.english}</p>
                    <p className="mt-0.5 text-[15px] text-muted">{s.korean}</p>
                    <p className="mt-2 text-sm text-muted">
                      <span className="font-semibold text-ink">상황</span> {s.situation}
                    </p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      <Badge tone={st.tone}>{st.label}</Badge>
                      <span>
                        정답 {s.correctCount} · 오답 {s.wrongCount}
                      </span>
                      {s.timestampSec != null && (
                        <span className="inline-flex items-center gap-1">
                          · <Icon name="clock" className="size-3.5" /> {formatTimestamp(s.timestampSec)}
                        </span>
                      )}
                      {d && (
                        <Link to={`/dialogues/${d.id}`} className="font-semibold text-brand">
                          · 대화문 {d.orderInVideo}에서 사용
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function DialogueList({
  dialogues,
  composition,
  sentences,
}: {
  dialogues: Dialogue[];
  composition: DialogueComposition | undefined;
  sentences: KeySentence[];
}) {
  if (dialogues.length === 0) {
    return (
      <div className="space-y-3">
        <Card>
          <EmptyState icon="chat" title="대화문이 아직 없어요">
            핵심 문장 5개를 자연스러운 대화문(기본 1개, 최대 3개)으로 재구성하면 여기에 표시됩니다.
          </EmptyState>
        </Card>
        <PlannedNotice title="핵심 문장 → 대화문 재구성" stage="4단계" />
      </div>
    );
  }
  const leftovers = sentences.filter((s) => composition?.leftoverSentenceIds.includes(s.id));
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        핵심 문장 {sentences.length}개를 대화문 {dialogues.length}개로 구성했습니다.
      </p>
      {dialogues.map((d) => {
        const keyCount = d.lines.flatMap((l) => l.segments).filter((s) => s.kind === 'key').length;
        return (
          <Link key={d.id} to={`/dialogues/${d.id}`} className="block">
            <Card className="p-4 transition-colors hover:border-line-strong">
              <div className="flex items-center gap-2">
                <Badge tone="brand">대화문 {d.orderInVideo}</Badge>
                <span className="text-xs text-muted">핵심 문장 {keyCount}개 포함</span>
              </div>
              <p className="mt-2 font-bold">{d.title}</p>
              <p className="mt-0.5 text-sm text-muted">{d.situation}</p>
              {d.compositionNote && <p className="mt-2 rounded-lg bg-canvas px-3 py-2 text-xs text-muted">{d.compositionNote}</p>}
            </Card>
          </Link>
        );
      })}
      {leftovers.length > 0 && (
        <Card className="p-4">
          <p className="text-sm font-semibold">별도 연습 대상 문장</p>
          <ul className="mt-1 text-sm text-muted">
            {leftovers.map((s) => (
              <li key={s.id} className="en">
                {s.english}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function TranscriptView({ transcript }: { transcript: Transcript | undefined }) {
  const [showAll, setShowAll] = useState(false);
  if (!transcript || transcript.status === 'not_attempted') {
    return (
      <div className="space-y-3">
        <Card>
          <EmptyState icon="video" title="자막이 없어요">
            자막 자동 가져오기를 아직 시도하지 않았습니다.
          </EmptyState>
        </Card>
        <PlannedNotice title="자막 자동 가져오기 · 자막 직접 붙여넣기" stage="2단계" />
      </div>
    );
  }
  if (transcript.status === 'failed') {
    return (
      <div className="space-y-3">
        <Card className="border-danger/30 p-5">
          <Badge tone="danger">
            <Icon name="alert" className="size-3.5" />
            자막 가져오기 실패
          </Badge>
          <p className="mt-2 text-sm text-muted">{transcript.errorMessage ?? '자막을 가져오지 못했습니다.'}</p>
        </Card>
        <PlannedNotice title="자막 직접 붙여넣기 (타임스탬프 포함 형식 지원)" stage="2단계" />
      </div>
    );
  }
  const segs = showAll ? transcript.segments : transcript.segments.slice(0, 20);
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <Badge tone="ok">자막 있음</Badge>
        <span className="text-xs text-muted">
          {transcript.source === 'manual_paste' ? '직접 붙여넣음' : 'YouTube'} · {transcript.segments.length}개 구간
        </span>
      </div>
      <ol className="space-y-1.5">
        {segs.map((s, i) => (
          <li key={i} className="flex gap-3 text-[15px]">
            <span className="w-12 shrink-0 pt-0.5 text-xs text-subtle tabular-nums">{formatTimestamp(s.startSec) ?? '—'}</span>
            <span className="en">{s.text}</span>
          </li>
        ))}
      </ol>
      {transcript.segments.length > 20 && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-3 text-sm font-semibold text-brand">
          {showAll ? '접기' : `전체 ${transcript.segments.length}개 구간 보기`}
        </button>
      )}
    </Card>
  );
}
