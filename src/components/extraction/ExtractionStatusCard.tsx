import { useEffect, useState } from 'react';
import { extractionController } from '@/services/extraction';
import type { ControllerSnapshot } from '@/services/extraction/controller';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';

/**
 * 자동 자막 추출 상태 (B1-b) — 진행 상황만 보여 주고, 시작·멈춤만 한다.
 * 품질이 괜찮은 결과는 자동으로 학습 자료가 되고(B1-d), 문제가 있는 것만 'AI 자막 관리'의 확인 필요로 간다.
 */
export function ExtractionStatusCard({ showWhenEmpty = false }: { showWhenEmpty?: boolean } = {}) {
  const [snap, setSnap] = useState<ControllerSnapshot>(extractionController.getSnapshot());
  useEffect(() => {
    const off = extractionController.subscribe(setSnap);
    void extractionController.refresh();
    return off;
  }, []);
  const s = snap.summary;
  if (!s || s.total === 0) {
    if (!showWhenEmpty || !s) return null;
    // 아직 한 번도 시작하지 않았을 때 — 'AI 자막 관리'에서 바로 시작할 수 있게
    const busy = snap.status.kind === 'running';
    return (
      <Card className="flex flex-col gap-3 p-4" data-testid="extraction-status-empty">
        <p className="font-bold text-ink">AI 자막 자동 추출</p>
        <p className="text-sm text-muted">자막이 없는 영상의 자막과 핵심 표현을 AI가 하나씩 차례로 만들어요. 영상 화면에서 ‘학습 시작’을 눌러도 자동으로 시작돼요.</p>
        <div>
          <Button size="sm" disabled={busy} onClick={() => void extractionController.start()} data-testid="extraction-start-empty">
            자막 없는 영상 자동 추출 시작
          </Button>
        </div>
      </Card>
    );
  }
  const st = snap.status;
  const label =
    st.kind === 'running' ? { tone: 'brand' as const, text: '자막 추출 중' }
    : st.kind === 'paused' ? { tone: 'warn' as const, text: '잠시 멈춤' }
    : st.kind === 'other_tab' ? { tone: 'info' as const, text: '다른 탭에서 진행 중' }
    : st.kind === 'done' ? { tone: 'ok' as const, text: '이번 추출 끝' }
    : { tone: 'neutral' as const, text: '대기' };
  const untilText = st.kind === 'paused' && st.until ? ` (${new Date(st.until).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 이후 다시 시작)` : '';

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="extraction-status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="font-bold text-ink">AI 자막 자동 추출</p>
          <Badge tone={label.tone}>{label.text}</Badge>
        </div>
        {st.kind === 'running' ? (
          <Button size="sm" variant="secondary" onClick={() => void extractionController.stop()} data-testid="extraction-stop">
            멈추기
          </Button>
        ) : (
          (s.queued > 0 || s.running > 0) && (
            <Button size="sm" variant="soft" onClick={() => void extractionController.start()} data-testid="extraction-start">
              이어서 추출
            </Button>
          )
        )}
      </div>
      <p className="text-sm text-muted" data-testid="extraction-counts">
        완료 {s.succeeded} · 남음 {s.queued + s.running} · 확인 필요 {s.needsAttention} · 긴 영상 {s.longVideos}
      </p>
      {st.kind === 'running' && <p className="truncate text-xs text-subtle">지금: {st.message}</p>}
      {st.kind === 'paused' && (
        <p role="status" className="rounded-2xl bg-warn-soft p-3 text-sm text-warn" data-testid="extraction-paused">
          {st.message}
          {untilText}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-subtle">추출한 자막은 기기에 저장돼 다시 요청하지 않아요. 품질이 괜찮으면 자동으로 학습 자료가 돼요. 무료 한도 안에서만 진행해요.</p>
        <LinkButton to="/extraction" size="sm" variant="ghost">
          {s.needsAttention > 0 ? `확인 필요 ${s.needsAttention}개 보기` : '자세히'}
        </LinkButton>
      </div>
    </Card>
  );
}
