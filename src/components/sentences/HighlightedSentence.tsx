import type { Expression, KeySentence } from '@/types/models';
import { resolveSpans } from '@/services/keySentenceService';
import { splitBySpans } from '@/utils/expressionSpan';

/** 핵심 문장 원문에 핵심 표현 위치를 강조해서 보여 준다 (원문 글자는 그대로) */
export function HighlightedSentence({
  sentence,
  expressions,
  className = '',
}: {
  sentence: KeySentence;
  expressions: Pick<Expression, 'id' | 'text'>[];
  className?: string;
}) {
  const spans = resolveSpans(sentence, expressions);
  const parts = splitBySpans(sentence.english, spans);
  return (
    <p className={`en ${className}`} data-testid="key-sentence-english">
      {parts.map((p, i) =>
        p.span ? (
          <mark
            key={i}
            className={`rounded bg-key px-0.5 text-key-ink ${p.span.source === 'auto' ? 'underline decoration-dotted underline-offset-4' : ''}`}
            title={p.span.source === 'auto' ? '자동으로 찾은 위치' : '지정한 위치'}
          >
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  );
}
