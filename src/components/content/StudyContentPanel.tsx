import { useState, type ReactNode } from 'react';
import { contentStore } from '@/repositories';
import { seriesOf } from '@/services/content/contentService';
import type { DayAssignment, Dialogue, Expression, KeySentence, LearningItem, Video } from '@/types/models';
import { chunkLabel, matchAllParts, matchParts } from '@/utils/chunkMatch';
import { classifyChunks, corePatterns, extraViewOf } from '@/services/prep/chunkRoles';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { LinkButton } from '@/components/ui/Button';
import { formatDuration } from '@/utils/date';

/**
 * 원문·Chunk (Day 하나의 학습 자료) — 저장된 자료만 보여 준다 (Gemini 호출 없음)
 *  ★ 공통 핵심 Chunk (could … use) → 원문 문장(번호 그대로, Chunk 강조) → 문장별 Chunk → Day 통합 대화문으로
 */


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
      <mark key={i} className={`rounded px-0.5 text-ink ${sp.core ? 'bg-key font-bold' : 'bg-brand-soft underline decoration-dashed decoration-brand underline-offset-4'}`}>
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
  const view = classifyChunks(items, exprById);
  const { cores, extras, unclassified, variantsByCore } = view;
  const listChunks = [...extras, ...unclassified];
  const patterns = corePatterns(items, exprById);
  const coreParts = patterns.map((p) => p.parts);
  const hasCore = patterns.length > 0;
  const linkedIds = new Set([...items.filter((i) => i.kind === 'chunk').map((c) => c.sentenceId), ...cores.flatMap((c) => (c.occurrences ?? []).map((o) => o.sentenceId))].filter(Boolean));
  const shown = sentences
    .filter((s) => s.origin === 'ai_extracted' || linkedIds.has(s.id))
    .sort((a, b) => (a.aiNumber ?? a.order) - (b.aiNumber ?? b.order) || a.order - b.order);
  const byId = new Map(shown.map((s) => [s.id, s]));
  const numberOf = new Map(shown.map((s) => [s.id, s.aiNumber ?? s.order]));
  // 핵심 Chunk 카드 — 저장된 핵심 Chunk, 또는 예전 기준 자료에서 화면에서만 추론한 핵심 Chunk
  const cards = patterns.map((p) => {
    const variants = variantsByCore.get(p.id) ?? [];
    const core = p.basis === 'core' ? p.item : null;
    const occ: { sentenceId: string; surface: string }[] = core
      ? (core.occurrences ?? [])
      : shown.flatMap((s) => {
          const m = matchParts(s.english, p.parts);
          return m ? [{ sentenceId: s.id, surface: m.surface }] : [];
        });
    return { p, core, occ, variants, nuance: core?.chunk?.nuance ?? '' };
  });
  const dayDialogue = dialogues.find((d) => d.videoId === video.id && d.kind === 'original' && d.generatedBy === 'ai');
  if (shown.length === 0 && !hasCore) return null;
  const selectedS = shown.filter((s) => s.selected).length;
  const selectedC = [...cores, ...listChunks, ...[...variantsByCore.values()].flat()].filter((c) => c.selected).length;
  const label = series.seriesKind === 'day' ? `Day ${series.dayNumber}` : '이 영상';

  return (
    <div className="space-y-4" data-testid="study-content">
      {cards.length > 0 && (
        <Card className="border-key/60 p-4" data-testid="core-chunks">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h3 className="font-bold">★ 핵심 Chunk</h3>
            {series.seriesKind === 'day' ? <Badge tone="brand">{label}</Badge> : <Badge tone="info">일반 영상</Badge>}
          </div>
          <p className="mb-2 text-xs text-subtle">강사가 영상에서 직접 소개하고 설명한 표현이에요. 원문 속 활용형은 아래 ‘활용 사례’로 모았어요.</p>
          <ul className="space-y-4">
            {cards.map(({ p, core, occ, variants, nuance }) => {
              const e = core ? exprById.get(core.expressionId) : undefined;
              const variantOf = (sentenceId: string) => variants.filter((v) => v.sentenceId === sentenceId);
              const loose = variants.filter((v) => !occ.some((o) => o.sentenceId === v.sentenceId));
              return (
                <li key={p.id} data-testid="core-chunk" data-basis={p.basis}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="en rounded bg-key px-1.5 text-lg font-extrabold text-ink">{chunkLabel(e?.text ?? p.text, p.parts, occ.map((o) => o.surface))}</span>
                    {p.meaningKo && <span className="text-[15px] text-ink">{p.meaningKo}</span>}
                    {core && (
                      <span className="ml-auto">
                        <SelectToggle on={!!core.selected} label="암기할 Chunk" testId="select-core" onChange={(v) => void contentStore.setChunkSelected(core.id, v)} />
                      </span>
                    )}
                  </div>
                  {p.basis !== 'core' && (
                    <p className="mt-1 rounded-lg bg-warn-soft px-2.5 py-1.5 text-xs text-ink" data-testid="core-inferred">
                      {p.basis === 'key'
                        ? '예전 기준으로 만든 자료라 핵심 Chunk 기록이 따로 없어요. 자막 추출 때 찾은 강사 표현을 기준으로 화면에서만 묶었어요. 저장된 자료는 그대로예요.'
                        : '예전 기준으로 만든 자료라 핵심 Chunk 기록이 따로 없어요. 여러 Chunk에 공통으로 들어 있는 부분을 핵심 Chunk로 추정해 화면에서만 묶었어요. 저장된 자료는 그대로예요.'}
                    </p>
                  )}
                  {nuance && <p className="mt-1 text-sm"><span className="text-xs font-semibold text-subtle">뉘앙스 · </span>{nuance}</p>}
                  {p.taught && (
                    <p className="mt-1 rounded-lg bg-canvas px-2.5 py-1.5 text-sm text-muted" data-testid="core-taught">
                      <span className="text-xs font-semibold text-subtle">강의 설명 · </span>“{p.taught}”
                    </p>
                  )}
                  {(occ.length > 0 || loose.length > 0) && (
                    <div className="mt-2" data-testid="core-occurrences">
                      <p className="text-xs font-semibold text-subtle">활용 사례 {occ.length + loose.length}개</p>
                      <ul className="mt-1 space-y-1">
                        {occ.map((o, i) => {
                          const sent = byId.get(o.sentenceId);
                          return (
                            <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                              <b className="w-5 shrink-0 text-right text-ink">{numberOf.get(o.sentenceId) ?? '·'}</b>
                              <span className="en min-w-0">
                                {sent ? <HighlightedText text={sent.english} cores={[p.parts]} chunks={[]} /> : o.surface}
                                {o.surface.toLowerCase() !== p.text.toLowerCase() && <span className="ml-1 text-xs text-subtle">({o.surface})</span>}
                              </span>
                              {variantOf(o.sentenceId).map((v) => (
                                <VariantToggle key={v.id} item={v} text={exprById.get(v.expressionId)?.text ?? ''} />
                              ))}
                            </li>
                          );
                        })}
                        {loose.map((v) => (
                          <li key={v.id} className="flex flex-wrap items-center gap-2 text-sm">
                            <b className="w-5 shrink-0 text-right text-ink">·</b>
                            <span className="en">{exprById.get(v.expressionId)?.text}</span>
                            <VariantToggle item={v} text="" />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {core && <ChunkDetails item={core} />}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {listChunks.length > 0 && (
        <Card className="p-4" data-testid="extra-chunks">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h3 className="font-bold">{hasCore ? '추가 덩어리 표현' : '문장 속 Chunk'}</h3>
            {hasCore && <Badge tone="info">AI 추가</Badge>}
          </div>
          <p className="mb-2 text-xs text-subtle">
            {hasCore ? '강사가 직접 가르치지는 않았지만, 영상 문맥에서 찾은 자연스럽고 유용한 회화 표현이에요.' : '이 영상은 핵심 Chunk가 아직 정리되지 않았어요. 학습 자료가 만들어지면 핵심 Chunk와 추가 표현으로 나뉘어요.'}
          </p>
          <ul className="space-y-2">
            {listChunks
              .filter((c) => !onlySelected || c.selected)
              .map((c) => (
                <ChunkRow key={c.id} item={c} expression={exprById.get(c.expressionId)} sentence={c.sentenceId ? byId.get(c.sentenceId) : undefined} number={c.sentenceId ? numberOf.get(c.sentenceId) : undefined} extra={hasCore} />
              ))}
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
          원문 문장 {shown.length}개 · 핵심 Chunk {patterns.length}개 · {hasCore ? '추가 표현' : 'Chunk'} {listChunks.length}개 · 고른 문장 {selectedS} · 고른 Chunk {selectedC}
        </p>
        {(hasCore || listChunks.length > 0) && (
          <p className="mt-1 flex flex-wrap gap-3 text-xs text-subtle">
            <span><mark className="rounded bg-key px-1 text-ink">노란 표시</mark> 핵심 Chunk</span>
            <span><mark className="rounded bg-brand-soft px-1 text-ink underline decoration-dashed decoration-brand underline-offset-4">점선 표시</mark> {hasCore ? '추가 덩어리 표현' : 'Chunk'}</span>
          </p>
        )}
        <ol className="mt-3 space-y-3">
          {shown.map((s) => {
            const own = listChunks.filter((c) => c.sentenceId === s.id);
            if (onlySelected && !s.selected) return null;
            return (
              <li key={s.id} className="rounded-2xl border border-line p-3.5" data-testid="content-sentence">
                <div className="flex items-start gap-2.5">
                  <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-brand text-sm font-bold text-white">{s.aiNumber ?? s.order}</span>
                  <div className="min-w-0 flex-1">
                    <p className="en text-[17px] font-semibold leading-snug text-ink">
                      <HighlightedText text={s.english} cores={coreParts} chunks={own.map((c) => extraViewOf(c, exprById.get(c.expressionId)).parts)} />
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
              </li>
            );
          })}
        </ol>
      </Card>
    </div>
  );
}

/** 활용형으로 묶인 예전 Chunk — 고름 표시는 그대로 보이고 바꿀 수 있게 */
function VariantToggle({ item, text }: { item: LearningItem; text: string }) {
  return (
    <button
      type="button"
      aria-pressed={!!item.selected}
      onClick={() => void contentStore.setChunkSelected(item.id, !item.selected)}
      data-testid="select-variant"
      title={text ? `기존 Chunk: ${text}` : '기존 Chunk'}
      className={`inline-flex h-6 items-center rounded-full px-2 text-[11px] font-bold ${item.selected ? 'bg-ok-soft text-ok' : 'border border-line bg-surface text-muted hover:text-ink'}`}
    >
      {item.selected ? '✓ 고름' : '+ 고르기'}
    </button>
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

function ChunkRow({ item, expression, sentence, number, extra }: { item: LearningItem; expression: Expression | undefined; sentence?: KeySentence; number?: number; extra: boolean }) {
  const v = extraViewOf(item, expression);
  return (
    <li className="rounded-xl bg-canvas p-3" data-testid="content-chunk">
      <div className="flex flex-wrap items-center gap-2">
        <span className="en rounded bg-brand-soft px-1.5 font-semibold text-ink underline decoration-dashed decoration-brand underline-offset-4" data-testid="chunk-base">
          {v.base || '(Chunk)'}
        </span>
        {expression?.meaningKo && <span className="text-sm text-muted">{expression.meaningKo}</span>}
        {extra && <Badge tone="info">AI 추가</Badge>}
        <span className="ml-auto">
          <SelectToggle on={!!item.selected} label="암기할 Chunk" testId="select-chunk" onChange={(val) => void contentStore.setChunkSelected(item.id, val)} />
        </span>
      </div>
      {v.surface && (
        <p className="mt-1.5 text-sm" data-testid="chunk-origin">
          <span className="text-xs font-semibold text-subtle">원문 표현 · </span>
          <span className="en text-muted">{v.surface}</span>
          <span className="mx-1 text-subtle">→</span>
          <span className="text-xs font-semibold text-subtle">기본 Chunk </span>
          <span className="en font-semibold text-ink">{v.base}</span>
          {v.dropped.length > 0 && (
            <span className="ml-1 text-xs text-subtle">
              (뺀 말: <span className="en">{v.dropped.join(' ')}</span> — 정도만 강조하는 말{v.source === 'app' ? ' · 예전 자료라 화면에서만 정리' : ''})
            </span>
          )}
        </p>
      )}
      {(v.pattern || v.swaps.length > 0) && (
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm" data-testid="chunk-pattern">
          <span className="text-xs font-semibold text-subtle">바꿔 쓰기 · </span>
          {v.pattern && <span className="rounded-md border border-line bg-surface px-1.5 font-semibold text-ink">{v.pattern}</span>}
          {v.swaps.map((x) => (
            <span key={x} className="en rounded-md bg-surface px-1.5 text-muted ring-1 ring-line">
              {x}
            </span>
          ))}
        </p>
      )}
      {item.chunk?.nuance && <p className="mt-1 text-sm"><span className="text-xs font-semibold text-subtle">뉘앙스 · </span>{item.chunk.nuance}</p>}
      {sentence && (
        <p className="mt-1 text-sm text-muted" data-testid="chunk-context">
          <span className="text-xs font-semibold text-subtle">문맥 {number ?? ''}번 · </span>
          <span className="en"><HighlightedText text={sentence.english} cores={[]} chunks={[v.parts]} /></span>
        </p>
      )}
      <ChunkDetails item={item} />
    </li>
  );
}
