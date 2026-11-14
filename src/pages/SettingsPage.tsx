import { useState } from 'react';
import { repos } from '@/repositories';
import { useLiveData } from '@/hooks/useLiveData';
import { useConfirm } from '@/hooks/useConfirm';
import { useToast } from '@/hooks/useToast';
import { seedSampleData } from '@/services/seedService';
import { getIntegrations } from '@/services/integrations/status';
import { CURRENT_SCHEMA_VERSION } from '@/db/migrations';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, SectionTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PlannedNotice } from '@/components/ui/PlannedNotice';
import { Loading } from '@/components/ui/Loading';
import { formatDateKo } from '@/utils/date';

const STATE_BADGE = {
  connected: { label: '연결됨', tone: 'ok' },
  not_configured: { label: '설정 필요', tone: 'warn' },
  not_implemented: { label: '미구현 · 연동 대기', tone: 'neutral' },
} as const;

export function SettingsPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const data = useLiveData(async () => {
    const [counts, hasSample, initializedAt, schemaVersion] = await Promise.all([
      repos.maintenance.countAll(),
      repos.maintenance.hasSampleData(),
      repos.meta.get<string>('initializedAt'),
      repos.meta.get<number>('schemaVersion'),
    ]);
    return { counts, hasSample, initializedAt, schemaVersion };
  }, []);

  if (!data) return <Loading />;
  const totalRecords = data.counts.filter((c) => c.table !== 'appMeta').reduce((s, c) => s + c.total, 0);
  const sampleRecords = data.counts.reduce((s, c) => s + c.sample, 0);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      console.error(e);
      toast(e instanceof Error ? `오류: ${e.message}` : '오류가 발생했어요', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-7">
      <PageHeader title="설정" description="저장된 데이터와 외부 연동 상태를 관리합니다." />

      <section>
        <SectionTitle>외부 연동 상태</SectionTitle>
        <Card className="divide-y divide-line">
          {getIntegrations().map((i) => (
            <div key={i.id} className="flex items-start gap-3 px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{i.name}</p>
                <p className="mt-0.5 text-sm text-muted">{i.description}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Badge tone={STATE_BADGE[i.state].tone}>{STATE_BADGE[i.state].label}</Badge>
                <span className="text-[11px] text-subtle">{i.plannedStage} 예정</span>
              </div>
            </div>
          ))}
        </Card>
        <p className="mt-2 text-xs text-subtle">API 키 등 비밀정보는 앱 코드에 포함하지 않고 서버 프록시를 통해서만 사용합니다.</p>
      </section>

      <section>
        <SectionTitle>저장된 데이터 (이 기기 · IndexedDB)</SectionTitle>
        <Card className="p-4">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted">전체 레코드</dt>
              <dd className="text-lg font-bold" data-testid="total-records">
                {totalRecords}
              </dd>
            </div>
            <div>
              <dt className="text-muted">샘플 레코드</dt>
              <dd className="text-lg font-bold" data-testid="sample-records">
                {sampleRecords}
              </dd>
            </div>
            <div>
              <dt className="text-muted">스키마 버전</dt>
              <dd className="text-lg font-bold">
                v{data.schemaVersion ?? '-'} <span className="text-xs font-normal text-subtle">(앱 v{CURRENT_SCHEMA_VERSION})</span>
              </dd>
            </div>
            <div>
              <dt className="text-muted">처음 실행</dt>
              <dd className="text-lg font-bold">{formatDateKo(data.initializedAt ?? null)}</dd>
            </div>
          </dl>
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer font-semibold text-brand">테이블별 보기</summary>
            <table className="mt-2 w-full text-left">
              <thead className="text-xs text-subtle">
                <tr>
                  <th className="py-1 font-medium">항목</th>
                  <th className="py-1 text-right font-medium">전체</th>
                  <th className="py-1 text-right font-medium">샘플</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.counts.map((c) => (
                  <tr key={c.table}>
                    <td className="py-1.5">{c.label}</td>
                    <td className="py-1.5 text-right tabular-nums">{c.total}</td>
                    <td className="py-1.5 text-right text-muted tabular-nums">{c.sample}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </Card>
      </section>

      <section>
        <SectionTitle>샘플 데이터</SectionTitle>
        <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <p className="flex-1 text-sm text-muted">
            {data.hasSample
              ? '기능 확인용 샘플 데이터가 들어 있습니다. 삭제해도 직접 만든 데이터는 그대로 유지됩니다.'
              : '샘플 데이터가 없습니다. 필요하면 다시 넣을 수 있습니다.'}
          </p>
          {data.hasSample ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={async () => {
                const ok = await confirm({
                  title: '샘플 데이터를 삭제할까요?',
                  message: `샘플 레코드 ${sampleRecords}개를 삭제합니다.\n직접 입력한 데이터와 학습 기록은 삭제되지 않습니다.`,
                  confirmLabel: '샘플 삭제',
                  danger: true,
                });
                if (!ok) return;
                await run(async () => {
                  const n = await repos.maintenance.deleteSampleData();
                  toast(`샘플 레코드 ${n}개를 삭제했어요`);
                });
              }}
            >
              샘플 데이터 삭제
            </Button>
          ) : (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await seedSampleData(repos);
                  toast('샘플 데이터를 다시 넣었어요');
                })
              }
            >
              샘플 데이터 다시 넣기
            </Button>
          )}
        </Card>
      </section>

      <section>
        <SectionTitle>백업</SectionTitle>
        <PlannedNotice title="데이터 내보내기 · 가져오기 (JSON 백업)" stage="8단계" />
      </section>

      <section>
        <SectionTitle>위험 구역</SectionTitle>
        <Card className="flex flex-col gap-3 border-danger/30 p-4 sm:flex-row sm:items-center">
          <div className="flex-1 text-sm">
            <p className="font-semibold text-danger">모든 데이터 초기화</p>
            <p className="text-muted">영상, 대화문, 표현, 학습 기록, 복습 일정 등 이 기기의 모든 데이터를 삭제합니다. 되돌릴 수 없습니다.</p>
          </div>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              const ok = await confirm({
                title: '모든 데이터를 초기화할까요?',
                message: `저장된 레코드 ${totalRecords}개와 모든 학습 기록이 영구 삭제됩니다.\n이 작업은 되돌릴 수 없습니다.`,
                confirmLabel: '영구 삭제',
                danger: true,
                requireText: '초기화',
              });
              if (!ok) return;
              await run(async () => {
                await repos.maintenance.clearAll();
                // 초기화 후 샘플이 자동으로 다시 들어가지 않도록 초기화 기록은 남긴다
                await repos.meta.set('initializedAt', new Date().toISOString());
                await repos.meta.set('schemaVersion', CURRENT_SCHEMA_VERSION);
                toast('모든 데이터를 삭제했어요');
              });
            }}
          >
            전체 초기화
          </Button>
        </Card>
      </section>
    </div>
  );
}
