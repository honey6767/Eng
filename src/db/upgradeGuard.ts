import Dexie from 'dexie';
import type { StudyDatabase } from './database';
import { CURRENT_SCHEMA_VERSION, META_MIGRATION_LOG } from './migrations';
import { V2_TABLE_NAMES, V3_NEW_TABLE_NAMES, type TableName } from './tables';
import type { MigrationLog } from './upgradeV2toV3';
import type { SnapshotStore } from '@/repositories/backupStore';
import type { BackupTables } from '@/services/backup/backupFormat';
import { computeChecksum } from '@/services/backup/backupFormat';
import { saveSnapshot } from '@/services/backup/backupService';
import { canonicalJson, sha256Hex } from '@/services/backup/sha256';

/**
 * v2 → v3 업그레이드 안전장치 (앱이 Dexie v3로 DB를 열기 전·후)
 *
 * 1. 현재 버전 확인: 버전을 지정하지 않고 열어 버전만 읽는다. DB가 없으면 만들지 않는다.
 * 2. 저장 공간 확인: 남은 공간이 현재 사용량의 2배 미만이면 멈춘다.
 * 3. 임시 안전 복사본: 기존 테이블 12개를 버전 없이 직접 읽어 별도 저장소(my-english-study-snapshots)에 저장하고,
 *    다시 읽어 개수·검증값이 같은지 확인한다. 실패하면 업그레이드하지 않는다.
 * 4. 업그레이드 직후 검증: 기존 12개 테이블이 업그레이드 전과 레코드 단위로 완전히 같은지,
 *    새 테이블 개수가 migrationLog와 맞는지 비교한다. 다르면 경고만 하고 아무것도 지우거나 되돌리지 않는다.
 */

/** Dexie는 선언 버전 × 10을 IndexedDB 버전으로 저장한다 (v2 = 20, v3 = 30) */
export const DEXIE_VERSION_FACTOR = 10;

export type UpgradeErrorCode = 'insufficient_storage' | 'snapshot_failed' | 'snapshot_verify_failed' | 'open_failed';

export class UpgradeError extends Error {
  constructor(
    readonly code: UpgradeErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export type DbUpgradeStatus =
  | { kind: 'fresh' }
  | { kind: 'current' }
  | { kind: 'needs_upgrade'; fromVersion: number }
  | { kind: 'too_new'; schemaVersion: number };

/** IndexedDB의 현재 버전(원시 값). DB가 없으면 null — 이때 DB를 만들지 않도록 생성 트랜잭션을 취소한다 */
export function getNativeDbVersion(name: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let creating = false;
    const req = indexedDB.open(name);
    req.onupgradeneeded = () => {
      // 버전 없이 열었는데 업그레이드가 필요하다 = DB가 없어서 새로 만드는 중 → 취소해 만들지 않는다
      creating = true;
      req.transaction?.abort();
    };
    req.onsuccess = () => {
      const version = req.result.version;
      req.result.close();
      resolve(version);
    };
    req.onerror = (e) => {
      if (creating) {
        e.preventDefault();
        resolve(null);
      } else reject(req.error);
    };
  });
}

export async function getUpgradeStatus(name: string, target = CURRENT_SCHEMA_VERSION): Promise<DbUpgradeStatus> {
  const native = await getNativeDbVersion(name);
  if (native === null) return { kind: 'fresh' };
  const schemaVersion = Math.round(native / DEXIE_VERSION_FACTOR);
  if (schemaVersion === target) return { kind: 'current' };
  if (schemaVersion > target) return { kind: 'too_new', schemaVersion };
  return { kind: 'needs_upgrade', fromVersion: schemaVersion };
}

/** 버전 선언 없이(동적 모드) 열어 지금 DB에 있는 테이블을 그대로 읽는다. 쓰기는 하지 않는다 */
export async function readRawTables(name: string, names: readonly TableName[] = V2_TABLE_NAMES): Promise<BackupTables> {
  const raw = new Dexie(name);
  await raw.open();
  try {
    const present = new Set(raw.tables.map((t) => t.name));
    const wanted = names.filter((n) => present.has(n));
    const out = {} as BackupTables;
    await raw.transaction('r', wanted.map((n) => raw.table(n)), async () => {
      for (const n of names) out[n] = present.has(n) ? ((await raw.table(n).toArray()) as Record<string, unknown>[]) : [];
    });
    return out;
  } finally {
    raw.close();
  }
}

/** 남은 저장 공간이 현재 사용량의 2배 미만이면 멈춘다 (브라우저가 값을 주지 않으면 검사 생략) */
export async function checkStorage(estimate: (() => Promise<StorageEstimate>) | undefined = globalThis.navigator?.storage?.estimate?.bind(globalThis.navigator.storage)) {
  if (!estimate) return { checked: false as const };
  const { usage = 0, quota } = await estimate();
  if (typeof quota !== 'number') return { checked: false as const };
  const free = quota - usage;
  if (free < usage * 2) {
    throw new UpgradeError('insufficient_storage', `저장 공간이 부족해요. 남은 공간 ${Math.round(free / 1e6)}MB, 필요한 여유 ${Math.round((usage * 2) / 1e6)}MB 이상.`);
  }
  return { checked: true as const, usage, quota };
}

export interface SnapshotResult {
  snapshotId: string;
  schemaVersion: number;
  /** 업그레이드 전에 읽은 기존 12개 테이블 (검증 기준) */
  before: BackupTables;
}

/** 업그레이드 직전 임시 안전 복사본을 만들고, 다시 읽어 개수·검증값을 확인한다 */
export async function snapshotBeforeUpgrade(snapshots: SnapshotStore, name: string, now = new Date()): Promise<SnapshotResult> {
  const native = await getNativeDbVersion(name);
  if (native === null) throw new UpgradeError('snapshot_failed', '업그레이드할 데이터가 없어요.');
  const schemaVersion = Math.round(native / DEXIE_VERSION_FACTOR);
  let before: BackupTables;
  let snapshotId: string;
  try {
    before = await readRawTables(name, V2_TABLE_NAMES);
    snapshotId = await saveSnapshot(snapshots, before, schemaVersion, 'before_upgrade_v3', now);
  } catch (e) {
    throw new UpgradeError('snapshot_failed', '임시 안전 복사본을 만들지 못했어요. 업그레이드를 하지 않았어요.', e);
  }
  const saved = await snapshots.get(snapshotId);
  const ok =
    !!saved &&
    computeChecksum(saved.schemaVersion, saved.tables) === saved.checksum &&
    V2_TABLE_NAMES.every((t) => saved.counts[t] === before[t].length && (saved.tables[t] ?? []).length === before[t].length);
  if (!ok) throw new UpgradeError('snapshot_verify_failed', '임시 안전 복사본을 다시 읽어 확인했는데 내용이 맞지 않아요. 업그레이드를 하지 않았어요.');
  return { snapshotId, schemaVersion, before };
}

export interface TableComparison {
  table: TableName;
  before: number;
  after: number;
  /** 레코드 단위로 완전히 같은지 (id 순서로 정렬해 비교) */
  identical: boolean;
  checksumBefore: string;
  checksumAfter: string;
  /** 달라진 레코드 id (최대 20개) */
  differingIds: string[];
}

export interface UpgradeVerification {
  ok: boolean;
  tables: TableComparison[];
  newTables: { table: TableName; count: number; expected: number | null }[];
  log: MigrationLog | null;
}

const pkOf = (t: TableName, r: Record<string, unknown>) => String(t === 'appMeta' ? r.key : r.id);

/**
 * 기존 테이블 비교 — 업그레이드가 추가한 appMeta 새 키(migrationLog)만 빼고 비교한다.
 * (기존 레코드에는 필드 추가·값 채우기도 없으므로 그 밖에 빼고 비교할 것은 없다)
 */
export function compareTables(before: BackupTables, after: BackupTables, names: readonly TableName[] = V2_TABLE_NAMES): TableComparison[] {
  return names.map((t) => {
    const strip = (rows: Record<string, unknown>[]) => (t === 'appMeta' ? rows.filter((r) => r.key !== META_MIGRATION_LOG) : rows);
    const sort = (rows: Record<string, unknown>[]) => [...rows].sort((a, b) => pkOf(t, a).localeCompare(pkOf(t, b)));
    const b = sort(before[t] ?? []);
    const a = sort(strip(after[t] ?? []));
    const bj = b.map((r) => canonicalJson(r));
    const aj = a.map((r) => canonicalJson(r));
    const bMap = new Map(b.map((r, i) => [pkOf(t, r), bj[i]]));
    const aMap = new Map(a.map((r, i) => [pkOf(t, r), aj[i]]));
    const differingIds = [...new Set([...bMap.keys(), ...aMap.keys()])].filter((id) => bMap.get(id) !== aMap.get(id)).slice(0, 20);
    return {
      table: t,
      before: b.length,
      after: a.length,
      identical: differingIds.length === 0 && b.length === a.length,
      checksumBefore: sha256Hex(`[${bj.join(',')}]`),
      checksumAfter: sha256Hex(`[${aj.join(',')}]`),
      differingIds,
    };
  });
}

/** Dexie v3로 열고(업그레이드 실행) 곧바로 검증한다 */
export async function openAndVerify(db: StudyDatabase, before: BackupTables, onBlocked?: () => void): Promise<UpgradeVerification> {
  const blocked = () => onBlocked?.();
  db.on('blocked', blocked);
  try {
    await db.open();
  } catch (e) {
    throw new UpgradeError('open_failed', '업그레이드에 실패했어요. 데이터는 이전 버전 그대로 남아 있어요.', e);
  } finally {
    db.on('blocked').unsubscribe(blocked);
  }
  const after = {} as BackupTables;
  const all = [...V2_TABLE_NAMES, ...V3_NEW_TABLE_NAMES];
  await db.transaction('r', all.map((n) => db.table(n)), async () => {
    for (const n of all) after[n] = (await db.table(n).toArray()) as Record<string, unknown>[];
  });
  const tables = compareTables(before, after);
  const logRow = after.appMeta.find((r) => r.key === META_MIGRATION_LOG);
  const log = (logRow?.value as MigrationLog | undefined) ?? null;
  const newTables = V3_NEW_TABLE_NAMES.map((t) => ({ table: t as TableName, count: after[t].length, expected: log ? log.created[t] : null }));
  const ok = log !== null && tables.every((c) => c.identical) && newTables.every((n) => n.count === n.expected);
  return { ok, tables, newTables, log };
}
