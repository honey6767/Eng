import { useState } from 'react';
import { contentStore, repos } from '@/repositories';
import { contentDeps, generatePendingContent, listPendingContent, type ContentProgress, type PendingVideo } from '@/services/content';
import { useLiveData } from '@/hooks/useLiveData';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ContentStatus } from './StudyContentPanel';

/** AI 자막 관리 — 자막은 있는데 원문 문장·Chunk가 아직 없는 영상을 차례로 만든다 */
export function PendingContentCard() {
  const pending = useLiveData(async () => listPendingContent(contentStore, (await repos.videos.list()).map((v) => v.id)), []);
  const [run, setRun] = useState<{ done: number; total: number; current: PendingVideo | null; last: ContentProgress | null } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!pending || (pending.length === 0 && !run)) return null;
  return (
    <Card className="p-4" data-testid="pending-content">
      <p className="font-bold text-ink">원문 문장·Chunk 만들기</p>
      <p className="mt-1 text-sm text-muted">
        자막은 저장돼 있지만 문장·Chunk가 아직 없는 영상 <b className="text-ink">{pending.length}개</b>. 하나씩 차례로 만들고, 하루 한도나 오류가 나면 멈춰요.
      </p>
      {run && (
        <div className="mt-2 space-y-2">
          <p className="text-sm" data-testid="pending-content-progress">
            {run.done}/{run.total} 완료{run.current ? ` · 지금: ${run.current.title}` : ''}
          </p>
          {run.last && <ContentStatus p={run.last} />}
        </div>
      )}
      <Button
        className="mt-3"
        size="sm"
        disabled={busy || pending.length === 0}
        data-testid="pending-content-start"
        onClick={async () => {
          setBusy(true);
          try {
            await generatePendingContent(contentDeps, pending, (done, total, current, last) => setRun({ done, total, current, last }));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '만드는 중…' : `${pending.length}개 영상 문장·Chunk 만들기`}
      </Button>
    </Card>
  );
}
