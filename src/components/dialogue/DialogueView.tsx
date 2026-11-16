import type { DialogueLine, KeySentence } from '@/types/models';

/**
 * 대화문 표시 (STEP 1 전체 공개 형태의 읽기 화면)
 * - 화자 A는 왼쪽, B는 오른쪽 말풍선으로 구분
 * - 핵심 학습 문장은 노란 하이라이트 + 문장 번호, 연결 문장은 일반 텍스트
 */
export function DialogueView({
  lines,
  sentences,
  showKorean = true,
  showEnglish = true,
  highlightKeys = true,
}: {
  lines: DialogueLine[];
  sentences: KeySentence[];
  showKorean?: boolean;
  showEnglish?: boolean;
  highlightKeys?: boolean;
}) {
  const orderById = new Map(sentences.map((s) => [s.id, s.aiNumber ?? s.order]));

  return (
    <ol className="flex flex-col gap-3">
      {lines.map((line) => {
        const isA = line.speaker === 'A';
        return (
          <li key={line.id} className={`flex items-start gap-2.5 ${isA ? '' : 'flex-row-reverse'}`}>
            <span
              className={`mt-1 grid size-8 shrink-0 place-items-center rounded-full text-sm font-bold ${
                isA ? 'bg-brand text-white' : 'bg-ink/80 text-white'
              }`}
              aria-label={`화자 ${line.speaker}`}
            >
              {line.speaker}
            </span>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-3 sm:max-w-[75%] ${
                isA ? 'rounded-tl-md bg-brand-soft' : 'rounded-tr-md border border-line bg-surface'
              }`}
            >
              {line.sourceSentenceId && orderById.get(line.sourceSentenceId) !== undefined && (
                <p className="mb-1 text-[11px] font-bold text-brand" data-testid="line-source">
                  원문 {orderById.get(line.sourceSentenceId)}번 문장
                </p>
              )}
              {showEnglish && (
                <p className="en text-[16.5px] leading-relaxed text-ink">
                  {line.segments.map((seg, i) => {
                    const sep = i > 0 ? ' ' : '';
                    if (seg.kind === 'key' && highlightKeys) {
                      // 통합 대화문의 Chunk 부분에는 문장 번호를 붙이지 않는다
                      const n = seg.keySentenceId && !seg.learningItemId ? orderById.get(seg.keySentenceId) : undefined;
                      return (
                        <span key={i}>
                          {sep}
                          <mark
                            className="rounded bg-key px-0.5 text-ink [box-decoration-break:clone]"
                            title={seg.learningItemId ? '배운 Chunk' : n ? `핵심 문장 ${n}` : '핵심 문장'}
                          >
                            {seg.text}
                          </mark>
                          {n && (
                            <sup className="ml-0.5 text-[10px] font-bold text-key-ink" aria-label={`핵심 문장 ${n}`}>
                              {n}
                            </sup>
                          )}
                        </span>
                      );
                    }
                    return (
                      <span key={i}>
                        {sep}
                        {seg.text}
                      </span>
                    );
                  })}
                </p>
              )}
              {showKorean && (
                <p className={`text-[14.5px] leading-relaxed text-muted ${showEnglish ? 'mt-1.5' : ''}`}>{line.korean}</p>
              )}
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
          </li>
        );
      })}
    </ol>
  );
}
