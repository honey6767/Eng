import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { db, DB_NAME } from '@/db/database';
import {
  checkStorage,
  getUpgradeStatus,
  openAndVerify,
  readRawTables,
  snapshotBeforeUpgrade,
  UpgradeError,
  DEXIE_VERSION_FACTOR,
  getNativeDbVersion,
  type UpgradeVerification,
} from '@/db/upgradeGuard';
import { V2_TABLE_NAMES } from '@/db/tables';
import { snapshotStore } from '@/repositories';
import { buildBackupFile, serializeBackup, snapshotToBackupFile } from '@/services/backup/backupService';
import { backupFileName } from '@/services/backup/backupFormat';
import { tableLabel } from '@/services/backup/restorePlan';
import { downloadTextFile } from '@/utils/download';
import { Button } from '@/components/ui/Button';
import { Loading } from '@/components/ui/Loading';

/**
 * DB v2 → v3 업그레이드 화면 (B1-a)
 *
 * 앱이 DB를 열기 전에 현재 버전을 확인한다. v2(또는 그 이전) DB가 있으면 바로 열지 않고,
 * 백업 파일 받기를 권한 뒤 → 저장 공간 확인 → 임시 안전 복사본 저장·검증 → v3로 열기 → 기존 데이터 비교 순서로 진행한다.
 * 새 기기(DB 없음)나 이미 v3인 기기는 아무것도 묻지 않고 그대로 연다.
 */

type Phase =
  | { kind: 'checking' }
  | { kind: 'ready' }
  | { kind: 'prompt'; fromVersion: number }
  | { kind: 'running'; step: string }
  | { kind: 'failed'; message: string; snapshotId: string | null }
  | { kind: 'mismatch'; verification: UpgradeVerification; snapshotId: string };

export function DbUpgradeGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [blocked, setBlocked] = useState(false);
  const snapshotIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getUpgradeStatus(DB_NAME)
      .then((s) => {
        if (cancelled) return;
        setPhase(s.kind === 'needs_upgrade' ? { kind: 'prompt', fromVersion: s.fromVersion } : { kind: 'ready' });
      })
      // 버전을 확인하지 못하면(IndexedDB 사용 불가 등) 기존처럼 앱이 오류 화면을 보여 주게 둔다
      .catch(() => !cancelled && setPhase({ kind: 'ready' }));
    return () => {
      cancelled = true;
    };
  }, []);

  const runUpgrade = useCallback(async () => {
    try {
      // 다시 시도할 때 이미 v3로 올라가 있으면 그냥 연다
      const status = await getUpgradeStatus(DB_NAME);
      if (status.kind !== 'needs_upgrade') return setPhase({ kind: 'ready' });
      setPhase({ kind: 'running', step: '저장 공간을 확인하는 중…' });
      await checkStorage();
      setPhase({ kind: 'running', step: '임시 안전 복사본을 만드는 중…' });
      const snap = await snapshotBeforeUpgrade(snapshotStore, DB_NAME);
      snapshotIdRef.current = snap.snapshotId;
      setPhase({ kind: 'running', step: '데이터 구조를 업데이트하는 중…' });
      const verification = await openAndVerify(db, snap.before, () => setBlocked(true));
      setBlocked(false);
      if (!verification.ok) return setPhase({ kind: 'mismatch', verification, snapshotId: snap.snapshotId });
      setPhase({ kind: 'ready' });
    } catch (e) {
      console.error(e);
      setBlocked(false);
      const message = e instanceof UpgradeError ? e.message : '업데이트 중 알 수 없는 문제가 생겼어요. 데이터는 이전 버전 그대로 남아 있어요.';
      setPhase({ kind: 'failed', message, snapshotId: snapshotIdRef.current });
    }
  }, []);

  const downloadCurrentRaw = useCallback(async () => {
    const native = (await getNativeDbVersion(DB_NAME)) ?? 0;
    const schemaVersion = Math.round(native / DEXIE_VERSION_FACTOR);
    const tables = await readRawTables(DB_NAME, V2_TABLE_NAMES);
    downloadTextFile(backupFileName(), serializeBackup(buildBackupFile(tables, schemaVersion)));
  }, []);

  const downloadSnapshot = useCallback(async (id: string) => {
    const file = await snapshotToBackupFile(snapshotStore, id);
    if (file) downloadTextFile(backupFileName(new Date(), 'my-english-study-snapshot'), serializeBackup(file));
  }, []);

  if (phase.kind === 'ready') return <>{children}</>;
  if (phase.kind === 'checking') return <Loading label="학습 데이터를 확인하는 중…" />;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10" data-testid="db-upgrade">
      <div className="w-full max-w-md rounded-3xl border border-line bg-surface p-6 sm:p-8">
        <p className="text-sm font-bold text-brand">My English Study</p>

        {phase.kind === 'prompt' && (
          <>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">앱 데이터 구조를 업데이트해요</h1>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">
              자동 자막 추출을 위한 새 저장 공간을 추가해요. 기존 영상·자막·표현·학습 기록은 한 건도 바꾸거나 지우지 않아요.
            </p>
            <p className="mt-2 text-[15px] leading-relaxed text-muted">
              업데이트 전에 이 브라우저 안에 임시 복사본을 만들지만, 기기를 잃어버리면 함께 사라져요. 먼저 백업 파일을 받아 두세요.
            </p>
            <div className="mt-6 grid gap-2">
              <Button
                size="lg"
                data-testid="upgrade-with-backup"
                onClick={async () => {
                  try {
                    await downloadCurrentRaw();
                  } catch (e) {
                    console.error(e);
                    return setPhase({ kind: 'failed', message: '백업 파일을 만들지 못했어요. 업데이트는 하지 않았어요.', snapshotId: null });
                  }
                  await runUpgrade();
                }}
              >
                백업 파일 받고 업데이트
              </Button>
              <Button
                variant="ghost"
                data-testid="upgrade-without-backup"
                onClick={() => {
                  if (window.confirm('백업 파일 없이 업데이트할까요? 임시 복사본은 이 브라우저 안에만 남아요.')) void runUpgrade();
                }}
              >
                백업 없이 업데이트
              </Button>
            </div>
          </>
        )}

        {phase.kind === 'running' && (
          <div className="mt-2" role="status" data-testid="upgrade-running">
            <h1 className="text-2xl font-extrabold tracking-tight text-ink">업데이트하는 중</h1>
            <p className="mt-3 text-[15px] text-muted">{phase.step}</p>
            {blocked && (
              <p role="alert" className="mt-4 rounded-2xl bg-warn-soft p-3 text-sm font-semibold text-warn" data-testid="upgrade-blocked">
                이 앱이 열린 다른 탭이 있어요. 다른 탭을 닫아 주세요. 닫으면 자동으로 이어서 진행해요.
              </p>
            )}
          </div>
        )}

        {phase.kind === 'failed' && (
          <div className="mt-2" data-testid="upgrade-failed">
            <h1 className="text-2xl font-extrabold tracking-tight text-danger">업데이트하지 못했어요</h1>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">{phase.message}</p>
            <div className="mt-6 grid gap-2">
              <Button onClick={() => void runUpgrade()} data-testid="upgrade-retry">
                다시 시도
              </Button>
              {phase.snapshotId && (
                <Button variant="secondary" onClick={() => void downloadSnapshot(phase.snapshotId!)}>
                  임시 복사본을 파일로 받기
                </Button>
              )}
              <Button variant="secondary" onClick={() => void downloadCurrentRaw().catch(console.error)} data-testid="upgrade-download-current">
                현재 데이터를 파일로 받기
              </Button>
            </div>
          </div>
        )}

        {phase.kind === 'mismatch' && (
          <div className="mt-2" data-testid="upgrade-mismatch">
            <h1 className="text-2xl font-extrabold tracking-tight text-warn">업데이트 후 확인에서 차이가 보여요</h1>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">
              아무것도 지우거나 되돌리지 않았어요. 업데이트 직전 임시 복사본을 파일로 받아 보관해 주세요.
            </p>
            <ul className="mt-3 list-disc pl-5 text-sm text-muted">
              {phase.verification.tables
                .filter((t) => !t.identical)
                .map((t) => (
                  <li key={t.table}>
                    {tableLabel(t.table)}: 전 {t.before}건 · 후 {t.after}건
                  </li>
                ))}
              {phase.verification.newTables
                .filter((n) => n.count !== n.expected)
                .map((n) => (
                  <li key={n.table}>
                    {tableLabel(n.table)}: {n.count}건 (기록 {String(n.expected)}건)
                  </li>
                ))}
            </ul>
            <div className="mt-6 grid gap-2">
              <Button onClick={() => void downloadSnapshot(phase.snapshotId)}>임시 복사본을 파일로 받기</Button>
              <Button variant="ghost" onClick={() => setPhase({ kind: 'ready' })}>
                그래도 앱 열기
              </Button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
