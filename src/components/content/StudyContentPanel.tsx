import { useState, type ReactNode } from 'react';
import { contentStore } from '@/repositories';
import { seriesOf } from '@/services/content/contentService';
import type { DayAssignment, Dialogue, Expression, KeySentence, LearningItem, Video } from '@/types/models';
import { chunkLabel, matchAllParts } from '@/utils/chunkMatch';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { LinkButton } from '@/components/ui/Button';
import { formatDuration } from '@/utils/date';

/**
 * 원문·Chunk (Day 하나의 학습 자료) — 저장된 자료만 보여 준다 (Gemini 호출 없음)
 *  ★ 공통 핵심 Chunk (could … use) → 원문 문장(번호 그대로, Chunk 강조) → 문장별 Chunk → Day 통합 대화문으로
 */

const partsOfItem = (li: LearningItem, e: Expression | undefined) => li.chunk?.parts ?? (e ? [e.text] : []);

/** 문장 안의 Chunk 부분만 강조 (떨어진 표현은 부분마다) */
export function HighlightedText({ text, cores, chunks }: { text: string; cores: string[][]; chunks: string[][] }) {
  const spans: { s: number; e: number; core: boolean }[] = [];
  const add = (parts: string[], core: boolean) => {
    for (const m of matchAllParts(text, parts)) for (const [s, e] of m.spans) if (!spans.some((x) => s < x.e && x.s < e)) spans.push({ s, e, core });
  };
  cores.forEach((p) => add(p, true));
  chunks.forEach((p) => add(p, false));
  spans.sort((a, b) => a.s - b.s);
  const out: ReactNode[] = [];
  let pos = 0;
  spans.forEach((sp, i) => {
    if (sp.s > pos) out.push(text.slice(pos, sp.s));
    out.push(
      <mark key={i} className={`rounded px-0.5 text-ink ${sp.core ? 'bg-key font-bold' : 'bg-brand-soft'}`}>
        {text.slice(sp.s, sp.e)}
      </mark>,
    );
    pos = sp.e;
  });
  if (pos < text.length) out.push(text.slice(pos));
  return <>{out}</>;
}

export function StudyContentPanel({
  video,
  day,
  sentences,
  items,
  expressions,
  dialogues,
  onSeek,
}: {
  video: Video;
  day: DayAssignment | undefined;
  sentences: KeySentence[];
  items: LearningItem[];
  expressions: Expression[];
  dialogues: Dialogue[];
  onSeek?: (sec: number) => void;
}) {
  const [onlySelected, setOnlySelected] = useState(false);
  const series = seriesOf(video, day);
  const exprById = new Map(expressions.map((e) => [e.id, e]));
  const chunks = items.filter((i) => i.kind === 'chunk');
  const cores = items.filter((i) => i.kind === 'core');
  const coreParts = cores.map((c) => partsOfItem(c, exprById.get(c.expressionId)));
  const linkedIds = new Set([...chunks.map((c) => c.sentenceId), ...cores.flatMap((c) => (c.occurrences ?? []).map((o) => o.sentenceId))].filter(Boolean));
  const shown = sentences
    .filter((s) => s.origin === 'ai_extracted' || linkedIds.has(s.id))
    .sort((a, b) => (a.aiNumber ?? a.order) - (b.aiNumber ?? b.order) || a.order - b.order);
  const numberOf = new Map(shown.map((s) => [s.id, s.aiNumber ?? s.order]));
  const dayDialogue = dialogues.find((d) => d.videoId === video.id && d.kind === 'original' && d.generatedBy === 'ai');
  if (shown.length === 0 && cores.length === 0) return null;
  const selectedS = shown.filter((s) => s.selected).length;
  const selectedC = chunks.filter((c) => c.selected).length;
  const label = series.seriesKind === 'day' ? `Day ${series.dayNumber}` : '이 영상';

  return (
    <div className="space-y-4" data-testid="study-content">
      {cores.length > 0 && (
        <Card className="border-key/60 p-4" data-testid="core-chunks">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="font-bold">★ 공통 핵심 Chunk</h3>
            {series.seriesKind === 'day' ? <Badge tone="brand">{label}</Badge> : <Badge tone="info">일반 영상</Badge>}
          </div>
          <ul className="space-y-3">
            {cores.map((c) => {
              const e = exprById.get(c.expressionId);
              const parts = partsOfItem(c, e);
              return (
                <li key={c.id} data-testid="core-chunk">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="en rounded bg-key px-1.5 text-lg font-extrabold text-ink">{chunkLabel(e?.text ?? parts.join(' '), parts, (c.occurrences ?? []).map((o) => o.surface))}</span>
                    {(c.chunk?.meaningInSentence || e?.meaningKo) && <span className="text-[15px] text-ink">{c.chunk?.meaningInSentence || e?.meaningKo}</span>}
                  </div>
                  {c.chunk?.nuance && <p className="mt-1 text-sm"><span className="text-xs font-semibold text-subtle">뉘앙스 · </span>{c.chunk.nuance}</p>}
                  {(c.occurrences?.length ?? 0) > 0 && (
                    <p className="mt-1 text-sm text-muted" data-testid="core-occurrences">
                      나오는 문장:{' '}
                      {c.occurrences!.map((o, i) => (
                        <span key={i} className="mr-2 whitespace-nowrap">
                          <b className="text-ink">{numberOf.get(o.sentenceId) ?? '·'}</b> <span className="en">{o.surface}</span>
                        </span>
                      ))}
                    </p>
                  )}
                  <ChunkDetails item={c} />
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {dayDialogue ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="day-dialogue-link">
          <div className="min-w-0">
            <p className="font-bold">{label} 통합 대화문</p>
            <p className="truncate text-sm text-muted">{dayDialogue.title} · {dayDialogue.lines.length}줄</p>
          </div>
          <div className="flex gap-2">
            <LinkButton to={`/dialogues/${dayDialogue.id}`} size="sm" variant="secondary">
              대화문 보기
            </LinkButton>
            <LinkButton to={`/dialogues/${dayDialogue.id}/memorize`} size="sm">
              5단계 암기
            </LinkButton>
          </div>
        </Card>
      ) : null}

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-bold">원문 핵심 문장 {shown.length}개</h3>
          <label className="flex items-center gap-1.5 text-sm text-muted">
            <input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} data-testid="only-selected" />
            고른 것만 보기
          </label>
        </div>
        <p className="mt-1 text-sm text-muted" data-testid="content-counts">
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
                    <p className="en text-[17px] font-semibold leading-snug text-ink">
                      <HighlightedText text={s.english} cores={coreParts} chunks={own.map((c) => partsOfItem(c, exprById.get(c.expressionId)))} />
                    </p>
                    {s.korean && <p className="mt-0.5 text-sm text-muted">{s.korean}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <SelectToggle on={!!s.selected} label="암기할 문장" testId="select-sentence" disabled={s.origin !== 'ai_extracted'} onChange={(v) => void contentStore.setSentenceSelected(s.id, v)} />
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
      </Card>
    </div>
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

function ChunkDetails({ item }: { item: LearningItem }) {
  const c = item.chunk;
  if (!c) return null;
  const rows: [string, string][] = [
    ['문장 속 의미', item.kind === 'core' ? '' : c.meaningInSentence],
    ['쓰는 상황', c.usage],
    ['비슷한 표현', c.comparison],
    ...(item.kind === 'core' ? [] : ([['뉘앙스', c.nuance]] as [string, string][])),
  ].filter(([, v]) => v) as [string, string][];
  if (!rows.length && !c.examples.length) return null;
  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer text-xs font-semibold text-brand">{item.kind === 'core' ? '쓰는 상황·비슷한 표현·예문 보기' : '뜻·뉘앙스·쓰는 상황·예문 보기'}</summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-xs font-semibold text-subtle">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
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
  );
}

function ChunkRow({ item, expression }: { item: LearningItem; expression: Expression | undefined }) {
  const parts = item.chunk?.parts;
  return (
    <li className="rounded-xl bg-canvas p-3" data-testid="content-chunk">
      <div className="flex flex-wrap items-center gap-2">
        <span className="en rounded bg-brand-soft px-1.5 font-semibold text-ink">{chunkLabel(expression?.text ?? '(Chunk)', parts, [item.chunk?.surface])}</span>
        {item.chunk?.surface && parts && parts.length > 1 && <span className="en text-xs text-subtle">({item.chunk.surface})</span>}
        {expression?.meaningKo && <span className="text-sm text-muted">{expression.meaningKo}</span>}
        <span className="ml-auto">
          <SelectToggle on={!!item.selected} label="암기할 Chunk" testId="select-chunk" onChange={(v) => void contentStore.setChunkSelected(item.id, v)} />
        </span>
      </div>
      <ChunkDetails item={item} />
    </li>
  );
}
