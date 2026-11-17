import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveData } from '@/hooks/useLiveData';
import { ask, checkTurn, isInFlight, qaDeps, qaStore, retryTurn, startSession, type QaChunkRef, type QaSession, type QaTurn } from '@/services/qa';
import type { TaskProgress } from '@/services/ai/taskRunner';
import { ASK_LIMITS } from '@/types/aiApi';
import { Button } from '@/components/ui/Button';
import { AskAnswerView } from './AskAnswerView';

const EXAMPLES = ['비슷한 다른 표현도 자연스러워?', '이 단어 대신 다른 단어를 넣어도 돼?', '원어민은 어떤 상황에서 써?', '이 Chunk로 다른 예문을 만들어 줘.'];

/**
 * Chunk 카드 아래 AI 질문창 — 사용자가 '질문하기'를 누를 때만 요청한다 (열기·새로고침으로는 요청 없음).
 * 같은 Chunk의 대화는 세션으로 묶고, 후속 질문은 그 세션 안에서만 이어진다.
 */
export function ChunkQa({ chunk, sessionId: fixedSessionId, defaultOpen = false }: { chunk?: QaChunkRef; sessionId?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<TaskProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [forceNew, setForceNew] = useState(false);
  const data = useLiveData(async () => {
    const sessions = fixedSessionId ? [await qaStore.getSession(fixedSessionId)].filter((x): x is QaSession => !!x) : chunk ? await qaStore.sessionsOfChunk(chunk.chunkKey) : [];
    const session = forceNew ? null : (sessions[0] ?? null);
    const turns = session ? await qaStore.turnsOf(session.id) : [];
    const total = sessions.reduce((n, s) => n + s.turnCount, 0);
    return { session, turns, total, sessionCount: sessions.length };
  }, [chunk?.chunkKey, fixedSessionId, forceNew]);

  const key = chunk?.chunkKey ?? fixedSessionId ?? '';
  const run = async (fn: () => Promise<{ ok: boolean; code?: string; message?: string }>) => {
    setBusy(true);
    setNotice(null);
    try {
      const out = await fn();
      if (!out.ok && out.message) setNotice(out.message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const submit = () =>
    run(async () => {
      let session = data?.session ?? null;
      if (!session) {
        if (!chunk) return { ok: false, message: '대화를 찾지 못했어요.' };
        session = await startSession(qaDeps, chunk);
        setForceNew(false);
      }
      const out = await ask(qaDeps, session.id, text, setProgress);
      if (out.ok || (out.turn && out.code !== 'busy')) setText('');
      return out;
    });

  if (!open)
    return (
      <button type="button" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand underline-offset-2 hover:underline" onClick={() => setOpen(true)} data-testid="qa-open">
        AI에게 질문하기{data && data.total > 0 ? ` · 질문 기록 ${data.total}개` : ''}
      </button>
    );

  const turns = data?.turns ?? [];
  const pending = turns.find((t) => t.status === 'pending');
  return (
    <div className="mt-2 rounded-xl border border-line bg-surface p-3" data-testid="qa-box" data-chunk={key}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold text-ink">
          AI에게 질문하기{chunk ? <span className="en ml-1 font-semibold text-brand">“{chunk.chunkLabel}”</span> : null}
        </p>
        <div className="flex items-center gap-3 text-xs">
          {chunk && turns.length > 0 && (
            <button type="button" className="text-muted underline underline-offset-2" onClick={() => setForceNew(true)} data-testid="qa-new-session">
              새 대화 시작
            </button>
          )}
          <Link to={`/ai-questions${chunk ? `?chunk=${encodeURIComponent(chunk.chunkKey)}` : ''}`} className="text-brand underline underline-offset-2">
            질문 기록
          </Link>
          {!defaultOpen && (
            <button type="button" className="text-muted" onClick={() => setOpen(false)} aria-label="질문창 닫기">
              닫기
            </button>
          )}
        </div>
      </div>

      {turns.length > 0 && (
        <ol className="mb-3 space-y-3" data-testid="qa-turns">
          {turns.map((t) => (
            <TurnView key={t.id} t={t} busy={busy} onCheck={() => run(() => checkTurn(qaDeps, t.id, setProgress))} onRetry={() => run(() => retryTurn(qaDeps, t.id, setProgress))} />
          ))}
        </ol>
      )}

      {turns.length === 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {EXAMPLES.map((q) => (
            <button key={q} type="button" className="rounded-full border border-line px-2.5 py-1 text-xs text-muted hover:text-ink" onClick={() => setText(q)}>
              {q}
            </button>
          ))}
        </div>
      )}

      <label className="sr-only" htmlFor={`qa-input-${key}`}>
        질문
      </label>
      <textarea
        id={`qa-input-${key}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={ASK_LIMITS.questionChars}
        rows={2}
        placeholder={turns.length ? '이어서 질문하기 (같은 Chunk 대화를 이어받아요)' : '궁금한 점을 적어 주세요. 예: look sleepy도 자연스러워?'}
        className="w-full resize-y rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm"
        data-testid="qa-input"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || !!pending || text.trim().length < ASK_LIMITS.minQuestionChars} onClick={() => void submit()} data-testid="qa-send">
          {busy ? '보내는 중…' : turns.length ? '이어서 질문하기' : 'AI에게 질문하기'}
        </Button>
        {progress && (
          <span className="text-xs text-brand" role="status" data-testid="qa-progress">
            {progress.phase === 'sending' ? '질문 보내는 중…' : progress.phase === 'processing' ? (progress.note ?? 'AI가 답변을 만드는 중…') : ''}
          </span>
        )}
        {pending && !busy && <span className="text-xs text-warn">앞 질문의 답변을 먼저 확인해 주세요.</span>}
      </div>
      {notice && (
        <p className="mt-1.5 text-xs text-danger" role="alert" data-testid="qa-notice">
          {notice}
        </p>
      )}
      <p className="mt-1.5 text-[11px] text-subtle">질문은 보낼 때만 AI에 전달돼요. 질문과 답변은 이 기기에 자동 저장돼요.</p>
    </div>
  );
}

function TurnView({ t, busy, onCheck, onRetry }: { t: QaTurn; busy: boolean; onCheck: () => void; onRetry: () => void }) {
  return (
    <li className="space-y-1.5" data-testid="qa-turn" data-status={t.status}>
      <p className="rounded-xl bg-brand-soft px-3 py-2 text-sm text-ink" data-testid="qa-question">
        <span className="mr-1 text-xs font-bold text-brand">Q{t.turn}</span>
        {t.question}
        <span className="ml-2 text-[11px] text-subtle">{new Date(t.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
      </p>
      {t.status === 'answered' && t.answer && (
        <div className="rounded-xl bg-canvas px-3 py-2">
          <AskAnswerView question={t.question} answer={t.answer} />
        </div>
      )}
      {t.status === 'pending' && (
        <div className="rounded-xl bg-canvas px-3 py-2 text-sm" data-testid="qa-pending">
          {busy || isInFlight(t.id) ? (
            <span className="text-brand">답변을 기다리는 중…</span>
          ) : (
            <>
              <span className="text-muted">답변을 아직 받지 못했어요. </span>
              <Button size="sm" variant="soft" onClick={onCheck} data-testid="qa-check">
                답변 확인
              </Button>
              <span className="ml-2 text-[11px] text-subtle">같은 질문으로 결과만 확인해요 (새로 요청하지 않음)</span>
            </>
          )}
        </div>
      )}
      {t.status === 'failed' && (
        <div className="rounded-xl bg-danger/5 px-3 py-2 text-sm" data-testid="qa-failed">
          <p className="font-semibold text-danger">
            답변을 받지 못했어요{t.error?.httpStatus ? ` · HTTP ${t.error.httpStatus}` : ''}{t.error?.code ? ` · ${t.error.code}` : ''}
          </p>
          {t.error?.message && <p className="mt-0.5 text-xs text-muted">{t.error.message}</p>}
          <Button size="sm" variant="secondary" className="mt-1.5" disabled={busy} onClick={onRetry} data-testid="qa-retry">
            다시 시도
          </Button>
          <span className="ml-2 text-[11px] text-subtle">자동으로 다시 보내지 않아요</span>
        </div>
      )}
    </li>
  );
}
