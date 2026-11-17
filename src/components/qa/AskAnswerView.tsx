import { useState } from 'react';
import type { AskAnswer } from '@/services/qa';

const tone = (v: string) =>
  /^(가능|자연스러움)$/.test(v) ? 'bg-ok-soft text-ok' : /^(불가능|어색함)$/.test(v) ? 'bg-danger/10 text-danger' : 'bg-warn-soft text-ink';

export function answerAsText(question: string, a: AskAnswer): string {
  return [
    `Q. ${question}`,
    `A. ${a.answer}`,
    a.grammar.verdict && `1. 문법: ${a.grammar.verdict} — ${a.grammar.explain}`,
    a.natural.verdict && `2. 회화 자연스러움: ${a.natural.verdict} — ${a.natural.explain}`,
    a.nuance && `3. 의미·뉘앙스: ${a.nuance}`,
    a.examples.length && `4. 예문:\n${a.examples.map((e) => `- ${e.en} — ${e.ko}`).join('\n')}`,
    a.fromLecture && `강의에서 배운 내용: ${a.fromLecture}`,
    a.uncertain && `확실하지 않은 부분: ${a.uncertain}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** AI 답변 — 문법 / 회화 자연스러움 / 뉘앙스 / 예문을 나눠 보여 주고, 강의 내용과 AI 설명을 구분 */
export function AskAnswerView({ question, answer }: { question: string; answer: AskAnswer }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(answerAsText(question, answer));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="space-y-2 text-sm" data-testid="qa-answer">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-semibold text-subtle">AI 설명 — 강의에서 직접 다룬 내용이 아닐 수 있어요</p>
        <button type="button" onClick={() => void copy()} className="shrink-0 text-xs text-brand underline underline-offset-2" data-testid="qa-copy">
          {copied ? '복사했어요' : '답변 복사'}
        </button>
      </div>
      <p className="leading-relaxed text-ink">{answer.answer}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        {answer.grammar.verdict && (
          <>
            <dt className="text-xs font-semibold text-subtle">1. 문법</dt>
            <dd>
              <span className={`mr-1.5 rounded px-1.5 py-0.5 text-xs font-bold ${tone(answer.grammar.verdict)}`}>{answer.grammar.verdict}</span>
              {answer.grammar.explain}
            </dd>
          </>
        )}
        {answer.natural.verdict && (
          <>
            <dt className="text-xs font-semibold text-subtle">2. 회화 자연스러움</dt>
            <dd>
              <span className={`mr-1.5 rounded px-1.5 py-0.5 text-xs font-bold ${tone(answer.natural.verdict)}`}>{answer.natural.verdict}</span>
              {answer.natural.explain}
            </dd>
          </>
        )}
        {answer.nuance && (
          <>
            <dt className="text-xs font-semibold text-subtle">3. 의미·뉘앙스</dt>
            <dd>{answer.nuance}</dd>
          </>
        )}
        {answer.examples.length > 0 && (
          <>
            <dt className="text-xs font-semibold text-subtle">4. 예문</dt>
            <dd>
              <ul className="space-y-0.5">
                {answer.examples.map((e, i) => (
                  <li key={i}>
                    <span className="en text-ink">{e.en}</span> <span className="text-muted">— {e.ko}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>
      {answer.fromLecture && (
        <p className="rounded-lg bg-key/40 px-2.5 py-1.5" data-testid="qa-lecture">
          <span className="text-xs font-semibold text-subtle">강의에서 배운 내용 (저장된 강의 설명 기준) · </span>
          {answer.fromLecture}
        </p>
      )}
      {answer.uncertain && (
        <p className="text-xs text-muted">
          <span className="font-semibold">확실하지 않은 부분 · </span>
          {answer.uncertain}
        </p>
      )}
    </div>
  );
}
