import { useMemo, useState } from 'react';
import type { Dialogue } from '@/types/models';
import type { AiUsageResponse } from '@/types/aiApi';
import { useLiveData } from '@/hooks/useLiveData';
import { qaDeps, qaStore } from '@/services/qa';
import { fetchAiUsage } from '@/services/integrations/aiClient';
import { analyzeDialogue, canAnalyze } from '@/services/phrases/phraseService';
import { usefulModelOf, type UsefulModel } from '@/services/phrases/usefulPhrases';
import { Button } from '@/components/ui/Button';

/** 대화문의 ✨ 목록 (새 대화문은 저장된 phrases, 기존 대화문은 분석 결과) + 분석 기록 */
export function useUseful(d: Dialogue | null | undefined) {
  const data = useLiveData(async () => (d ? { set: (await qaStore.getPhraseSet(d.id)) ?? null, attempts: await qaStore.attemptsOf(d.id) } : null), [d?.id]);
  const model = useMemo<UsefulModel | undefined>(() => (d ? usefulModelOf(d, data?.set?.phrases ?? null) : undefined), [d, data?.set]);
  return { model, set: data?.set ?? null, attempts: data?.attempts ?? [], loaded: data !== undefined };
}

/**
 * ★ 핵심 Chunk · ✨ 유용한 회화 표현 개수와 목록, 기존 대화문의 ✨ 분석(버튼을 눌러 확인한 뒤에만 Gemini 1회)
 */
export function UsefulPanel({ dialogue, useful, onOpen }: { dialogue: Dialogue; useful: ReturnType<typeof useUseful>; onOpen: (key: string) => void }) {
  const [confirm, setConfirm] = useState<{ usage: AiUsageResponse | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const coreCount = (dialogue.chunkUsages ?? []).filter((u) => u.kind !== 'extra').length;
  const items = useful.model?.items ?? [];
  const analyzable = canAnalyze(dialogue) && useful.loaded && !useful.set;
  const failed = useful.attempts.filter((a) => a.status === 'failed');

  const ask = async () => {
    setNotice(null);
    setBusy(true);
    const usage = await fetchAiUsage();
    setBusy(false);
    setConfirm({ usage });
  };
  const run = async () => {
    setConfirm(null);
    setBusy(true);
    try {
      const out = await analyzeDialogue(qaDeps, dialogue);
      setNotice(out.ok ? (out.count ? `✨ 유용한 회화 표현 ${out.count}개를 찾았어요.` : '이 대화문에서는 추가로 표시할 표현을 찾지 못했어요.') : `분석하지 못했어요 · ${out.httpStatus ? `HTTP ${out.httpStatus} · ` : ''}${out.code}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 text-sm" data-testid="useful-panel">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted" data-testid="useful-counts">
        <span>
          <mark className="rounded bg-key px-1 text-ink">★ 핵심 Chunk</mark> {coreCount}개
        </span>
        <span>
          <mark className="rounded bg-info-soft px-1 text-ink">✨ 유용한 회화 표현</mark> {items.length}개
        </span>
      </p>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid="useful-list">
          {items.map((x) => (
            <button key={x.ref} type="button" className="en rounded-full bg-info-soft px-2.5 py-1 text-xs font-semibold text-ink hover:ring-1 hover:ring-info/40" onClick={() => onOpen(`${x.ref}:${x.lineIds[0]}`)}>
              ✨ {x.base}
            </button>
          ))}
        </div>
      )}
      {useful.set && (
        <p className="text-xs text-subtle" data-testid="useful-analyzed">
          ✨ 분석 완료 ({new Date(useful.set.createdAt).toLocaleDateString('ko-KR')}) · 같은 대화문은 다시 분석하지 않아요
        </p>
      )}
      {analyzable && !confirm && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="soft" disabled={busy} onClick={() => void ask()} data-testid="useful-analyze">
            {busy ? '확인 중…' : failed.length ? '✨ 유용한 표현 다시 찾기' : '✨ 유용한 표현 찾기'}
          </Button>
          <span className="text-xs text-subtle">누르면 사용량을 먼저 보여 드려요. 확인해야 AI를 불러요.</span>
        </div>
      )}
      {confirm && (
        <div className="rounded-xl border border-line bg-canvas p-3" data-testid="useful-confirm">
          <p className="font-semibold text-ink">이 대화문을 분석하면 Gemini 요청 1회가 필요해요.</p>
          {confirm.usage ? (
            <p className="mt-1 text-xs text-muted" data-testid="useful-usage">
              오늘 사용 {confirm.usage.requests}/{confirm.usage.dailyRequests}회 (표현 분석 {confirm.usage.phrases.used}회) · 남은 요청{' '}
              <b className="text-ink">{Math.max(0, confirm.usage.dailyRequests - confirm.usage.requests)}회</b>
            </p>
          ) : (
            <p className="mt-1 text-xs text-warn" data-testid="useful-usage">오늘 사용량을 확인하지 못했어요. 그래도 진행하면 요청 1회를 써요.</p>
          )}
          <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={!!confirm.usage && confirm.usage.requests >= confirm.usage.dailyRequests} onClick={() => void run()} data-testid="useful-confirm-run">
              분석하기 (요청 1회)
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
              취소
            </Button>
          </div>
        </div>
      )}
      {busy && !confirm && <p className="text-xs text-brand" role="status">분석 중이에요…</p>}
      {notice && (
        <p className="text-xs text-muted" role="status" data-testid="useful-notice">
          {notice}
        </p>
      )}
      {useful.attempts.length > 0 && (
        <details className="text-xs text-muted" data-testid="useful-attempts">
          <summary className="cursor-pointer">분석 기록 {useful.attempts.length}건</summary>
          <ul className="mt-1 space-y-0.5">
            {useful.attempts.map((a) => (
              <li key={a.id}>
                {new Date(a.at).toLocaleString('ko-KR')} · {a.status === 'succeeded' ? `성공 (${a.count}개)` : `실패${a.error?.httpStatus ? ` · HTTP ${a.error.httpStatus}` : ''} · ${a.error?.code ?? ''} · ${a.error?.message ?? ''}`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
