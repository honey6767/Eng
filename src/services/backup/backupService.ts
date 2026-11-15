import type { BackupStore, SnapshotStore, SnapshotRecord } from '@/repositories/backupStore';
import { createId } from '@/utils/id';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  computeChecksum,
  countTables,
  validateBackup,
  type BackupFile,
  type BackupTables,
  type ValidationResult,
} from './backupFormat';
import { findBrokenLinks, planRestore, type RestorePlan } from './restorePlan';
import { canonicalJson } from './sha256';

/**
 * B0 — 백업·복원 서비스
 *
 * - 내보내기는 읽기만 한다 (기존 데이터 변경 없음).
 * - 복원은 추가만 한다 (planRestore가 고른 레코드를 bulkAdd). 덮어쓰기·삭제 없음.
 * - 복원 전에는 반드시 현재 상태의 백업 파일(실제 백업)과 임시 안전 복사본을 만든다.
 */

export async function createBackup(store: BackupStore, now = new Date()): Promise<BackupFile> {
  const tables = await store.readAll();
  const schemaVersion = store.schemaVersion();
  return buildBackupFile(tables, schemaVersion, now);
}

export function buildBackupFile(tables: BackupTables, schemaVersion: number, now = new Date()): BackupFile {
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    app: { name: 'My English Study' },
    schemaVersion,
    exportedAt: now.toISOString(),
    counts: countTables(tables),
    integrity: { brokenLinks: findBrokenLinks(tables).length },
    checksum: { algorithm: 'SHA-256', value: computeChecksum(schemaVersion, tables) },
    tables,
  };
}

export function serializeBackup(file: BackupFile): string {
  return JSON.stringify(file);
}

/** 파일 텍스트 → 검사 결과 */
export function parseBackupText(text: string, currentSchemaVersion: number): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['JSON 파일을 읽을 수 없어요. 파일이 잘렸거나 다른 형식이에요.'] };
  }
  return validateBackup(parsed, currentSchemaVersion);
}

/** 복원 미리보기 — 아무것도 쓰지 않는다 */
export async function previewRestore(store: BackupStore, backup: BackupFile): Promise<RestorePlan> {
  return planRestore(backup.tables, await store.readAll());
}

export interface RestoreResult {
  plan: RestorePlan;
  /** 복원 직전 만든 임시 안전 복사본 id */
  snapshotId: string;
}

/**
 * 복원 실행.
 * 미리보기 이후 기기 데이터가 바뀌었을 수 있으므로 계획을 다시 계산한 뒤, 추가할 레코드만 한 번에 넣는다.
 * 쓰기 도중 문제가 생기면 트랜잭션 전체가 취소되어 기존 데이터는 그대로 남는다.
 */
export interface ApplyRestoreOptions {
  /**
   * 사용자가 미리보기에서 확인한 '바꿀 수 있는 설정'(빈 기본값) 키.
   * 다시 계산한 계획에서도 바꿀 수 있는 설정으로 남아 있고, 미리보기 때 본 이 기기 값과 지금 값이 같을 때만 바꾼다.
   * 그 밖의 키(사용자가 정한 값)는 넘겨도 무시한다.
   */
  replaceMeta?: { key: string; expectedDeviceValue: unknown }[];
  now?: Date;
}

export async function applyRestore(
  store: BackupStore,
  snapshots: SnapshotStore,
  backup: BackupFile,
  options: ApplyRestoreOptions = {},
): Promise<RestoreResult & { replacedMeta: string[] }> {
  const now = options.now ?? new Date();
  const current = await store.readAll();
  const snapshotId = await saveSnapshot(snapshots, current, store.schemaVersion(), 'before_restore', now);
  const plan = planRestore(backup.tables, current);
  const replacements = (options.replaceMeta ?? []).flatMap((want) => {
    const r = plan.replaceableMeta.find((m) => m.key === want.key);
    if (!r || canonicalJson(r.deviceValue) !== canonicalJson(want.expectedDeviceValue)) return [];
    return [{ key: r.key, expected: r.deviceValue, value: r.backupValue }];
  });
  if ((options.replaceMeta?.length ?? 0) !== replacements.length) {
    throw new Error('미리보기 이후 설정이 바뀌어 복원을 취소했어요. 다시 미리보기 해 주세요.');
  }
  await store.addRows(plan.toAdd, replacements);
  return { plan, snapshotId, replacedMeta: replacements.map((r) => r.key) };
}

/** 임시 안전 복사본 만들기 (같은 기기 브라우저 안 — 실제 백업 아님) */
export async function saveSnapshot(
  snapshots: SnapshotStore,
  tables: BackupTables,
  schemaVersion: number,
  reason: string,
  now = new Date(),
): Promise<string> {
  const record: SnapshotRecord = {
    id: createId(),
    createdAt: now.toISOString(),
    reason,
    schemaVersion,
    counts: countTables(tables),
    checksum: computeChecksum(schemaVersion, tables),
    tables,
  };
  await snapshots.save(record);
  return record.id;
}

export async function createSnapshot(store: BackupStore, snapshots: SnapshotStore, reason: string, now = new Date()) {
  return saveSnapshot(snapshots, await store.readAll(), store.schemaVersion(), reason, now);
}

/** 임시 복사본을 백업 파일 형식으로 — 파일로 내려받아 실제 백업으로 보관할 수 있게 */
export async function snapshotToBackupFile(snapshots: SnapshotStore, id: string): Promise<BackupFile | null> {
  const s = await snapshots.get(id);
  if (!s) return null;
  return buildBackupFile(s.tables, s.schemaVersion, new Date(s.createdAt));
}
