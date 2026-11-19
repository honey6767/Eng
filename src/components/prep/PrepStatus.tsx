import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { prepController } from '@/services/prep';
import { fetchAiUsage } from '@/services/integrations/aiClient';
import type { AiUsageResponse } from '@/types/aiApi';
import type { PrepSnapshot } from '@/services/prep/prepController';
import type { PrepRow, PrepStage } from '@/services/prep/prepRunner';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

/** 학습 자료 자동 생성 상태 (영상 등록 → 자동 대기열 → 순차 생성 → 저장) */

/** 오늘 Gemini 사용량 (읽기 전용 조회 — Gemini를 부르지 않음). 대기열 상태가 바뀔 때 다시 읽는다 */
function useAiUsage(dep: unknown): AiUsageResponse | null {
  const [usage, setUsage] = useState<AiUsageResponse | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchAiUsage().then((u) => alive && setUsage(u));
    return () => {
      alive = false;
    };
  }, [dep]);
  return usage;
}

const resetLabel = (iso: string) => new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function UsageLine({ usage }: { usage: AiUsageResponse | null }) {
  if (!usage) return null;
  const left = Math.max(0, usage.dailyRequests - usage.requests);
  return (
    <p className="text-xs text-muted" data-testid="prep-usage">
      오늘 Gemini 요청 {usage.requests}/{usage.dailyRequests}회 (남은 {left}회) · 자동 준비 {usage.auto?.used ?? 0}/{usage.auto?.cap ?? usage.dailyRequests}회
      {usage.resetAt && ` · 초기화 ${resetLabel(usage.resetAt)}`}
    </p>
  );
}

export function usePrep(): PrepSnapshot {
  const [snap, setSnap] = useState<PrepSnapshot>(prepController.getSnapshot());
  useEffect(() => {
    const off = prepController.subscribe(setSnap);
    void prepController.refresh();
    return off;
  }, []);
  // 진행 중이면 경과 시간 표시를 위해 1초마다 다시 그림
  const [, tick] = useState(0);
  useEffect(() => {
    if (snap.status.kind !== 'running') return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [snap.status.kind]);
  return snap;
}

export const STAGE_LABEL: Record<PrepStage, string> = { transcript: '자막', pack: '문장·Chunk·대화문', daypack: '공통 Chunk·대화문', done: '완료' };

const elapsed = (since: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
};
const when = (iso: string) => new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function StatusLine({ snap }: { snap: PrepSnapshot }) {
  const st = snap.status;
  if (st.kind === 'running')
    return (
      <p className="text-sm" data-testid="prep-running">
        <Badge tone="brand">생성 중</Badge> <b>{st.title}</b> · {STAGE_LABEL[st.stage]} · {elapsed(st.since)}
        {st.note && <span className="mt-0.5 block text-xs text-subtle">{st.note}</span>}
      </p>
    );
  if (st.kind === 'paused' && st.code === 'stopped')
    return (
      <div role="status" className="rounded-2xl bg-warn-soft p-3 text-sm text-warn" data-testid="prep-paused">
        <p>멈춤 — {st.message}</p>
        <Button className="mt-2" size="sm" variant="secondary" onClick={() => void prepController.continueQueue()} data-testid="prep-continue">
          이어서 만들기
        </Button>
      </div>
    );
  if (st.kind === 'paused')
    return (
      <p role="status" className="rounded-2xl bg-warn-soft p-3 text-sm text-warn" data-testid="prep-paused">
        잠시 멈춤{st.httpStatus ? ` · HTTP ${st.httpStatus}` : ''} · {st.code} — {st.message}
        {st.until && ` (${when(st.until)} 이후 앱을 열면 이어서 해요)`}
      </p>
    );
  if (st.kind === 'other_tab') return <p className="text-sm text-muted">다른 탭에서 자료를 만드는 중이에요.</p>;
  return null;
}

/** 자료 생성 상태 카드 — full이면 실패 목록·다시 시도·기존 영상 시작 버튼까지 */
export function PrepStatusCard({ full = false }: { full?: boolean }) {
  const snap = usePrep();
  const usage = useAiUsage(`${snap.status.kind}:${snap.summary?.ready ?? 0}:${snap.summary?.failed ?? 0}`);
  const s = snap.summary;
  if (!s || s.total === 0) return null;
  if (!full && s.queued === 0 && s.failed === 0 && snap.status.kind !== 'running' && snap.status.kind !== 'paused') return null;
  const failed = snap.rows.filter((r) => r.status === 'failed');
  const skipped = snap.rows.filter((r) => r.status === 'skipped');
  const notStarted = !snap.state?.allStarted && s.notQueued > 0;
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="prep-status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-bold text-ink">학습 자료 자동 생성</p>
        {!full && (
          <Link to="/extraction" className="text-sm font-semibold text-brand">
            자세히
          </Link>
        )}
      </div>
      <p className="text-sm text-muted" data-testid="prep-counts">
        완료 {s.ready} · 대기 {s.queued} · 실패 {s.failed}
        {s.skipped > 0 && ` · 건너뜀 ${s.skipped}`}
        {s.notQueued > 0 && ` · 시작 전 ${s.notQueued}`}
      </p>
      <StatusLine snap={snap} />
      {full && <UsageLine usage={usage} />}
      {full && notStarted && (
        <div className="rounded-2xl bg-canvas p-3">
          <p className="text-sm">
            이미 등록된 영상 <b>{s.notQueued}개</b>는 아직 자료를 만들지 않았어요. 한 번 누르면 이후에는 하루 사용 한도 안에서 자동으로 차례대로 만들어요(Day 번호 순).
          </p>
          <Button className="mt-2" size="sm" onClick={() => void prepController.startAll()} data-testid="prep-start-all">
            기존 영상 자료 만들기 시작
          </Button>
        </div>
      )}
      {full && failed.length > 0 && (
        <section data-testid="prep-failed">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold">실패 {failed.length}개</p>
            <Button size="sm" variant="secondary" onClick={() => void prepController.retryFailed()} data-testid="prep-retry-all">
              실패만 다시 시도
            </Button>
          </div>
          <ul className="divide-y divide-line rounded-2xl border border-line">
            {failed.map((r) => (
              <FailRow key={r.video.id} row={r} />
            ))}
          </ul>
        </section>
      )}
      {full && skipped.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer font-semibold text-muted">건너뛴 영상 {skipped.length}개 (긴 영상 등)</summary>
          <ul className="mt-1 space-y-1">
            {skipped.map((r) => (
              <li key={r.video.id} className="text-xs text-subtle">
                <Link to={`/videos/${r.video.id}?tab=transcript`} className="text-brand underline">
                  {r.video.title}
                </Link>{' '}
                — {r.failure?.error.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-xs text-subtle">앱이 열려 있는 동안 한 영상씩 만들어요. 앱을 닫거나 iPad가 잠기면 멈췄다가, 다시 열면 이어서 해요. 한 번 만든 자료는 다른 기기에서도 다시 만들지 않고 받아 와요.</p>
    </Card>
  );
}

function FailRow({ row }: { row: PrepRow }) {
  const e = row.failure!.error;
  return (
    <li className="flex flex-wrap items-start gap-2 p-3" data-testid="prep-fail-row">
      <div className="min-w-0 flex-1">
        <Link to={`/videos/${row.video.id}`} className="block truncate text-sm font-semibold">
          {row.video.title}
        </Link>
        <p className="text-xs text-danger">
          {STAGE_LABEL[row.failure!.stage]} 단계 실패{e.httpStatus ? ` · HTTP ${e.httpStatus}` : ''} · {e.code}
        </p>
        <p className="text-xs text-muted">{e.message}</p>
      </div>
      <Button size="sm" variant="soft" onClick={() => void prepController.retryFailed([row.video.id])}>
        다시 시도
      </Button>
    </li>
  );
}

/** 영상 1개의 자료 상태 (학습 화면용 — 생성은 대기열이 하고, 여기서는 Gemini를 직접 부르지 않음) */
export function VideoPrepStatus({ videoId }: { videoId: string }) {
  const snap = usePrep();
  const usage = useAiUsage(snap.status.kind);
  const row = snap.rows.find((r) => r.video.id === videoId);
  if (!row || row.status === 'ready') return null;
  const running = snap.status.kind === 'running' && snap.status.videoId === videoId;
  // 자동 준비 몫을 다 써서 자동 영상이 기다리는 중 → 사용자가 직접 시작할 수 있게 (사용자 작업으로 셈)
  const st = snap.state;
  const autoWaiting = row.status === 'queued' && !running && !!st?.autoPausedUntil && Date.parse(st.autoPausedUntil) > Date.now() && !(st.manual ?? []).includes(videoId);
  return (
    <Card className="p-4" data-testid="video-prep">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-bold">학습 자료</p>
        {running ? <Badge tone="brand">생성 중 · {STAGE_LABEL[(snap.status as { stage: PrepStage }).stage]}</Badge> : <PrepBadgeView row={row} />}
      </div>
      {running && snap.status.kind === 'running' && snap.status.note && <p className="mt-1 text-xs text-subtle">{snap.status.note}</p>}
      {row.status === 'failed' && row.failure && (
        <p className="mt-1 text-sm text-danger" data-testid="video-prep-error">
          {STAGE_LABEL[row.failure.stage]} 단계 실패{row.failure.error.httpStatus ? ` · HTTP ${row.failure.error.httpStatus}` : ''} · {row.failure.error.code} — <span className="text-muted">{row.failure.error.message}</span>
        </p>
      )}
      {row.status === 'skipped' && row.failure && <p className="mt-1 text-sm text-muted">{row.failure.error.message}</p>}
      {row.status === 'queued' && !running && !autoWaiting && <p className="mt-1 text-sm text-muted">대기열에 있어요. 차례가 되면 자동으로 만들어요.</p>}
      {autoWaiting && (
        <p className="mt-1 text-sm text-muted" data-testid="video-prep-auto-wait">
          오늘 자동 준비 몫을 다 써서 기다리는 중이에요. 지금 바로 만들려면 ‘지금 만들기’를 누르세요 (AI 요청 1회
          {usage ? ` · 오늘 남은 요청 ${Math.max(0, usage.dailyRequests - usage.requests)}회` : ''}).
        </p>
      )}
      {row.status === 'not_queued' && row.stage !== 'transcript' && (
        <p className="mt-1 text-sm text-muted" data-testid="video-prep-ready-hint">
          자막이 준비됐어요. ‘이 영상 자료 만들기’를 누르면 학습 자료를 만들어요 (AI 요청 1회
          {usage ? ` · 오늘 남은 요청 ${Math.max(0, usage.dailyRequests - usage.requests)}회` : ''}).
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {autoWaiting && (
          <Button size="sm" onClick={() => void prepController.enqueue([videoId], { manual: true })} data-testid="video-prep-now">
            지금 만들기
          </Button>
        )}
        {row.status === 'not_queued' && (
          <Button size="sm" onClick={() => void prepController.enqueue([videoId], { manual: true })} data-testid="video-prep-enqueue">
            이 영상 자료 만들기
          </Button>
        )}
        {row.status === 'failed' && (
          <Button size="sm" variant="secondary" onClick={() => void prepController.retryFailed([videoId])} data-testid="video-prep-retry">
            다시 시도
          </Button>
        )}
      </div>
    </Card>
  );
}

function PrepBadgeView({ row }: { row: PrepRow }) {
  switch (row.status) {
    case 'ready':
      return <Badge tone="ok">자료 준비됨</Badge>;
    case 'queued':
      return <Badge tone="info">대기 · {STAGE_LABEL[row.stage]}</Badge>;
    case 'failed':
      return <Badge tone="danger">자료 실패</Badge>;
    case 'skipped':
      return <Badge>자료 건너뜀</Badge>;
    default:
      return <Badge>자료 시작 전</Badge>;
  }
}

/** 영상 목록용 작은 표시 */
export function PrepBadge({ videoId }: { videoId: string }) {
  const snap = usePrep();
  const row = snap.rows.find((r) => r.video.id === videoId);
  if (!row) return null;
  if (snap.status.kind === 'running' && snap.status.videoId === videoId) return <Badge tone="brand">자료 생성 중</Badge>;
  return <PrepBadgeView row={row} />;
}
