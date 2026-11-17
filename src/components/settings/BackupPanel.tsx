import { useEffect, useRef, useState } from 'react';
import { backupStore, snapshotStore } from '@/repositories';
import type { SnapshotSummary } from '@/repositories/backupStore';
import { useConfirm } from '@/hooks/useConfirm';
import { useToast } from '@/hooks/useToast';
import { backupFileName, type BackupFile } from '@/services/backup/backupFormat';
import {
  applyRestore,
  createBackup,
  parseBackupText,
  previewRestore,
  serializeBackup,
  snapshotToBackupFile,
  type RestoreResult,
} from '@/services/backup/backupService';
import { tableLabel, type RestorePlan } from '@/services/backup/restorePlan';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { canShareFiles, downloadTextFile, shareTextFile } from '@/utils/download';
import { qaDb } from '@/services/qa';
import { exportAiNotes, planAiNotesRestore, restoreAiNotes, validateAiNotes, type AiNotesBlock, type AiNotesPlan } from '@/services/backup/aiNotesBackup';

/** 학습 데이터 백업 + (있으면) AI 부가 기록 블록 */
const createFullBackup = async () => {
  const file = await createBackup(backupStore);
  const notes = await exportAiNotes(qaDb);
  return notes ? { ...file, aiNotes: notes } : file;
};

const LAST_BACKUP_KEY = 'mes:lastBackupFileAt';
const readLastBackup = () => {
  try {
    return localStorage.getItem(LAST_BACKUP_KEY);
  } catch {
    return null;
  }
};
const writeLastBackup = (iso: string) => {
  try {
    localStorage.setItem(LAST_BACKUP_KEY, iso);
  } catch {
    /* 저장 못 해도 백업 자체에는 영향 없음 */
  }
};

const fmt = (iso: string) =>
  new Date(iso).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const REASON_KO: Record<string, string> = {
  before_restore: '복원 직전',
  manual: '직접 만듦',
};

interface StorageInfo {
  supported: boolean;
  persisted: boolean | null;
  usage: number | null;
  quota: number | null;
}

async function readStorage(): Promise<StorageInfo> {
  const s = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!s) return { supported: false, persisted: null, usage: null, quota: null };
  const [persisted, est] = await Promise.all([
    s.persisted ? s.persisted().catch(() => null) : Promise.resolve(null),
    s.estimate ? s.estimate().catch(() => null) : Promise.resolve(null),
  ]);
  return { supported: true, persisted, usage: est?.usage ?? null, quota: est?.quota ?? null };
}

const mb = (n: number | null) => (n == null ? '—' : `${(n / 1024 / 1024).toFixed(1)}MB`);

/** 설정 화면 — B0 백업·복원 */
export function BackupPanel() {
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [lastBackup, setLastBackup] = useState<string | null>(readLastBackup);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [pending, setPending] = useState<{ fileName: string; backup: BackupFile; plan: RestorePlan; notes: { block: AiNotesBlock | null; plan: AiNotesPlan | null; errors: string[] | null } } | null>(null);
  const [notesResult, setNotesResult] = useState<string | null>(null);
  const [fileErrors, setFileErrors] = useState<string[] | null>(null);
  const [result, setResult] = useState<(RestoreResult & { replacedMeta: string[] }) | null>(null);
  /** 바꿀 수 있는 설정(빈 기본값) 중 사용자가 바꾸기로 고른 키 — 기본은 바꾸지 않음 */
  const [replaceChoice, setReplaceChoice] = useState<Record<string, boolean>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const shareable = canShareFiles();

  const refresh = async () => {
    setStorage(await readStorage());
    setSnapshots(await snapshotStore.list().catch(() => []));
  };
  useEffect(() => {
    void refresh();
  }, []);

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

  /** 현재 데이터를 백업 파일로 */
  const exportNow = async (prefix?: string) => {
    const file = await createFullBackup();
    const name = backupFileName(new Date(), prefix);
    downloadTextFile(name, serializeBackup(file));
    const now = new Date().toISOString();
    writeLastBackup(now);
    setLastBackup(now);
    return name;
  };

  const onPickFile = async (f: File | undefined) => {
    setFileErrors(null);
    setPending(null);
    setResult(null);
    if (!f) return;
    await run(async () => {
      const parsed = parseBackupText(await f.text(), backupStore.schemaVersion());
      if (!parsed.ok) {
        setFileErrors(parsed.errors);
        return;
      }
      setReplaceChoice({});
      const nv = validateAiNotes((parsed.backup as BackupFile).aiNotes);
      const notes = nv.ok ? { block: nv.block, plan: nv.block ? await planAiNotesRestore(qaDb, nv.block) : null, errors: null } : { block: null, plan: null, errors: nv.errors };
      setNotesResult(null);
      setPending({ fileName: f.name, backup: parsed.backup, plan: await previewRestore(backupStore, parsed.backup), notes });
    });
    if (fileInput.current) fileInput.current.value = '';
  };

  const onRestore = () =>
    run(async () => {
      if (!pending) return;
      // 1) 실제 백업: 지금 데이터를 먼저 파일로 받는다
      const savedAs = await exportNow('my-english-study-before-restore');
      const { plan } = pending;
      const chosen = plan.replaceableMeta.filter((m) => replaceChoice[m.key]);
      const keptDefault = plan.replaceableMeta.filter((m) => !replaceChoice[m.key]);
      const metaLines = [
        ...chosen.map((m) => `• ${m.label}: 백업 값으로 바꿉니다 (${m.summary})`),
        ...keptDefault.map((m) => `• ${m.label}: 이 기기 값을 그대로 둡니다`),
      ];
      const ok = await confirm({
        title: '복원할까요?',
        message:
          `복원 전 현재 데이터를 '${savedAs}' 파일로 받았어요. 파일 앱에 저장됐는지 확인해 주세요.\n\n` +
          `새로 추가 ${plan.totals.add}개 · 이미 있음 ${plan.totals.same}개 · 충돌 ${plan.totals.conflict}개\n` +
          '기존 데이터는 덮어쓰거나 지우지 않아요. 충돌 항목은 가져오지 않아요.' +
          (metaLines.length ? `\n\n설정\n${metaLines.join('\n')}` : ''),
        confirmLabel: '복원하기',
      });
      if (!ok) return;
      // 2) 임시 안전 복사본 자동 생성 + 추가 전용 복원
      const res = await applyRestore(backupStore, snapshotStore, pending.backup, {
        replaceMeta: chosen.map((m) => ({ key: m.key, expectedDeviceValue: m.deviceValue })),
      });
      // 3) AI 부가 기록 (있고 검사를 통과했을 때만, 추가만) — 문제가 있으면 이 블록만 건너뜀
      let notesAdded = 0;
      if (pending.notes.block) notesAdded = await restoreAiNotes(qaDb, pending.notes.block);
      setNotesResult(pending.notes.errors ? `AI 기록은 문제가 있어 건너뛰었어요 (${pending.notes.errors[0]})` : pending.notes.block ? `AI 기록 ${notesAdded}개 추가` : null);
      setResult(res);
      setPending(null);
      await refresh();
      toast(`복원했어요 · ${res.plan.totals.add}개 추가${notesAdded ? ` · AI 기록 ${notesAdded}개` : ''}${res.replacedMeta.length ? ' · 학습 순서 바꿈' : ''}`);
    });

  const onPersist = () =>
    run(async () => {
      const granted = await navigator.storage?.persist?.();
      toast(granted ? '이 기기에 저장 공간 유지를 요청했어요' : '브라우저가 요청을 받아들이지 않았어요. 홈 화면에 추가하면 허용될 수 있어요', granted ? 'success' : 'info');
      await refresh();
    });

  const shownPlan = result?.plan ?? pending?.plan ?? null;

  return (
    <div className="space-y-4" data-testid="backup-panel">
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold">백업 파일 받기</p>
          <Badge tone="ok">실제 백업</Badge>
        </div>
        <p className="text-sm text-muted">
          모든 학습 데이터(영상·표현·대화문·즐겨찾기·복습 상태·학습 기록)와 AI 질문·✨ 기록을 JSON 파일 하나로 받아요. 이 파일이 실제 백업이에요. iPad라면 파일 앱의 ‘다운로드’에
          저장되니, iCloud Drive 등 기기 밖 다른 곳에도 옮겨 두세요.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy} onClick={() => run(async () => { const n = await exportNow(); toast(`${n} 파일을 받았어요`); })} data-testid="export-backup">
            백업 파일 받기
          </Button>
          {shareable && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const file = await createFullBackup();
                  await shareTextFile(backupFileName(), serializeBackup(file));
                })
              }
            >
              공유로 보내기
            </Button>
          )}
          <span className="text-sm text-muted" data-testid="last-backup">
            {lastBackup ? `이 기기에서 마지막으로 받은 백업: ${fmt(lastBackup)}` : '이 기기에서 받은 백업 파일이 아직 없어요'}
          </span>
        </div>
        <p className="text-xs text-subtle">파일에는 학습 기록 전체가 들어 있어요. 다른 사람에게 보내지 않도록 주의해 주세요. (YouTube API 키는 서버에만 있어 파일에 들어가지 않아요)</p>
      </Card>

      <Card className="space-y-3 p-4">
        <p className="font-semibold">백업 파일로 복원</p>
        <p className="text-sm text-muted">
          기존 데이터는 덮어쓰거나 지우지 않고, 없는 것만 추가해요. 이 기기에 같은 항목이 다른 내용으로 있거나, 연결된 영상·표현·대화문을 찾을 수 없는 항목은 가져오지
          않고 충돌 목록에 보여 드려요. 복원 직전에는 현재 데이터를 백업 파일로 먼저 받아요.
        </p>
        <p className="text-xs text-subtle">
          새 기기로 옮길 때: 이 기기에 샘플 데이터만 있다면, 위 ‘샘플 데이터 삭제’를 먼저 하면 백업과 똑같이 옮겨져요. 샘플이 남아 있으면 같은 샘플 항목이 충돌로
          표시될 수 있어요.
        </p>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={(e) => onPickFile(e.target.files?.[0])}
          data-testid="restore-file"
          className="block w-full text-sm file:mr-3 file:rounded-xl file:border-0 file:bg-brand-soft file:px-3 file:py-2 file:font-semibold file:text-brand-strong"
        />
        {fileErrors && (
          <div role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger" data-testid="restore-errors">
            <p className="font-semibold">이 파일은 복원할 수 없어요</p>
            <ul className="mt-1 list-disc pl-5">
              {fileErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}
        {shownPlan && (
          <div className="space-y-3" data-testid={result ? 'restore-result' : 'restore-preview'}>
            <p className="text-sm">
              {result ? <b>복원 결과</b> : <b>미리보기 · {pending?.fileName}</b>}{' '}
              <span className="text-muted">
                ({shownPlan.mode === 'empty' ? '빈 기기 — 파일 그대로 복원' : '병합 — 없는 것만 추가'}
                {pending ? ` · 백업 시각 ${fmt(pending.backup.exportedAt)}` : ''})
              </span>
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-muted">
                    <th className="py-1.5 font-semibold">종류</th>
                    <th className="py-1.5 text-right font-semibold">파일</th>
                    <th className="py-1.5 text-right font-semibold">추가</th>
                    <th className="py-1.5 text-right font-semibold">이미 있음</th>
                    <th className="py-1.5 text-right font-semibold">충돌</th>
                  </tr>
                </thead>
                <tbody>
                  {shownPlan.tables.map((t) => (
                    <tr key={t.table} className="border-b border-line/60" data-testid={`plan-${t.table}`}>
                      <td className="py-1.5">{tableLabel(t.table)}</td>
                      <td className="py-1.5 text-right">{t.inBackup}</td>
                      <td className="py-1.5 text-right font-semibold">{t.add}</td>
                      <td className="py-1.5 text-right">{t.same}</td>
                      <td className={`py-1.5 text-right ${t.conflict ? 'font-semibold text-warn' : ''}`}>{t.conflict}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {shownPlan.conflicts.length > 0 && (
              <details className="rounded-xl bg-warn-soft/60 p-3 text-sm" data-testid="conflict-list">
                <summary className="cursor-pointer font-semibold">충돌 {shownPlan.conflicts.length}개 — 가져오지 않음 (기존 데이터 그대로)</summary>
                <ul className="mt-2 space-y-1">
                  {shownPlan.conflicts.slice(0, 100).map((c) => (
                    <li key={`${c.table}:${c.id}`}>
                      <b>{tableLabel(c.table)}</b> <span className="text-subtle">{c.id.slice(0, 8)}</span> — {c.detail}
                    </li>
                  ))}
                  {shownPlan.conflicts.length > 100 && <li className="text-muted">… 외 {shownPlan.conflicts.length - 100}개</li>}
                </ul>
              </details>
            )}
            {pending && shownPlan.replaceableMeta.length > 0 && (
              <div className="rounded-xl border border-line bg-canvas p-3 text-sm" data-testid="replaceable-meta">
                <p className="font-semibold">바꿀 수 있는 설정 — 고르지 않으면 바꾸지 않아요</p>
                <p className="mt-0.5 text-xs text-subtle">이 기기가 처음 열릴 때 자동으로 만든 빈 기본값이라서 백업 값으로 바꿀 수 있어요. 직접 정한 값은 이 목록에 나오지 않고 절대 바꾸지 않아요.</p>
                {shownPlan.replaceableMeta.map((m) => (
                  <label key={m.key} className="mt-2 flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 size-4"
                      checked={!!replaceChoice[m.key]}
                      onChange={(e) => setReplaceChoice((c) => ({ ...c, [m.key]: e.target.checked }))}
                      data-testid={`replace-${m.key}`}
                    />
                    <span>
                      <b>{m.label}</b> 설정을 백업 값으로 바꾸기
                      <br />
                      <span className="text-muted">{m.summary}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            {result && result.replacedMeta.length > 0 && (
              <p className="text-sm" data-testid="replaced-meta">설정을 백업 값으로 바꿨어요: 학습 순서</p>
            )}
            {shownPlan.tables.some((t) => t.skipped > 0) && (
              <p className="text-xs text-subtle">앱 설정 중 기기마다 따로 두는 값(처음 실행일·DB 버전)은 이 기기 값을 그대로 유지해요.</p>
            )}
            {shownPlan.preexistingBrokenLinks.length > 0 && (
              <p className="text-xs text-subtle">
                원본에서 이미 연결이 끊겨 있던 항목 {shownPlan.preexistingBrokenLinks.length}개는 고치거나 새로 연결하지 않고 원본 그대로 옮겨요.
              </p>
            )}
            {pending && (
              <p className="text-sm text-muted" data-testid="restore-ainotes">
                {pending.notes.errors
                  ? `AI 질문·✨ 기록: 문제가 있어 이 부분만 건너뛰어요 (${pending.notes.errors[0]}). 학습 데이터는 그대로 복원돼요.`
                  : pending.notes.plan
                    ? `AI 질문·✨ 기록: 새로 추가 ${pending.notes.plan.add}개 · 이미 있음 ${pending.notes.plan.same}개 (추가만 해요)`
                    : 'AI 질문·✨ 기록: 이 백업 파일에는 없어요.'}
              </p>
            )}
            {result && notesResult && (
              <p className="text-sm text-muted" data-testid="restore-ainotes-result">
                {notesResult}
              </p>
            )}
            {pending && (
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy || (shownPlan.totals.add === 0 && !shownPlan.replaceableMeta.some((m) => replaceChoice[m.key]) && !(pending.notes.plan && pending.notes.plan.add > 0))}
                  onClick={onRestore}
                  data-testid="restore-apply"
                >
                  현재 데이터 백업 받고 복원
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setPending(null)}>
                  취소
                </Button>
              </div>
            )}
            {pending && shownPlan.totals.add === 0 && shownPlan.replaceableMeta.length === 0 && <p className="text-sm text-muted">새로 추가할 항목이 없어요.</p>}
          </div>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold">임시 안전 복사본</p>
          <Badge tone="warn">실제 백업 아님</Badge>
        </div>
        <p className="text-sm text-muted">
          복원이나 앱 업데이트(DB 변경) 직전에 앱이 자동으로 만드는 임시 안전장치예요. 이 기기의 같은 브라우저 안에만 있어서, 브라우저 데이터가 지워지거나 기기를
          잃어버리면 함께 사라져요. 오래 보관하려면 ‘파일로 받기’로 실제 백업 파일을 만들어 두세요.
        </p>
        {snapshots.length === 0 ? (
          <p className="text-sm text-subtle" data-testid="snapshot-empty">아직 없어요.</p>
        ) : (
          <ul className="divide-y divide-line text-sm" data-testid="snapshot-list">
            {snapshots.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="font-semibold">{fmt(s.createdAt)}</span>
                <span className="text-muted">
                  {REASON_KO[s.reason] ?? s.reason} · 레코드 {Object.values(s.counts).reduce((a, b) => a + b, 0)}개
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  className="ml-auto"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const file = await snapshotToBackupFile(snapshotStore, s.id);
                      if (file) downloadTextFile(backupFileName(new Date(s.createdAt), 'my-english-study-snapshot'), serializeBackup(file));
                    })
                  }
                >
                  파일로 받기
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="space-y-2 p-4">
        <p className="font-semibold">이 기기의 저장 공간</p>
        {storage && !storage.supported ? (
          <p className="text-sm text-muted">이 브라우저는 저장 공간 정보를 알려 주지 않아요.</p>
        ) : (
          <p className="text-sm text-muted" data-testid="storage-status">
            저장 공간 유지: <b className="text-ink">{storage?.persisted == null ? '확인 불가' : storage.persisted ? '허용됨' : '허용 안 됨'}</b> · 사용{' '}
            {mb(storage?.usage ?? null)} / 가능 {mb(storage?.quota ?? null)}
          </p>
        )}
        <p className="text-xs text-subtle">
          ‘허용 안 됨’이면 브라우저가 공간이 부족할 때 데이터를 지울 수 있어요. iPad에서는 홈 화면에 추가해 쓰면 더 안전하고, 그래도 정기적으로 백업 파일을 받아 두세요.
        </p>
        {storage?.supported && !storage.persisted && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={onPersist} data-testid="request-persist">
            저장 공간 유지 요청
          </Button>
        )}
      </Card>
    </div>
  );
}
