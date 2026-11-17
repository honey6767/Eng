import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLiveData } from '@/hooks/useLiveData';
import { qaStore, type QaSession, type QaTurn } from '@/services/qa';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Loading } from '@/components/ui/Loading';
import { ChunkQa } from '@/components/qa/ChunkQa';

/**
 * AI 질문 기록 — Chunk별 질문과 답변 (이 기기의 별도 저장소, 학습 기록과 따로).
 * 최신 질문 순 · Day/Chunk 필터 · 검색 · 전체 보기 · 이어서 질문 · 답변 복사. 이 화면은 AI를 부르지 않는다(질문을 보낼 때만).
 */
export function AiQuestionsPage() {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const day = params.get('day') ?? '';
  const chunk = params.get('chunk') ?? '';
  const data = useLiveData(async () => ({ sessions: await qaStore.allSessions(), turns: await qaStore.allTurns() }), []);

  const view = useMemo(() => {
    if (!data) return null;
    const turnsBy = new Map<string, QaTurn[]>();
    for (const t of data.turns) turnsBy.set(t.sessionId, [...(turnsBy.get(t.sessionId) ?? []), t]);
    const latestAt = (s: QaSession) => turnsBy.get(s.id)?.[0]?.createdAt ?? s.updatedAt;
    const days = [...new Set(data.sessions.map((s) => s.dayNumber).filter((d): d is number => d !== null))].sort((a, b) => a - b);
    const chunks = [...new Map(data.sessions.filter((s) => !day || String(s.dayNumber ?? '') === day).map((s) => [s.chunkKey, s.chunkLabel])).entries()];
    const q = query.trim().toLowerCase();
    const sessions = data.sessions
      .filter((s) => (turnsBy.get(s.id)?.length ?? 0) > 0)
      .filter((s) => !day || (day === 'none' ? s.dayNumber === null : String(s.dayNumber) === day))
      .filter((s) => !chunk || s.chunkKey === chunk)
      .filter((s) => !q || s.chunkLabel.toLowerCase().includes(q) || (turnsBy.get(s.id) ?? []).some((t) => t.question.toLowerCase().includes(q) || (t.answer?.answer ?? '').toLowerCase().includes(q)))
      .sort((a, b) => latestAt(b).localeCompare(latestAt(a)));
    return { turnsBy, days, chunks, sessions, total: data.turns.length };
  }, [data, day, chunk, query]);

  if (!view) return <Loading />;
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k === 'day') next.delete('chunk');
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-4" data-testid="ai-questions-page">
      <PageHeader title="AI 질문 기록" description="Chunk를 공부하다 AI에게 물어본 질문과 답변이에요. 이 기기에 저장돼요." />

      <Card className="flex flex-wrap items-end gap-3 p-3.5">
        <label className="flex flex-col gap-1 text-xs font-semibold text-subtle">
          Day
          <select className="h-10 min-w-28 rounded-xl border border-line-strong bg-surface px-2 text-sm text-ink" value={day} onChange={(e) => set('day', e.target.value)} data-testid="qa-filter-day">
            <option value="">전체</option>
            {view.days.map((d) => (
              <option key={d} value={String(d)}>
                Day {d}
              </option>
            ))}
            <option value="none">일반 영상</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-subtle">
          Chunk
          <select className="h-10 min-w-40 max-w-64 rounded-xl border border-line-strong bg-surface px-2 text-sm text-ink" value={chunk} onChange={(e) => set('chunk', e.target.value)} data-testid="qa-filter-chunk">
            <option value="">전체</option>
            {view.chunks.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs font-semibold text-subtle">
          검색
          <input className="h-10 rounded-xl border border-line-strong bg-surface px-3 text-sm text-ink" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="질문·답변·Chunk 검색" data-testid="qa-search" />
        </label>
        <p className="text-xs text-muted" data-testid="qa-count">
          대화 {view.sessions.length}개 · 전체 질문 {view.total}개
        </p>
      </Card>

      {view.sessions.length === 0 ? (
        <Card className="p-5 text-sm text-muted" data-testid="qa-empty">
          {view.total === 0 ? '아직 질문 기록이 없어요. 영상의 ‘원문·Chunk’ 탭에서 Chunk 카드의 ‘AI에게 질문하기’를 눌러 보세요.' : '조건에 맞는 질문이 없어요.'}
        </Card>
      ) : (
        <ul className="space-y-3">
          {view.sessions.map((s) => {
            const turns = view.turnsBy.get(s.id) ?? [];
            const latest = turns[0];
            const open = openId === s.id;
            return (
              <li key={s.id}>
                <Card className="p-3.5" data-testid="qa-session">
                  <button type="button" className="block w-full text-left" onClick={() => setOpenId(open ? null : s.id)} aria-expanded={open} data-testid="qa-session-toggle">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="en font-bold text-ink">{s.chunkLabel}</span>
                      {s.role === 'core' && <Badge tone="key">★ 핵심 Chunk</Badge>}
                      {s.role === 'extra' && <Badge tone="info">✨ 유용한 회화 표현</Badge>}
                      <Badge tone={s.dayNumber ? 'brand' : 'neutral'}>{s.dayNumber ? `Day ${s.dayNumber}` : '일반 영상'}</Badge>
                      <span className="text-xs text-subtle">질문 {turns.length}개</span>
                      <span className="ml-auto text-xs text-subtle">{new Date(latest.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <p className="mt-1 truncate text-sm text-muted">
                      <b className="text-brand">Q.</b> {latest.question}
                      {latest.status !== 'answered' && <span className="ml-1 text-xs text-warn">({latest.status === 'pending' ? '답변 대기' : '실패'})</span>}
                    </p>
                  </button>
                  {open && (
                    <div className="mt-2">
                      <p className="mb-1 text-xs text-subtle">
                        출처: {s.videoTitle}
                        {s.videoId && (
                          <Link to={`/videos/${s.videoId}`} className="ml-2 text-brand underline underline-offset-2">
                            영상으로 가기
                          </Link>
                        )}
                      </p>
                      <ChunkQa sessionId={s.id} defaultOpen />
                    </div>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
