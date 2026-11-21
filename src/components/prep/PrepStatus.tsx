import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { prepController } from '@/services/prep';
import { fetchAiUsage } from '@/services/integrations/aiClient';
import type { AiUsageResponse } from '@/types/aiApi';
import type { PrepSnapshot } from '@/services/prep/prepController';
import type { PrepRow, PrepStage } from '@/services/prep/prepRunner';
import type { KeySentence } from '@/types/models';
import { daySentenceProblem, DAY_SENTENCE_MAX, excludedDaySentences, includedDaySentences } from '@/services/days/daySeries';
import { useToast } from '@/hooks/useToast';
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

export const STAGE_LABEL: Record<PrepStage, string> = { transcript: '자막', pack: '문장·Chunk·대화문', daypack: '공통 Chunk·대화문', dayuser: 'Day 자료', done: '완료' };

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
  if (!s || (s.total === 0 && s.day.total === 0)) return null;
  if (!full && s.queued === 0 && s.failed === 0 && snap.status.kind !== 'running' && snap.status.kind !== 'paused') return null;
  // 실패·건너뜀 목록과 '실패만 다시 시도'는 일반 영상만 (Day 영상은 각 영상의 'Day 자료 만들기')
  const failed = snap.rows.filter((r) => r.series === 'general' && r.status === 'failed');
  const skipped = snap.rows.filter((r) => r.series === 'general' && r.status === 'skipped');
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
        일반 영상 · 완료 {s.ready} · 대기 {s.queued} · 실패 {s.failed}
        {s.skipped > 0 && ` · 건너뜀 ${s.skipped}`}
        {s.notQueued > 0 && ` · 시작 전 ${s.notQueued}`}
      </p>
      {s.day.total > 0 && (
        <p className="text-sm text-muted" data-testid="prep-day-counts">
          Day 1~100 · 완료 {s.day.done} · 문장 입력 전 {s.day.noSentences}
          {s.day.canMake > 0 && ` · 만들 수 있음 ${s.day.canMake}`}
          {s.day.queued > 0 && ` · 만드는 중 ${s.day.queued}`}
          {s.day.failed > 0 && ` · 실패 ${s.day.failed}`}
          <span className="block text-xs text-subtle">Day 영상은 자동으로 만들지 않아요. 영상 화면에서 핵심 문장을 넣고 ‘Day 자료 만들기’를 누르면 만들어요.</span>
        </p>
      )}
      <StatusLine snap={snap} />
      {full && <UsageLine usage={usage} />}
      {full && notStarted && (
        <div className="rounded-2xl bg-canvas p-3">
          <p className="text-sm">
            이미 등록된 일반 영상 <b>{s.notQueued}개</b>는 아직 자료를 만들지 않았어요. 한 번 누르면 이후에는 하루 사용 한도 안에서 자동으로 차례대로 만들어요 (Day 1~100 영상은 제외).
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
  // Day 1~100 영상은 DayMaterialCard가 대신 보여 준다
  if (!row || row.status === 'ready' || row.series === 'day') return null;
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
  if (row.series === 'day') {
    switch (row.status) {
      case 'ready':
        return <Badge tone="ok">Day 자료 완료</Badge>;
      case 'queued':
        return <Badge tone="info">Day 자료 만드는 중</Badge>;
      case 'failed':
      case 'skipped':
        return <Badge tone="danger">Day 자료 실패</Badge>;
      default:
        return row.daySentences ? <Badge tone="info">문장 {row.daySentences}개 · 만들기 전</Badge> : <Badge>문장 입력 전</Badge>;
    }
  }
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

/**
 * Day 1~100 영상의 Day 자료 — 사용자가 입력하거나 자막에서 고른 핵심 문장(1~20개)으로, 버튼을 눌렀을 때만 AI 요청 1회.
 * AI가 뽑은 문장·자막은 보내지 않는다. 이미 Day 자료가 있으면 다시 만들지 않는다.
 */
export function DayMaterialCard({ videoId, dayNumber, sentences, hasMaterial, excludedIds = new Set() }: { videoId: string; dayNumber: number; sentences: KeySentence[]; hasMaterial: boolean; excludedIds?: ReadonlySet<string> }) {
  const snap = usePrep();
  const usage = useAiUsage(snap.status.kind);
  const row = snap.rows.find((r) => r.video.id === videoId);
  // Day 자료에 쓰는 문장 = 사용자 문장 중 뺀 것 제외
  const mine = includedDaySentences(sentences, excludedIds);
  const left = excludedDaySentences(sentences, excludedIds);
  const problem = daySentenceProblem(mine);
  const running = snap.status.kind === 'running' && snap.status.videoId === videoId;
  const done = hasMaterial || row?.status === 'ready';
  const queued = !done && row?.status === 'queued';
  const failure = !done && row?.status === 'failed' ? row.failure : null;
  const remain = usage ? Math.max(0, usage.dailyRequests - usage.requests) : null;
  const state = done ? '완료' : running ? '만드는 중' : queued ? '대기 중' : failure ? '실패' : mine.length ? '만들기 전' : '문장 입력 전';
  return (
    <Card className="p-4" data-testid="day-material" data-state={done ? 'done' : running || queued ? 'queued' : failure ? 'failed' : mine.length ? 'ready_to_make' : 'no_sentences'}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-bold">Day 자료</p>
        <Badge tone="brand">Day {dayNumber}</Badge>
        <span data-testid="day-material-state">
          <Badge tone={done ? 'ok' : failure ? 'danger' : running || queued ? 'info' : undefined}>{state}</Badge>
        </span>
        <span className="ml-auto text-xs text-muted" data-testid="day-sentence-count">
          핵심 문장 {mine.length}/{DAY_SENTENCE_MAX}
          {left.length > 0 && ` · 뺀 문장 ${left.length}`}
        </span>
      </div>
      {done ? (
        <p className="mt-1 text-sm text-muted">이 Day의 학습 자료가 있어요. 이미 만든 자료는 다시 만들거나 덮어쓰지 않아요.</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted">
            아래 ‘핵심 문장’에 직접 입력하거나 자막에서 고른 문장(1~{DAY_SENTENCE_MAX}개)만으로 공통 핵심 Chunk와 Day 대화문을 만들어요. 원문 문장은 고치지 않고, AI가 예전에 뽑은 문장과 자막은 보내지 않아요.
          </p>
          {running && snap.status.kind === 'running' && snap.status.note && <p className="mt-1 text-xs text-subtle">{snap.status.note}</p>}
          {failure && (
            <p className="mt-1 text-sm text-danger" data-testid="day-material-error">
              실패{failure.error.httpStatus ? ` · HTTP ${failure.error.httpStatus}` : ''} · {failure.error.code} — <span className="text-muted">{failure.error.message}</span>
            </p>
          )}
          {problem && !running && !queued && (
            <p className="mt-1 text-sm text-warn" data-testid="day-material-problem">
              {problem}
            </p>
          )}
          {!running && !queued && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={!!problem} onClick={() => void prepController.makeDay(videoId)} data-testid="day-make">
                {failure ? 'Day 자료 다시 만들기' : 'Day 자료 만들기'}
              </Button>
              <span className="text-xs text-subtle">AI 요청 1회 · 보낼 문장 {mine.length}개{left.length ? ` (뺀 문장 ${left.length}개 제외)` : ''}{remain !== null ? ` · 오늘 남은 요청 ${remain}회` : ''}</span>
            </div>
          )}
          {queued && !running && <p className="mt-1 text-sm text-muted">대기열에 있어요. 차례가 되면 만들어요.</p>}
        </>
      )}
      {left.length > 0 && (
        <div className="mt-2 rounded-xl bg-canvas p-2.5 text-sm" data-testid="day-excluded">
          <p className="text-xs font-semibold text-subtle">Day 자료에서 뺀 문장 {left.length}개 — {done ? 'Day 자료에 쓰지 않았어요' : 'AI 요청에 넣지 않아요'} (문장·학습 기록은 그대로)</p>
          <ul className="mt-1 space-y-0.5">
            {left.map((s) => (
              <li key={s.id} className="truncate text-muted">
                <b className="text-ink">{s.order}</b> <span className="en">{s.english}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/**
 * Day 자료에서 빼기·다시 넣기 버튼 (핵심 문장 카드용). appMeta 'dayExclusions'만 바꾼다.
 * Day 자료가 이미 있으면 보여 주지 않고, 요청 대기·진행 중에는 누를 수 없다.
 */
export function DayExclusionToggle({ videoId, sentenceId, excluded, hasMaterial }: { videoId: string; sentenceId: string; excluded: boolean; hasMaterial: boolean }) {
  const snap = usePrep();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const row = snap.rows.find((r) => r.video.id === videoId);
  if (hasMaterial || row?.status === 'ready') return null;
  const running = snap.status.kind === 'running' && snap.status.videoId === videoId;
  const locked = running || row?.status === 'queued';
  return (
    <Button
      size="sm"
      variant={excluded ? 'soft' : 'ghost'}
      disabled={busy || locked}
      title={locked ? 'Day 자료 요청이 대기·진행 중이라 바꿀 수 없어요' : undefined}
      data-testid={excluded ? 'day-include' : 'day-exclude'}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await prepController.setDayExcluded(videoId, sentenceId, !excluded);
          if (r !== 'ok') toast(r === 'busy' ? 'Day 자료 요청이 대기·진행 중이라 바꿀 수 없어요.' : r === 'has_material' ? '이미 Day 자료가 있어 바꿀 수 없어요.' : '바꿀 수 없는 문장이에요.', 'error');
        } finally {
          setBusy(false);
        }
      }}
    >
      {excluded ? 'Day 자료에 다시 넣기' : 'Day 자료에서 빼기'}
    </Button>
  );
}
