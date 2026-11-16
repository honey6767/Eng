import { useEffect, useState } from 'react';
import { contentStore } from '@/repositories';
import { contentDeps, contentProgress, type ContentProgress } from '@/services/content';
import { seriesOf } from '@/services/content/contentService';
import type { DayAssignment, Expression, KeySentence, LearningItem, Transcript, Video } from '@/types/models';
import { useToast } from '@/hooks/useToast';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatDuration } from '@/utils/date';

/**
 * 영상 원문 문장 · Chunk (AI 학습 콘텐츠)
 * ① 원문 문장 암기 ② 문장 속 Chunk 학습 — 둘은 따로 선택해 학습한다.
 */

export function useContentProgress(videoId: string) {
  const [, force] = useState(0);
  useEffect(() => contentProgress.subscribe(() => force((n) => n + 1)), []);
  return { progress: contentProgress.get(videoId), running: contentProgress.isRunning(videoId) };
}

function elapsed(since: string) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}

export function ContentStatus({ p }: { p: ContentProgress }) {
  return (
    <div className="rounded-xl bg-canvas px-3 py-2.5 text-sm" role="status" data-testid="content-status" data-phase={p.phase}>
      {p.phase === 'sending' && <p className="font-semibold text-brand">요청 보내는 중…</p>}
      {p.phase === 'processing' && (
        <>
          <p className="font-semibold text-brand">문장·Chunk 만드는 중 · {elapsed(p.since)} 경과</p>
          {p.note && <p className="mt-1 text-xs text-subtle">{p.note}</p>}
        </>
      )}
      {p.phase === 'already' && <p className="font-semibold text-ok">이미 문장·Chunk가 저장돼 있어 다시 요청하지 않았어요.</p>}
      {p.phase === 'succeeded' && (
        <>
          <p className="font-semibold text-ok">
            저장 완료 — 원문 문장 {p.sentences}개 · Chunk {p.chunks}개{p.reused ? ' (이전에 받은 결과 사용)' : ''}
          </p>
          {p.issues.length > 0 && <p className="mt-1 text-xs text-warn">참고: {p.issues.slice(0, 3).join(' / ')}</p>}
        </>
      )}
      {p.phase === 'failed' && (
        <>
          <p className="font-semibold text-danger" data-testid="content-error">
            실패{p.httpStatus ? ` · HTTP ${p.httpStatus}` : ''} · {p.code}
          </p>
          <p className="mt-1 text-xs text-muted">{p.message}</p>
        </>
      )}
    </div>
  );
}

export function StudyContentPanel({
  video,
  day,
  transcript,
  sentences,
  items,
  expressions,
  onSeek,
}: {
  video: Video;
  day: DayAssignment | undefined;
  transcript: Transcript | undefined;
  sentences: KeySentence[];
  items: LearningItem[];
  expressions: Expression[];
  onSeek?: (sec: number) => void;
}) {
  const toast = useToast();
  const { progress, running } = useContentProgress(video.id);
  const [, tick] = useState(0);
  const [onlySelected, setOnlySelected] = useState(false);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const series = seriesOf(video, day);
  const chunks = items.filter((i) => i.kind === 'chunk');
  const exprById = new Map(expressions.map((e) => [e.id, e]));
  const linkedIds = new Set(chunks.map((c) => c.sentenceId).filter(Boolean));
  const shown = sentences
    .filter((s) => s.origin === 'ai_extracted' || linkedIds.has(s.id))
    .sort((a, b) => (a.aiNumber ?? a.order) - (b.aiNumber ?? b.order) || a.order - b.order);
  const has = shown.length > 0 || chunks.length > 0;
  const hasTranscript = transcript?.status === 'success';
  const selectedS = shown.filter((s) => s.selected).length;
  const selectedC = chunks.filter((c) => c.selected).length;

  const start = () => {
    void contentProgress.start(contentDeps, video.id)?.then((p) => {
      if (p.phase === 'succeeded') toast(`문장 ${p.sentences}개 · Chunk ${p.chunks}개를 저장했어요`);
    });
  };

  return (
    <Card className="p-4" data-testid="study-content">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-bold">영상 원문 문장 · Chunk</h3>
          {series.seriesKind === 'day' ? <Badge tone="brand">Day {series.dayNumber}</Badge> : <Badge tone="info">일반 영상</Badge>}
          <Badge tone="neutral">AI</Badge>
        </div>
        {has && (
          <label className="flex items-center gap-1.5 text-sm text-muted">
            <input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} data-testid="only-selected" />
            고른 것만 보기
          </label>
        )}
      </div>
      <p className="mt-1.5 text-sm text-muted">
        {series.seriesKind === 'day'
          ? '영상에 나온 번호와 원문 문장을 그대로 보여 줘요. 문장 전체 암기와 문장 속 Chunk 학습을 각각 골라서 하세요.'
          : 'AI가 영상 전체 맥락에서 일상회화에 유용한 문장과 Chunk를 골랐어요. 문장과 Chunk를 각각 골라서 학습하세요.'}
      </p>

      {progress && <div className="mt-3"><ContentStatus p={progress} /></div>}

      {!has && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={start} disabled={running || !hasTranscript || !video.youtubeVideoId} data-testid="content-start">
            {running ? '진행 중…' : progress?.phase === 'failed' ? '다시 시도' : 'AI로 문장·Chunk 만들기'}
          </Button>
          <span className="text-xs text-subtle">{hasTranscript ? '저장된 자막으로 만들어요 (영상은 다시 보내지 않음).' : '먼저 자막 탭에서 자막을 만들거나 붙여 넣어 주세요.'}</span>
        </div>
      )}

      {has && (
        <>
          <p className="mt-3 text-sm text-muted" data-testid="content-counts">
            원문 문장 {shown.length}개 · Chunk {chunks.length}개 · 고른 문장 {selectedS} · 고른 Chunk {selectedC}
          </p>
          <ol className="mt-3 space-y-3">
            {shown.map((s) => {
              const own = chunks.filter((c) => c.sentenceId === s.id && (!onlySelected || c.selected));
              if (onlySelected && !s.selected && own.length === 0) return null;
              return (
                <li key={s.id} className="rounded-2xl border border-line p-3.5" data-testid="content-sentence">
                  <div className="flex items-start gap-2.5">
                    <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-brand text-sm font-bold text-white">{s.aiNumber ?? s.order}</span>
                    <div className="min-w-0 flex-1">
                      <p className="en text-[17px] font-semibold leading-snug text-ink">{s.english}</p>
                      {s.korean && <p className="mt-0.5 text-sm text-muted">{s.korean}</p>}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <SelectToggle
                          on={!!s.selected}
                          label="암기할 문장"
                          testId="select-sentence"
                          disabled={s.origin !== 'ai_extracted'}
                          onChange={(v) => void contentStore.setSentenceSelected(s.id, v)}
                        />
                        {s.origin !== 'ai_extracted' && <Badge>직접 고른 핵심 문장</Badge>}
                        {s.timestampSec != null && onSeek && (
                          <button type="button" className="text-xs text-brand underline underline-offset-2" onClick={() => onSeek(s.timestampSec!)}>
                            {formatDuration(s.timestampSec)}부터 듣기
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                  {own.length > 0 && (
                    <ul className="mt-3 space-y-2 border-t border-line pt-3">
                      {own.map((c) => (
                        <ChunkRow key={c.id} item={c} expression={exprById.get(c.expressionId)} />
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </Card>
  );
}

function SelectToggle({ on, label, onChange, testId, disabled }: { on: boolean; label: string; onChange: (v: boolean) => void; testId: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      data-testid={testId}
      className={`inline-flex h-8 items-center gap-1 rounded-full px-3 text-xs font-bold transition-colors disabled:opacity-40 ${on ? 'bg-ok-soft text-ok' : 'border border-line bg-surface text-muted hover:text-ink'}`}
    >
      {on ? '✓ ' : '+ '}
      {label}
    </button>
  );
}

function ChunkRow({ item, expression }: { item: LearningItem; expression: Expression | undefined }) {
  const c = item.chunk;
  return (
    <li className="rounded-xl bg-canvas p-3" data-testid="content-chunk">
      <div className="flex flex-wrap items-center gap-2">
        <span className="en rounded bg-key px-1.5 font-semibold text-ink">{expression?.text ?? '(Chunk)'}</span>
        {expression?.meaningKo && <span className="text-sm text-muted">{expression.meaningKo}</span>}
        <span className="ml-auto">
          <SelectToggle on={!!item.selected} label="암기할 Chunk" testId="select-chunk" onChange={(v) => void contentStore.setChunkSelected(item.id, v)} />
        </span>
      </div>
      {c && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-xs font-semibold text-brand">뜻·뉘앙스·쓰는 상황·예문 보기</summary>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
            {c.meaningInSentence && (
              <>
                <dt className="text-xs font-semibold text-subtle">문장 속 의미</dt>
                <dd>{c.meaningInSentence}</dd>
              </>
            )}
            {c.nuance && (
              <>
                <dt className="text-xs font-semibold text-subtle">뉘앙스</dt>
                <dd>{c.nuance}</dd>
              </>
            )}
            {c.usage && (
              <>
                <dt className="text-xs font-semibold text-subtle">쓰는 상황</dt>
                <dd>{c.usage}</dd>
              </>
            )}
            {c.comparison && (
              <>
                <dt className="text-xs font-semibold text-subtle">비슷한 표현</dt>
                <dd>{c.comparison}</dd>
              </>
            )}
          </dl>
          {c.examples.length > 0 && (
            <ul className="mt-2 space-y-1">
              {c.examples.map((e, i) => (
                <li key={i}>
                  <span className="en text-ink">{e.en}</span> <span className="text-muted">— {e.ko}</span>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </li>
  );
}
