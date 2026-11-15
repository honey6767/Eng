import { TABLE_NAMES, type TableName } from '@/db/database';
import { canonicalJson, sha256Hex } from './sha256';
import { primaryKeyOf } from './references';

/**
 * 백업 파일(JSON) 형식
 *
 * - 내려받은 이 파일이 '실제 백업'이다. 기기 안의 임시 복사본(snapshot)과 구분한다.
 * - checksum: 키 순서를 정렬한 { schemaVersion, tables } 의 SHA-256. 파일이 손상·수정되면 복원을 거부한다.
 */

export const BACKUP_FORMAT = 'my-english-study-backup';
export const BACKUP_FORMAT_VERSION = 1;

export type BackupTables = Record<TableName, Record<string, unknown>[]>;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  /** 만든 앱 */
  app: { name: string };
  /** DB 스키마 버전 (Dexie verno) */
  schemaVersion: number;
  exportedAt: string;
  /** 테이블별 레코드 수 */
  counts: Record<TableName, number>;
  /** 내보낼 때 이미 끊겨 있던 연결 수 (원본 상태 그대로 기록) */
  integrity: { brokenLinks: number };
  checksum: { algorithm: 'SHA-256'; value: string };
  tables: BackupTables;
}

export function computeChecksum(schemaVersion: number, tables: BackupTables): string {
  return sha256Hex(canonicalJson({ schemaVersion, tables }));
}

export function countTables(tables: BackupTables): Record<TableName, number> {
  return Object.fromEntries(TABLE_NAMES.map((t) => [t, tables[t].length])) as Record<TableName, number>;
}

export type ValidationResult = { ok: true; backup: BackupFile } | { ok: false; errors: string[] };

/**
 * 파일 내용 검사 — 하나라도 문제가 있으면 복원하지 않는다.
 * @param currentSchemaVersion 지금 앱의 DB 스키마 버전
 */
export function validateBackup(input: unknown, currentSchemaVersion: number): ValidationResult {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['백업 파일 형식이 아니에요 (JSON 객체가 아님).'] };
  const f = input as Partial<BackupFile> & Record<string, unknown>;

  if (f.format !== BACKUP_FORMAT) return { ok: false, errors: ['My English Study 백업 파일이 아니에요.'] };
  if (f.formatVersion !== BACKUP_FORMAT_VERSION) errors.push(`지원하지 않는 백업 형식 버전이에요 (${String(f.formatVersion)}).`);
  if (typeof f.schemaVersion !== 'number' || !Number.isInteger(f.schemaVersion)) {
    errors.push('DB 버전 정보가 없어요.');
  } else if (f.schemaVersion > currentSchemaVersion) {
    errors.push(`더 새로운 버전의 앱(DB v${f.schemaVersion})에서 만든 파일이에요. 앱을 업데이트한 뒤 복원해 주세요. (지금 앱: v${currentSchemaVersion})`);
  } else if (f.schemaVersion < currentSchemaVersion) {
    errors.push(`이전 버전 앱(DB v${f.schemaVersion})의 파일이에요. 이 버전 변환은 아직 지원하지 않아요. (지금 앱: v${currentSchemaVersion})`);
  }

  const tables = f.tables as Record<string, unknown> | undefined;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) {
    errors.push('데이터(tables)가 없어요.');
    return { ok: false, errors };
  }
  const unknownTables = Object.keys(tables).filter((t) => !(TABLE_NAMES as readonly string[]).includes(t));
  if (unknownTables.length) errors.push(`알 수 없는 데이터 종류가 있어요: ${unknownTables.join(', ')}`);

  for (const t of TABLE_NAMES) {
    const rows = tables[t];
    if (!Array.isArray(rows)) {
      errors.push(`'${t}' 데이터가 없거나 형식이 잘못됐어요.`);
      continue;
    }
    const seen = new Set<string>();
    rows.forEach((row, i) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        errors.push(`'${t}' ${i + 1}번째 항목이 올바르지 않아요.`);
        return;
      }
      const pk = (row as Record<string, unknown>)[t === 'appMeta' ? 'key' : 'id'];
      if (typeof pk !== 'string' || pk.length === 0) {
        errors.push(`'${t}' ${i + 1}번째 항목에 id가 없어요.`);
        return;
      }
      const key = primaryKeyOf(t, row as Record<string, unknown>);
      if (seen.has(key)) errors.push(`'${t}'에 같은 id가 두 번 있어요: ${key}`);
      seen.add(key);
    });
    const declared = f.counts?.[t];
    if (declared !== rows.length) errors.push(`'${t}' 개수가 맞지 않아요 (적힌 값 ${String(declared)}, 실제 ${rows.length}).`);
  }
  if (errors.length) return { ok: false, errors };

  const actual = computeChecksum(f.schemaVersion as number, tables as BackupTables);
  if (f.checksum?.algorithm !== 'SHA-256' || f.checksum.value !== actual) {
    return { ok: false, errors: ['검증값이 맞지 않아요. 파일이 손상됐거나 수정된 것 같아요.'] };
  }
  return { ok: true, backup: f as BackupFile };
}

/** 파일 이름: my-english-study-backup-2026-11-15-1432.json (로컬 시각) */
export function backupFileName(date = new Date(), prefix = 'my-english-study-backup'): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${prefix}-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.json`;
}
