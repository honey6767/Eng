import { useNavigate, useParams } from 'react-router-dom';
import { useState } from 'react';
import { extractionStore, repos } from '@/repositories';
import { useLiveData } from '@/hooks/useLiveData';
import { useToast } from '@/hooks/useToast';
import { extractionController } from '@/services/extraction';
import { applyDraft, rejectDraftAndRetry, skipDraft } from '@/services/extraction/manage';
import { assessDraft } from '@/services/extraction/applyDraft';
import type { ExtractionResult, ValidationIssue } from '@/services/extraction/validateResult';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Loading } from '@/components/ui/Loading';
import { issueText } from '@/components/extraction/labels';

const fmt = (s: number | null) => (s == null ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

/** 확인 필요 초안 검토 (B1-c) — 표현을 빼고 적용하거나, 버리고 다시 추출하거나, 건너뛴다 */
export function DraftReviewPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [offKey, setOffKey] = useState<Set<number>>(new Set());
  const [offChunk, setOffChunk] = useState<Set<number>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const data = useLiveData(async () => {
    const draft = await extractionStore.getDraft(id);
    return { draft, video: draft ? await repos.videos.get(draft.videoId) : undefined };
  }, [id]);
  if (!data) return <Loading />;
  const { draft, video } = data;
  if (!draft) return <p className="p-6 text-center text-muted">초안을 찾을 수 없어요.</p>;
  const result = draft.result as ExtractionResult;
  const issues = draft.validation as ValidationIssue[];
  const assessment = assessDraft(draft);
  const pending = draft.status === 'pending_review';
  const toggle = (set: Set<number>, i: number, f: (s: Set<number>) => void) => {
    const n = new Set(set);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    f(n);
  };
  const act = async (fn: () => Promise<unknown>, msg: string, restart = false) => {
    setBusy(true);
    try {
      await fn();
      toast(msg);
      if (restart) void extractionController.start();
      navigate('/extraction');
    } finally {
      setBusy(false);
    }
  };
  const segs = showAll ? result.transcript : result.transcript.slice(0, 40);

  return (
    <div className="space-y-4" data-testid="draft-review">
      <PageHeader title="AI 자막 검토" description={video?.title ?? ''} back={{ to: '/extraction', label: 'AI 자막 관리' }} />
      {!pending && (
        <Card className="p-4 text-sm text-muted">
          이 초안은 이미 처리됐어요 ({draft.status === 'rejected' ? '버림' : '적용됨'}).
        </Card>
      )}
      <Card className="space-y-2 p-4">
        <p className="font-bold">확인할 점</p>
        <div className="flex flex-wrap gap-1">
          {assessment.blocking.map((c) => (
            <Badge key={c} tone="warn">
              {issueText(c)}
            </Badge>
          ))}
          {issues
            .filter((i) => !assessment.blocking.includes(i.code))
            .map((i, n) => (
              <Badge key={`${i.code}-${n}`} tone="neutral">
                {issueText(i.code)}
                {i.detail ? ` ${i.detail}` : ''}
              </Badge>
            ))}
        </div>
      </Card>

      <Card className="space-y-2 p-4">
        <p className="font-bold">핵심 표현 {result.keyExpressions.length}개</p>
        {result.keyExpressions.length === 0 && <p className="text-sm text-muted">찾은 표현이 없어요. 적용하면 자막만 저장돼요.</p>}
        {result.keyExpressions.map((k, i) => (
          <label key={i} className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={!offKey.has(i)} disabled={!pending} onChange={() => toggle(offKey, i, setOffKey)} />
            <span>
              <b>{k.text}</b> — {k.meaningKo} <span className="text-xs text-subtle">{fmt(k.timestampSec)}</span>
            </span>
          </label>
        ))}
        {(result.introChunks ?? []).length > 0 && <p className="pt-2 font-bold">영상 속 Chunk</p>}
        {(result.introChunks ?? []).map((c, i) => (
          <label key={`c${i}`} className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={!offChunk.has(i)} disabled={!pending} onChange={() => toggle(offChunk, i, setOffChunk)} />
            <span>
              <b>{c.text}</b> — {c.meaningKo}
            </span>
          </label>
        ))}
      </Card>

      <Card className="p-4">
        <p className="font-bold">전사 {result.transcript.length}구간</p>
        <ol className="mt-2 space-y-1 text-sm">
          {segs.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-12 shrink-0 text-xs text-subtle tabular-nums">{fmt(s.start)}</span>
              <span className="min-w-0 break-words">{s.text}</span>
            </li>
          ))}
        </ol>
        {result.transcript.length > 40 && !showAll && (
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => setShowAll(true)}>
            전체 보기
          </Button>
        )}
      </Card>

      {pending && (
        <div className="grid gap-2 sm:grid-cols-3">
          <Button
            disabled={busy}
            data-testid="draft-apply"
            onClick={() => act(() => applyDraft({ store: extractionStore }, draft.id, { excludeKeyIdx: [...offKey], excludeChunkIdx: [...offChunk] }), '학습 자료로 적용했어요')}
          >
            학습 자료로 적용
          </Button>
          <Button variant="secondary" disabled={busy} data-testid="draft-retry" onClick={() => act(() => rejectDraftAndRetry({ store: extractionStore }, draft.id), '다시 추출할게요', true)}>
            버리고 다시 추출
          </Button>
          <Button variant="ghost" disabled={busy} data-testid="draft-skip" onClick={() => act(() => skipDraft({ store: extractionStore }, draft.id), '건너뛰었어요. 자막은 직접 입력할 수 있어요')}>
            건너뛰기
          </Button>
        </div>
      )}
      <p className="text-xs text-subtle">적용해도 기존 자막·표현은 바뀌지 않아요. 같은 표현이 이미 있으면 그 표현에 연결만 해요.</p>
    </div>
  );
}
