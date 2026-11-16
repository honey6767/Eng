import { Link } from 'react-router-dom';
import { useState } from 'react';
import { extractionStore } from '@/repositories';
import { useLiveData } from '@/hooks/useLiveData';
import { useToast } from '@/hooks/useToast';
import { extractionController } from '@/services/extraction';
import { retryAllFailed, retryJob, reviewOverview } from '@/services/extraction/manage';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { PendingContentCard } from '@/components/content/PendingContentCard';
import { Loading } from '@/components/ui/Loading';
import { ExtractionStatusCard } from '@/components/extraction/ExtractionStatusCard';
import { errorText, issueText } from '@/components/extraction/labels';

/**
 * AI 자막 관리 (B1-c) — 확인이 필요한 것만 모아 보여 준다.
 * 품질이 괜찮은 결과는 이미 자동으로 학습 자료가 되었으므로 여기서는 손댈 필요가 없다.
 */
export function ExtractionPage() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const data = useLiveData(() => reviewOverview(extractionStore), []);
  if (!data) return <Loading />;

  const retry = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      toast(msg);
      void extractionController.start();
    } finally {
      setBusy(false);
    }
  };
  const nothing = data.needsReview.length === 0 && data.failed.length === 0;

  return (
    <div className="space-y-5" data-testid="extraction-page">
      <PageHeader title="AI 자막 관리" description="확인이 필요한 영상만 모았어요. 나머지는 자동으로 학습 자료가 됐어요." />
      <ExtractionStatusCard showWhenEmpty />
      <PendingContentCard />

      <Card className="p-4">
        <p className="font-bold text-ink">자동으로 학습 자료가 된 영상 {data.applied}개</p>
        <p className="mt-1 text-sm text-muted">AI 자막은 ‘AI 자막’으로 표시돼요. 경고가 있었던 {data.appliedWithWarnings.length}개는 ‘확인 권장’ 표시가 붙어 있어요.</p>
      </Card>

      {nothing && (
        <Card className="p-5 text-center text-sm text-muted" data-testid="extraction-nothing">
          확인할 항목이 없어요.
        </Card>
      )}

      {data.needsReview.length > 0 && (
        <section data-testid="needs-review">
          <h2 className="mb-2 font-bold">확인 필요 {data.needsReview.length}개</h2>
          <Card className="divide-y divide-line">
            {data.needsReview.map(({ draft, video, assessment }) => (
              <div key={draft.id} className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{video?.title ?? '삭제된 영상'}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {assessment.blocking.map((c) => (
                      <Badge key={c} tone="warn">
                        {issueText(c)}
                      </Badge>
                    ))}
                  </div>
                </div>
                <LinkButton to={`/extraction/draft/${draft.id}`} size="sm" variant="soft">
                  검토하기
                </LinkButton>
              </div>
            ))}
          </Card>
        </section>
      )}

      {data.failed.length > 0 && (
        <section data-testid="failed-list">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="font-bold">추출하지 못한 영상 {data.failed.length}개</h2>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => retry(() => retryAllFailed({ store: extractionStore }), '실패한 영상을 다시 추출할게요')} data-testid="retry-all">
              모두 다시 추출
            </Button>
          </div>
          <Card className="divide-y divide-line">
            {data.failed.map(({ job, video }) => (
              <div key={job.id} className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{video?.title ?? '삭제된 영상'}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {errorText(job.lastError?.code)} · 시도 {job.attempts}번
                  </p>
                </div>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => retry(() => retryJob({ store: extractionStore }, job.id), '다시 추출할게요')}>
                  다시 추출
                </Button>
              </div>
            ))}
          </Card>
          <p className="mt-2 text-xs text-subtle">다시 추출하면 무료 사용량을 한 번 더 써요. 자동으로 다시 요청하지는 않아요.</p>
        </section>
      )}

      {data.appliedWithWarnings.length > 0 && (
        <section>
          <h2 className="mb-2 font-bold">확인 권장 (이미 적용됨)</h2>
          <Card className="divide-y divide-line">
            {data.appliedWithWarnings.map(({ draft, video, assessment }) => (
              <Link key={draft.id} to={`/videos/${draft.videoId}?tab=transcript`} className="block p-4 hover:bg-canvas">
                <p className="truncate font-semibold">{video?.title ?? '삭제된 영상'}</p>
                <p className="mt-0.5 text-xs text-muted">{assessment.warnings.map(issueText).join(' · ')}</p>
              </Link>
            ))}
          </Card>
        </section>
      )}

      {data.skipped.length > 0 && (
        <section>
          <h2 className="mb-2 font-bold">자동 추출하지 않는 영상 {data.skipped.length}개</h2>
          <Card className="divide-y divide-line">
            {data.skipped.map(({ job, video }) => (
              <Link key={job.id} to={`/videos/${job.videoId}?tab=transcript`} className="flex items-center justify-between gap-2 p-4 hover:bg-canvas">
                <span className="truncate font-semibold">{video?.title ?? '삭제된 영상'}</span>
                <span className="shrink-0 text-xs text-muted">{errorText(job.lastError?.code)} · 자막 직접 입력</span>
              </Link>
            ))}
          </Card>
        </section>
      )}
    </div>
  );
}
