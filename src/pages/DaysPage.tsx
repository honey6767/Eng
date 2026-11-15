import { Link } from 'react-router-dom';
import { useState } from 'react';
import { extractionStore } from '@/repositories';
import { useLiveData } from '@/hooks/useLiveData';
import { useToast } from '@/hooks/useToast';
import { confirmAllSuggestions, loadDayRows, setVideoDay, type DayRow } from '@/services/days/dayService';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Loading } from '@/components/ui/Loading';

const STATUS: Record<DayRow['status'], { label: string; tone: 'ok' | 'brand' | 'warn' | 'neutral' }> = {
  confirmed: { label: '확정', tone: 'ok' },
  suggested: { label: '제안', tone: 'brand' },
  conflict: { label: '번호 겹침', tone: 'warn' },
  none: { label: '번호 없음', tone: 'neutral' },
};

/** Day 정리 (B1-d) — 제안을 한 번에 확정하고, 겹치거나 없는 것만 직접 정한다. 영상 레코드는 바꾸지 않는다 */
export function DaysPage() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const rows = useLiveData(() => loadDayRows(extractionStore), []);
  if (!rows) return <Loading />;
  const suggested = rows.filter((r) => r.status === 'suggested').length;
  const need = rows.filter((r) => r.status === 'conflict' || r.status === 'none');
  const confirmed = rows.filter((r) => r.status === 'confirmed').length;

  const save = async (r: DayRow) => {
    const n = Number(edit[r.video.id] ?? r.dayNumber ?? '');
    setBusy(true);
    try {
      if (await setVideoDay(extractionStore, r.video.id, n)) toast(`Day ${n}로 정했어요`);
      else toast('1~999 사이 번호를 넣어 주세요');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="days-page">
      <PageHeader title="Day 정리" description="영상마다 Day 번호를 정해요. 제목에 Day가 있는 영상은 한 번에 확정할 수 있어요." />
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-sm text-muted" data-testid="day-counts">
          확정 {confirmed} · 제안 {suggested} · 확인 필요 {need.length}
        </p>
        <Button
          disabled={busy || suggested === 0}
          data-testid="day-confirm-all"
          onClick={async () => {
            setBusy(true);
            try {
              const n = await confirmAllSuggestions(extractionStore);
              toast(`${n}개 영상의 Day를 확정했어요`);
            } finally {
              setBusy(false);
            }
          }}
        >
          제안 모두 확정 ({suggested})
        </Button>
      </Card>

      {need.length > 0 && (
        <section>
          <h2 className="mb-2 font-bold">확인 필요 {need.length}개</h2>
          <Card className="divide-y divide-line">
            {need.map((r) => (
              <div key={r.video.id} className="flex flex-wrap items-center gap-2 p-3" data-testid={`day-row-${r.video.id}`}>
                <div className="min-w-0 flex-1">
                  <Link to={`/videos/${r.video.id}`} className="block truncate font-semibold">
                    {r.video.title}
                  </Link>
                  <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                </div>
                <label className="flex items-center gap-1 text-sm">
                  Day
                  <input
                    type="number"
                    min={1}
                    max={999}
                    inputMode="numeric"
                    className="h-10 w-20 rounded-xl border border-line-strong bg-surface px-2"
                    value={edit[r.video.id] ?? (r.dayNumber ? String(r.dayNumber) : '')}
                    onChange={(e) => setEdit({ ...edit, [r.video.id]: e.target.value })}
                    aria-label={`${r.video.title} Day 번호`}
                  />
                </label>
                <Button size="sm" variant="soft" disabled={busy} onClick={() => void save(r)}>
                  저장
                </Button>
              </div>
            ))}
          </Card>
        </section>
      )}

      <section>
        <h2 className="mb-2 font-bold">전체</h2>
        <Card className="divide-y divide-line">
          {rows
            .filter((r) => r.status === 'confirmed' || r.status === 'suggested')
            .map((r) => (
              <div key={r.video.id} className="flex items-center gap-3 p-3">
                <span className="w-16 shrink-0 font-bold tabular-nums">Day {r.dayNumber}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{r.video.title}</span>
                <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
              </div>
            ))}
        </Card>
      </section>
    </div>
  );
}
