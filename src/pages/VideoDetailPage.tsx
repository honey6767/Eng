import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useState } from 'react';
import { contentStore, extractionStore, repos } from '@/repositories';
import { StudyContentPanel } from '@/components/content/StudyContentPanel';
import { VideoPrepStatus } from '@/components/prep/PrepStatus';
import { useLiveData } from '@/hooks/useLiveData';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Loading } from '@/components/ui/Loading';
import { EmptyState } from '@/components/ui/EmptyState';
import { VideoThumb } from '@/components/video/VideoThumb';
import { VideoStatusControl } from '@/components/video/VideoStatusControl';
import { YouTubePlayer, type SeekRequest } from '@/components/video/YouTubePlayer';
import { TranscriptPanel } from '@/components/video/TranscriptPanel';
import { KeySentenceManager } from '@/components/sentences/KeySentenceManager';
import { ExpressionNotesPanel } from '@/components/sentences/ExpressionNotesPanel';
import { Button, LinkButton } from '@/components/ui/Button';
import { DialogueView } from '@/components/dialogue/DialogueView';
import { UsefulPanel, useUseful } from '@/components/dialogue/UsefulPanel';
import { useToast } from '@/hooks/useToast';
import { useYouTubeStatus } from '@/hooks/useYouTubeStatus';
import { startVideo } from '@/services/studyQueue';
import { formatDateKo, formatDuration } from '@/utils/date';
import { TRANSCRIPT_STATUS } from '@/utils/labels';
import type { Dialogue, DialogueComposition, Expression, KeySentence, LearningItem, Playlist } from '@/types/models';
import { NotFoundPage } from './NotFoundPage';
import { prepController } from '@/services/prep';

const TABS = [
  { key: 'sentences', label: '원문·Chunk' },
  { key: 'dialogues', label: '대화문' },
  { key: 'transcript', label: '자막' },
  { key: 'preview', label: '주요 표현' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export function VideoDetailPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const { status: proxy, refresh: refreshProxy } = useYouTubeStatus();
  const [seek, setSeek] = useState<SeekRequest | null>(null);
  const tabParam = TABS.find((t) => t.key === params.get('tab'))?.key as TabKey | undefined;

  const data = useLiveData(async () => {
    const video = await repos.videos.get(id);
    if (!video) return null;
    const [transcript, notes, sentences, dialogues, composition, playlists, expressions, learningItems, contentCtx] = await Promise.all([
      repos.transcripts.getByVideo(id),
      repos.expressionNotes.listByVideo(id),
      repos.keySentences.listByVideo(id),
      repos.dialogues.listByVideo(id),
      repos.compositions.getByVideo(id),
      repos.playlists.list(),
      repos.expressions.list(),
      extractionStore.listLearningItems(id),
      contentStore.readVideo(id),
    ]);
    return { video, transcript, notes, sentences, dialogues, composition, playlists, expressions, learningItems, day: contentCtx?.day };
  }, [id]);

  if (data === undefined) return <Loading />;
  if (data === null) return <NotFoundPage message="영상을 찾을 수 없어요." />;

  const { video, transcript, notes, sentences, dialogues, composition, playlists, expressions, learningItems, day } = data;
  // AI가 뽑은 핵심 표현 (B1-d로 자동 적용된 것) — 기존 표현 노트와 따로 보여 준다
  const aiItems = learningItems.filter((li) => li.origin === 'ai_extracted' && (li.kind === 'key' || li.kind === 'chunk'));
  // 직접 고른 핵심 문장(5개 선정 화면)과 AI 원문 문장은 따로 보여 준다
  const manualSentences = sentences.filter((s) => s.origin !== 'ai_extracted');
  const seekTo = (sec: number) => {
    setSeek({ sec, nonce: Date.now() });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const playlistById = new Map<string, Playlist>(playlists.map((p) => [p.id, p]));
  // 실제 영상은 2단계 기능인 자막 탭을 기본으로 연다
  const tab: TabKey = tabParam ?? (video.isSample ? 'preview' : 'sentences');
  const counts: Record<TabKey, number | null> = {
    preview: new Set(notes.map((n) => n.expression)).size + aiItems.length,
    sentences: sentences.length,
    dialogues: dialogues.length,
    transcript: null,
  };

  return (
    <div>
      <PageHeader back={{ to: '/videos', label: '영상 목록' }} title={video.title} />

      <div className="mb-5 grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div>
          {video.youtubeVideoId ? (
            <YouTubePlayer
              videoId={video.youtubeVideoId}
              title={video.title}
              thumbnailUrl={video.thumbnailUrl}
              seek={seek}
              onPlay={() => setSeek({ sec: 0, nonce: Date.now() })}
            />
          ) : (
            <VideoThumb title={video.title} thumbnailUrl={video.thumbnailUrl} className="w-full" />
          )}
        </div>
        <Card className="space-y-3 p-4 text-sm">
          <div>
            <p className="mb-1.5 text-xs font-semibold text-muted">학습 상태</p>
            <VideoStatusControl video={video} />
          </div>
          {video.status === 'new' && (
            <Button
              size="sm"
              onClick={async () => {
                await startVideo(repos, video);
                void prepController.enqueue([video.id]);
                toast('이 영상으로 학습을 시작했어요');
              }}
            >
              이 영상으로 학습 시작
            </Button>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-muted">
            <dt>길이</dt>
            <dd className="text-ink" data-testid="video-duration">
              {formatDuration(video.durationSec)}
            </dd>
            {video.channelTitle && (
              <>
                <dt>채널</dt>
                <dd className="text-ink">{video.channelTitle}</dd>
              </>
            )}
            <dt>자막</dt>
            <dd>
              <Badge tone={TRANSCRIPT_STATUS[transcript?.status ?? 'none'].tone}>{TRANSCRIPT_STATUS[transcript?.status ?? 'none'].label}</Badge>
            </dd>
            <dt>출처</dt>
            <dd className="space-y-0.5 text-ink" data-testid="video-sources">
              {video.isSample && <p>샘플 데이터 (실제 YouTube 영상 아님)</p>}
              {!video.isSample &&
                (video.sources ?? []).map((s, i) => (
                  <p key={i}>
                    {s.kind === 'playlist'
                      ? `재생목록 ‘${playlistById.get(s.playlistId)?.title ?? '알 수 없음'}’${s.position != null ? ` ${s.position + 1}번째` : ''}`
                      : '개별 URL 등록'}{' '}
                    <span className="text-xs text-subtle">· {formatDateKo(s.addedAt)}</span>
                  </p>
                ))}
            </dd>
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
          {video.metadataSource && ['oembed', 'rss', 'manual'].includes(video.metadataSource) && (
            <p className="rounded-lg bg-warn-soft px-2.5 py-2 text-xs text-warn">
              {video.metadataSource === 'manual'
                ? '서버 연결 없이 ID만으로 등록한 영상입니다. 서버를 연결한 뒤 같은 URL을 다시 등록하면 제목·길이가 보강됩니다.'
                : 'API 키 없이 제한 모드로 가져와 영상 길이를 확인하지 못했습니다. API 키 설정 후 다시 등록하면 보강됩니다.'}
            </p>
          )}
        </Card>
      </div>

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

      {tab === 'preview' && (
        <div className="space-y-4">
          {aiItems.length > 0 && (
            <AiExpressionList
              items={aiItems}
              expressions={expressions}
              onSeek={(sec) => {
                setSeek({ sec, nonce: Date.now() });
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            />
          )}
          <ExpressionNotesPanel video={video} notes={notes} sentences={sentences} expressions={expressions} />
        </div>
      )}
      {tab === 'sentences' && !video.isSample && (
        <div className="mb-4 space-y-4">
          <VideoPrepStatus videoId={video.id} />
          <StudyContentPanel video={video} day={day} sentences={sentences} items={learningItems} expressions={expressions} dialogues={dialogues} onSeek={video.youtubeVideoId ? seekTo : undefined} />
        </div>
      )}
      {tab === 'sentences' && !video.isSample && (
        <details className="mt-2" data-testid="manual-sentences">
          <summary className="cursor-pointer text-sm font-semibold text-muted">직접 고른 핵심 문장 (예전 방식) {manualSentences.length}개</summary>
          <div className="mt-3">
            <KeySentenceManager
              video={video}
              transcript={transcript}
              sentences={manualSentences}
              dialogues={dialogues}
              expressions={expressions}
              onSeek={seekTo}
            />
          </div>
        </details>
      )}
      {tab === 'sentences' && video.isSample && (
        <KeySentenceManager
          video={video}
          transcript={transcript}
          sentences={manualSentences}
          dialogues={dialogues}
          expressions={expressions}
          onSeek={(sec) => {
            setSeek({ sec, nonce: Date.now() });
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      )}
      {tab === 'dialogues' && (
        <div className="space-y-4">
          {!video.isSample && !dialogues.some((d) => d.generatedBy === 'ai' && d.kind === 'original') && <VideoPrepStatus videoId={video.id} />}
          <DialogueList dialogues={dialogues} composition={composition} sentences={sentences} />
        </div>
      )}
      {tab === 'transcript' && (
        <TranscriptPanel
          video={video}
          transcript={transcript}
          proxy={proxy}
          onUsageChanged={refreshProxy}
          onSeek={(sec) => {
            setSeek({ sec, nonce: Date.now() });
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      )}
    </div>
  );
}

function AiExpressionList({ items, expressions, onSeek }: { items: LearningItem[]; expressions: Expression[]; onSeek: (sec: number) => void }) {
  const byId = new Map(expressions.map((e) => [e.id, e]));
  const sorted = [...items].sort((a, b) => (a.timestampSec ?? 1e9) - (b.timestampSec ?? 1e9));
  return (
    <Card className="p-4" data-testid="ai-expressions">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="font-bold">AI가 찾은 핵심 표현 {sorted.length}개</h3>
        <Badge tone="brand">AI 추출</Badge>
      </div>
      <ul className="divide-y divide-line">
        {sorted.map((li) => {
          const e = byId.get(li.expressionId);
          return (
            <li key={li.id} className="py-2.5">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-semibold text-ink">{e?.text ?? '(표현)'}</span>
                {e?.meaningKo && <span className="text-sm text-muted">{e.meaningKo}</span>}
                {li.status === 'needs_review' && <Badge tone="warn">확인 권장</Badge>}
                {li.onScreen && <Badge>화면 글자</Badge>}
                {li.timestampSec != null && (
                  <button type="button" className="text-xs text-brand underline underline-offset-2" onClick={() => onSeek(li.timestampSec!)}>
                    {formatDuration(li.timestampSec)}
                  </button>
                )}
              </div>
              {li.sourceText && <p className="mt-1 text-sm text-subtle">“{li.sourceText}”</p>}
            </li>
          );
        })}
      </ul>
    </Card>
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
            원문 문장과 공통 핵심 Chunk로 만든 통합 대화문이 학습 자료 자동 생성에서 만들어지면 여기에 표시돼요.
          </EmptyState>
        </Card>
      </div>
    );
  }
  const leftovers = sentences.filter((s) => composition?.leftoverSentenceIds.includes(s.id));
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        핵심 문장 {sentences.length}개를 대화문 {dialogues.length}개로 구성했습니다.
      </p>
      {dialogues.filter((d) => d.generatedBy === 'ai').map((d) => (
        <DayDialogueInline key={d.id} dialogue={d} sentences={sentences} />
      ))}
      {dialogues.filter((d) => d.generatedBy !== 'ai').map((d) => {
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

/** Day 통합 대화문 — 영상 화면에서 바로 읽고 암기로 이어 간다 */
function DayDialogueInline({ dialogue, sentences }: { dialogue: Dialogue; sentences: KeySentence[] }) {
  const [showKorean, setShowKorean] = useState(true);
  const useful = useUseful(dialogue);
  const [openRef, setOpenRef] = useState<string | null>(null);
  const used = new Set(dialogue.lines.map((l) => l.sourceSentenceId).filter(Boolean));
  const ai = sentences.filter((s) => s.origin === 'ai_extracted' || used.has(s.id)).sort((a, b) => (a.aiNumber ?? a.order) - (b.aiNumber ?? b.order));
  return (
    <Card className="space-y-3 p-4" data-testid="day-dialogue">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="brand">통합 대화문</Badge>
        {dialogue.sourceDays?.map((d) => (
          <Badge key={d} tone="info">
            Day {d}
          </Badge>
        ))}
        <span className="ml-auto" />
        <button type="button" className="text-sm font-semibold text-brand" onClick={() => setShowKorean((v) => !v)}>
          한국어 {showKorean ? '숨기기' : '보기'}
        </button>
      </div>
      <div>
        <p className="font-bold">{dialogue.title}</p>
        <p className="mt-0.5 text-sm text-muted">{dialogue.situation}</p>
      </div>
      <DialogueView lines={dialogue.lines} sentences={sentences} showKorean={showKorean} highlightKeys useful={useful.model} openRef={openRef} onOpen={setOpenRef} />
      <UsefulPanel dialogue={dialogue} useful={useful} onOpen={(k) => {
        setOpenRef(k);
        document.getElementById(`dl-${k.split(':').pop()}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }} />
      {ai.length > 0 && (
        <div className="rounded-xl bg-canvas p-3 text-sm" data-testid="source-map">
          <p className="mb-1 text-xs font-semibold text-subtle">원문 문장 연결</p>
          <ul className="space-y-0.5">
            {ai.map((s) => {
              const lineNos = dialogue.lines.filter((l) => l.sourceSentenceId === s.id).map((l) => l.order);
              return (
                <li key={s.id} className={lineNos.length ? '' : 'text-subtle'}>
                  <b>{s.aiNumber ?? s.order}</b> <span className="en">{s.english}</span> → {lineNos.length ? `대화 ${lineNos.join(', ')}번째 줄` : '대화에 쓰지 않음'}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {(dialogue.chunkUsages?.length ?? 0) > 0 && (
        <ul className="space-y-2" data-testid="day-chunk-usages">
          {[...dialogue.chunkUsages!].sort((x, y) => (x.kind === 'extra' ? 1 : 0) - (y.kind === 'extra' ? 1 : 0)).map((u) => (
            <li key={u.learningItemId} className="rounded-xl border border-line p-3 text-sm">
              <p className="flex flex-wrap items-center gap-1.5">
                <mark className={`en rounded px-1 font-bold text-ink ${u.kind === 'extra' ? 'bg-brand-soft underline decoration-dashed decoration-brand underline-offset-4' : 'bg-key'}`}>{u.text}</mark>
                {u.kind === 'extra' && <Badge tone="info">✨ 유용한 회화 표현</Badge>}
                {u.kind === 'core' && <Badge tone="key">★ 핵심 Chunk</Badge>}
                <span className="text-xs text-subtle">대화 속 형태: {u.usedAs}</span>
              </p>
              {u.meaningInContext && <p className="mt-1"><span className="text-xs font-semibold text-subtle">이 대화의 의미 · </span>{u.meaningInContext}</p>}
              {u.nuance && <p><span className="text-xs font-semibold text-subtle">뉘앙스 · </span>{u.nuance}</p>}
              {u.whyUsed && <p><span className="text-xs font-semibold text-subtle">쓴 이유 · </span>{u.whyUsed}</p>}
              {u.example.en && <p className="mt-1"><span className="text-xs font-semibold text-subtle">응용 · </span><span className="en">{u.example.en}</span> <span className="text-muted">— {u.example.ko}</span></p>}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <LinkButton to={`/dialogues/${dialogue.id}/memorize`} data-testid="start-memorize">
          5단계 암기 시작
        </LinkButton>
        <LinkButton to={`/dialogues/${dialogue.id}`} variant="secondary">
          대화문 상세
        </LinkButton>
      </div>
    </Card>
  );
}
