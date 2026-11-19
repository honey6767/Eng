import type { DialogueLine, KeySentence } from '@/types/models';
import { CATEGORY_LABEL, lineText, type UsefulModel, type UsefulView } from '@/services/phrases/usefulPhrases';

/**
 * 대화문 표시 (STEP 1 전체 공개 형태의 읽기 화면)
 * - 화자 A는 왼쪽, B는 오른쪽 말풍선으로 구분
 * - ★ 핵심 Chunk(강사가 가르친 표현)·핵심 문장은 노란 형광펜, ✨ 유용한 회화 표현은 하늘색 형광펜(누르면 뜻)
 */
export function DialogueView({
  lines,
  sentences,
  showKorean = true,
  showEnglish = true,
  highlightKeys = true,
  useful,
  openRef,
  onOpen,
}: {
  lines: DialogueLine[];
  sentences: KeySentence[];
  showKorean?: boolean;
  showEnglish?: boolean;
  highlightKeys?: boolean;
  /** ✨ 유용한 회화 표현 (원문 출처 + 대화문 출처) — 핵심 Chunk와 다른 색 */
  useful?: UsefulModel;
  /** 열린 ✨ 상세 (ref:lineId) */
  openRef?: string | null;
  onOpen?: (key: string | null) => void;
}) {
  const orderById = new Map(sentences.map((s) => [s.id, s.aiNumber ?? s.order]));
  const usefulRefs = new Set(useful?.items.map((x) => x.ref) ?? []);
  const itemByRef = new Map(useful?.items.map((x) => [x.ref, x]) ?? []);
  const jump = (lineId: string) => document.getElementById(`dl-${lineId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  return (
    <ol className="flex flex-col gap-3">
      {lines.map((line) => {
        const isA = line.speaker === 'A';
        const pieces = linePieces(line, useful, usefulRefs);
        const open = openRef && openRef.endsWith(`:${line.id}`) ? itemByRef.get(openRef.slice(0, openRef.length - line.id.length - 1)) : undefined;
        return (
          <li key={line.id} id={`dl-${line.id}`} className={`flex flex-col gap-1.5 ${isA ? 'items-start' : 'items-end'}`}>
            <div className={`flex w-full items-start gap-2.5 ${isA ? '' : 'flex-row-reverse'}`}>
              <span
                className={`mt-1 grid size-8 shrink-0 place-items-center rounded-full text-sm font-bold ${isA ? 'bg-brand text-white' : 'bg-ink/80 text-white'}`}
                aria-label={`화자 ${line.speaker}`}
              >
                {line.speaker}
              </span>
              <div className={`max-w-[85%] rounded-2xl px-4 py-3 sm:max-w-[75%] ${isA ? 'rounded-tl-md bg-brand-soft' : 'rounded-tr-md border border-line bg-surface'}`}>
                {line.sourceSentenceId && orderById.get(line.sourceSentenceId) !== undefined && (
                  <p className="mb-1 text-[11px] font-bold text-brand" data-testid="line-source">
                    원문 {orderById.get(line.sourceSentenceId)}번 문장
                  </p>
                )}
                {showEnglish && (
                  <p className="en text-[16.5px] leading-relaxed text-ink">
                    {pieces.map((pc, i) => {
                      if (!pc.kind || !highlightKeys) return <span key={i}>{pc.text}</span>;
                      if (pc.kind === 'useful')
                        return (
                          <button
                            key={i}
                            type="button"
                            onClick={() => onOpen?.(openRef === `${pc.ref}:${line.id}` ? null : `${pc.ref}:${line.id}`)}
                            className="rounded bg-info-soft px-0.5 text-left text-ink underline decoration-info/50 decoration-dotted underline-offset-4 [box-decoration-break:clone]"
                            title="✨ 유용한 회화 표현 — 눌러서 뜻 보기"
                            data-testid="useful-mark"
                          >
                            {pc.text}
                          </button>
                        );
                      const n = pc.kind === 'sentence' && pc.ref ? orderById.get(pc.ref) : undefined;
                      return (
                        <span key={i}>
                          <mark className="rounded bg-key px-0.5 text-ink [box-decoration-break:clone]" title={pc.kind === 'core' ? '★ 핵심 Chunk' : n ? `핵심 문장 ${n}` : '핵심 문장'} data-testid={pc.kind === 'core' ? 'core-mark' : undefined}>
                            {pc.text}
                          </mark>
                          {n && (
                            <sup className="ml-0.5 text-[10px] font-bold text-key-ink" aria-label={`핵심 문장 ${n}`}>
                              {n}
                            </sup>
                          )}
                        </span>
                      );
                    })}
                  </p>
                )}
                {showKorean && <p className={`text-[14.5px] leading-relaxed text-muted ${showEnglish ? 'mt-1.5' : ''}`}>{line.korean}</p>}
                {line.segments.some((s) => s.modification) && (
                  <ul className="mt-2 space-y-1 border-t border-black/5 pt-2 text-xs text-warn">
                    {line.segments
                      .filter((s) => s.modification)
                      .map((s, i) => (
                        <li key={i}>
                          원문 수정: “{s.modification!.originalText}” → {s.modification!.reason}
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            </div>
            {open && <UsefulDetail item={open} lineId={line.id} lines={lines} onJump={jump} onClose={() => onOpen?.(null)} />}
          </li>
        );
      })}
    </ol>
  );
}

type Piece = { text: string; kind: 'core' | 'sentence' | 'useful' | null; ref?: string };

/** 줄을 핵심 Chunk(노랑) · ✨(하늘색) · 나머지로 나눈다 */
function linePieces(line: DialogueLine, useful: UsefulModel | undefined, usefulRefs: Set<string>): Piece[] {
  const en = lineText(line);
  const spans: { s: number; e: number; kind: Piece['kind']; ref?: string }[] = [];
  let pos = 0;
  line.segments.forEach((seg, i) => {
    if (i > 0) pos += 1;
    if (seg.kind === 'key' && !(seg.learningItemId && usefulRefs.has(seg.learningItemId)))
      spans.push({ s: pos, e: pos + seg.text.length, kind: seg.learningItemId ? 'core' : 'sentence', ref: seg.learningItemId ?? seg.keySentenceId });
    pos += seg.text.length;
  });
  for (const u of useful?.spans.get(line.id) ?? []) if (!spans.some((x) => u.s < x.e && x.s < u.e)) spans.push({ s: u.s, e: u.e, kind: 'useful', ref: u.ref });
  spans.sort((a, b) => a.s - b.s);
  const out: Piece[] = [];
  let at = 0;
  for (const sp of spans) {
    if (sp.s > at) out.push({ text: en.slice(at, sp.s), kind: null });
    out.push({ text: en.slice(sp.s, sp.e), kind: sp.kind, ref: sp.ref });
    at = sp.e;
  }
  if (at < en.length) out.push({ text: en.slice(at), kind: null });
  return out;
}

/** ✨ 상세 — 기본형 ↔ 실제 형태, 뜻·뉘앙스·사용 상황, 교체 예시, 같은 표현이 나오는 다른 줄 */
function UsefulDetail({ item, lineId, lines, onJump, onClose }: { item: UsefulView; lineId: string; lines: DialogueLine[]; onJump: (id: string) => void; onClose: () => void }) {
  const others = item.lineIds.filter((id) => id !== lineId);
  const no = (id: string) => lines.findIndex((l) => l.id === id) + 1;
  return (
    <div className="w-full max-w-xl rounded-2xl border border-info/30 bg-surface p-3.5 text-sm shadow-sm" data-testid="useful-detail">
      <div className="flex items-start justify-between gap-2">
        <p className="font-bold">
          ✨ <span className="en">{item.base}</span>
          {item.category && <span className="ml-2 rounded bg-info-soft px-1.5 py-0.5 text-[11px] font-semibold text-info">{CATEGORY_LABEL[item.category]}</span>}
        </p>
        <button type="button" className="text-xs text-muted" onClick={onClose}>
          닫기
        </button>
      </div>
      {item.forms.some((f) => f.toLowerCase() !== item.base.toLowerCase()) && (
        <p className="mt-1 text-xs text-muted" data-testid="useful-forms">
          기본형 <span className="en font-semibold text-ink">{item.base}</span> → 대화문 속 형태 <span className="en text-ink">{item.forms.join(' / ')}</span>
        </p>
      )}
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {item.meaningKo && (
          <>
            <dt className="text-xs font-semibold text-subtle">뜻</dt>
            <dd>{item.meaningKo}</dd>
          </>
        )}
        {item.nuance && (
          <>
            <dt className="text-xs font-semibold text-subtle">문맥상 뉘앙스</dt>
            <dd>{item.nuance}</dd>
          </>
        )}
        {item.usage && (
          <>
            <dt className="text-xs font-semibold text-subtle">사용 상황</dt>
            <dd>{item.usage}</dd>
          </>
        )}
      </dl>
      {item.pattern && (
        <div className="mt-2" data-testid="useful-pattern">
          <p className="text-xs font-semibold text-subtle">
            교체 패턴 · <span className="en text-ink">{item.pattern.pattern}</span>
            {item.pattern.slotNote && <span className="ml-1 font-normal">({item.pattern.slotNote})</span>}
          </p>
          <ul className="mt-1 space-y-0.5">
            {item.pattern.examples.map((x) => (
              <li key={x.en}>
                <span className="en text-ink">{x.en}</span> <span className="text-muted">— {x.ko}</span>
                {x.note && <span className="block pl-3 text-xs text-subtle">뜻 차이: {x.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {others.length > 0 && (
        <p className="mt-2 text-xs text-muted" data-testid="useful-occurrences">
          이 대화문에서 {item.lineIds.length}번 나와요:{' '}
          {others.map((id) => (
            <button key={id} type="button" className="mr-1.5 text-brand underline underline-offset-2" onClick={() => onJump(id)}>
              {no(id)}번째 줄
            </button>
          ))}
        </p>
      )}
      <p className="mt-2 text-[11px] text-subtle">{item.source === 'sentence' ? '원문 문장에서 찾은 표현' : '대화문에서 찾은 표현'} · 강사가 가르친 핵심 Chunk와는 따로 관리해요</p>
    </div>
  );
}
