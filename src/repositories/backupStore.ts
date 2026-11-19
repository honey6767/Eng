import Dexie from 'dexie';
import type { StudyDatabase } from '@/db/database';
import { TABLE_NAMES, type TableName } from '@/db/tables';
import type { BackupTables } from '@/services/backup/backupFormat';
import { canonicalJson } from '@/services/backup/sha256';

/**
 * 백업·복원용 저장소 접근 (저장소 계층)
 *
 * - readAll: 모든 테이블을 하나의 읽기 트랜잭션에서 읽는다 (읽는 도중 바뀐 값이 섞이지 않도록).
 * - addRows: 하나의 쓰기 트랜잭션에서 bulkAdd(추가 전용)로만 쓴다.
 *   이미 있는 id가 하나라도 있으면 IndexedDB가 거부하고 트랜잭션 전체가 취소된다 → 기존 레코드를 덮어쓸 수 없다.
 *   delete/clear는 사용하지 않는다.
 * - 예외: 사용자가 확인한 '빈 기본값' 앱 설정(metaReplacements)만, 같은 트랜잭션 안에서
 *   현재 값이 미리보기 때 본 값과 정확히 같을 때에만 바꾼다. 그사이 값이 바뀌었으면 전체를 취소한다.
 */
export interface MetaReplacement {
  key: string;
  /** 미리보기 때 확인한 이 기기 값 — 지금 값이 이것과 다르면 바꾸지 않고 취소 */
  expected: unknown;
  value: unknown;
}

export class MetaChangedError extends Error {
  constructor(key: string) {
    super(`'${key}' 설정이 미리보기 이후 바뀌어 복원을 취소했어요. 다시 미리보기 해 주세요.`);
  }
}

export interface BackupStore {
  schemaVersion(): number;
  readAll(): Promise<BackupTables>;
  addRows(rows: BackupTables, metaReplacements?: MetaReplacement[]): Promise<void>;
}

export function createBackupStore(db: StudyDatabase): BackupStore {
  return {
    schemaVersion: () => db.verno,
    readAll: async () => {
      const tables = TABLE_NAMES.map((n) => db.table(n));
      return db.transaction('r', tables, async () => {
        const out = {} as BackupTables;
        for (const name of TABLE_NAMES) out[name] = (await db.table(name).toArray()) as Record<string, unknown>[];
        return out;
      });
    },
    addRows: async (rows, metaReplacements = []) => {
      const entries = (Object.entries(rows) as [TableName, Record<string, unknown>[]][]).filter(([, r]) => r.length > 0);
      if (entries.length === 0 && metaReplacements.length === 0) return;
      const names = new Set<TableName>(entries.map(([n]) => n));
      if (metaReplacements.length) names.add('appMeta');
      await db.transaction(
        'rw',
        [...names].map((n) => db.table(n)),
        async () => {
          for (const [name, r] of entries) await db.table(name).bulkAdd(r);
          for (const m of metaReplacements) {
            const current = await db.appMeta.get(m.key);
            if (!current || canonicalJson(current.value) !== canonicalJson(m.expected)) throw new MetaChangedError(m.key);
            await db.appMeta.put({ key: m.key, value: m.value });
          }
        },
      );
    },
  };
}

// ─────────────────────────────────────────────
// 임시 안전 복사본 (snapshot)
// ─────────────────────────────────────────────

export const SNAPSHOT_DB_NAME = 'my-english-study-snapshots';

/**
 * 같은 기기·같은 브라우저 안에 두는 '임시 안전 복사본'.
 * DB 업그레이드나 복원 직전에 만드는 안전장치일 뿐, 실제 백업이 아니다.
 * (브라우저 데이터가 지워지거나 기기를 잃어버리면 함께 사라진다 → 실제 백업은 내려받은 JSON 파일)
 * 기존 학습 DB(my-english-study)와는 완전히 별개의 저장소이며, 기존 DB를 건드리지 않는다.
 */
export interface SnapshotRecord {
  id: string;
  createdAt: string;
  /** 만든 이유 (예: 'before_restore', 'before_upgrade_v3', 'manual') */
  reason: string;
  schemaVersion: number;
  counts: Record<TableName, number>;
  checksum: string;
  tables: BackupTables;
}

export type SnapshotSummary = Omit<SnapshotRecord, 'tables'>;

class SnapshotDatabase extends Dexie {
  snapshots!: Dexie.Table<SnapshotRecord, string>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({ snapshots: 'id, createdAt' });
  }
}

export interface SnapshotStore {
  save(record: SnapshotRecord): Promise<void>;
  list(): Promise<SnapshotSummary[]>;
  get(id: string): Promise<SnapshotRecord | undefined>;
}

export function createSnapshotStore(name = SNAPSHOT_DB_NAME): SnapshotStore {
  const sdb = new SnapshotDatabase(name);
  return {
    save: async (record) => {
      await sdb.snapshots.add(record);
    },
    list: async () => {
      const all = await sdb.snapshots.orderBy('createdAt').reverse().toArray();
      return all.map(({ tables: _t, ...rest }) => rest);
    },
    get: (id) => sdb.snapshots.get(id),
  };
}
