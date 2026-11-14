import { useMemo, useState } from 'react';
import { spanFromTokens, tokenize, type TextSpan } from '@/utils/expressionSpan';

/**
 * 문장에서 단어 범위를 손가락으로 고르는 도구 (아이패드에서 텍스트 드래그 선택이 불편하므로).
 * 첫 단어 → 마지막 단어 순서로 누르면 그 사이가 선택된다. 원문 글자는 바꾸지 않는다.
 */
export function TokenRangePicker({
  text,
  value,
  onChange,
  label,
}: {
  text: string;
  value: TextSpan | null;
  onChange: (span: TextSpan | null) => void;
  label: string;
}) {
  const tokens = useMemo(() => tokenize(text), [text]);
  // 첫 단어만 누른 상태
  const [anchor, setAnchor] = useState<number | null>(null);

  const inRange = (i: number) => {
    if (anchor != null) return i === anchor;
    return value != null && tokens[i].start >= value.start && tokens[i].end <= value.end;
  };

  const tap = (i: number) => {
    if (anchor == null) {
      setAnchor(i);
      onChange(spanFromTokens(tokens, i, i));
    } else {
      onChange(spanFromTokens(tokens, anchor, i));
      setAnchor(null);
    }
  };

  return (
    <div>
      <p className="mb-1.5 text-xs text-muted">
        {label} {anchor != null ? '· 이제 마지막 단어를 누르세요 (한 단어면 같은 단어를 한 번 더)' : '· 첫 단어를 누르세요'}
      </p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
        {tokens.map((t, i) => (
          <button
            key={`${t.start}-${i}`}
            type="button"
            onClick={() => tap(i)}
            aria-pressed={inRange(i)}
            className={`en min-h-9 rounded-lg border px-2.5 text-[15px] transition-colors ${
              inRange(i) ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface text-ink hover:bg-canvas'
            }`}
          >
            {t.text}
          </button>
        ))}
      </div>
      {value && anchor == null && (
        <p className="mt-2 text-sm">
          선택: <span className="en rounded bg-key px-1 font-semibold text-key-ink">{text.slice(value.start, value.end)}</span>{' '}
          <button type="button" className="ml-1 text-xs font-semibold text-muted underline" onClick={() => onChange(null)}>
            선택 지우기
          </button>
        </p>
      )}
    </div>
  );
}
