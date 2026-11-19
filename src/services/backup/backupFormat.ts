import { TABLE_NAMES, V2_TABLE_NAMES, tableNamesForSchema, type TableName } from '@/db/tables';
import { upgradeV2toV3, type V2Tables } from '@/db/upgradeV2toV3';
import { canonicalJson, sha256Hex } from './sha256';
import { primaryKeyOf } from './references';

/**
 * 백업 파일(JSON) 형식
 *
 * - 내려받은 이 파일이 '실제 백업'이다. 기기 안의 임시 복사본(snapshot)과 구분한다.
 * - checksum: 키 순서를 정렬한 { schemaVersion, tables } 의 SHA-256. 파일이 손상·수정되면 복원을 거부한다.
 * - schemaVersion별 테이블 목록(@/db/tables)으로 검사한다: v2 파일 12개, v3 파일 19개.
 *   v2 파일은 검증값을 먼저 확인한 뒤, 메모리에서만 v3로 변환해 복원한다(파일은 바꾸지 않음).
 */

/** 이 앱이 복원할 수 있는 가장 오래된 백업 파일 스키마 (백업 기능은 v2에서 생김) */
export const MIN_RESTORABLE_SCHEMA_VERSION = 2;

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
  /** (선택) AI 부가 기록 — 자기 검증값을 따로 가진다. 위 항목과 검증값에는 영향 없음 */
  aiNotes?: import('./aiNotesBackup').AiNotesBlock;
}

export function computeChecksum(schemaVersion: number, tables: BackupTables): string {
  return sha256Hex(canonicalJson({ schemaVersion, tables }));
}

/** schemaVersion에 해당하는 테이블만 골라 담는다 (v2 = 12개, v3 = 19개) */
export function pickTables(tables: BackupTables, schemaVersion: number): BackupTables {
  const names = tableNamesForSchema(schemaVersion) ?? TABLE_NAMES;
  return Object.fromEntries(names.map((t) => [t, tables[t] ?? []])) as BackupTables;
}

export function countTables(tables: BackupTables, schemaVersion: number): Record<TableName, number> {
  const names = tableNamesForSchema(schemaVersion) ?? TABLE_NAMES;
  return Object.fromEntries(names.map((t) => [t, (tables[t] ?? []).length])) as Record<TableName, number>;
}

/**
 * 검사를 통과한 백업 파일의 데이터를 지금 앱(v3)의 19개 테이블로 맞춘다.
 * - v3 파일: 그대로
 * - v2 파일: 기존 12개 테이블은 그대로 두고, 새 7개 테이블은 DB 업그레이드와 같은 함수(upgradeV2toV3)로 만든다.
 *   (변환 기록 migrationLog는 기기별 기록이라 만들지 않는다)
 */
export function toCurrentTables(backup: BackupFile): BackupTables {
  if (backup.schemaVersion === 3) return backup.tables;
  const v2 = Object.fromEntries(V2_TABLE_NAMES.map((t) => [t, backup.tables[t] ?? []])) as V2Tables;
  const { newTables } = upgradeV2toV3(v2, backup.exportedAt, backup.schemaVersion);
  return { ...v2, ...newTables } as BackupTables;
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
  } else if (f.schemaVersion < MIN_RESTORABLE_SCHEMA_VERSION || !tableNamesForSchema(f.schemaVersion)) {
    errors.push(`이전 버전 앱(DB v${f.schemaVersion})의 파일이에요. 이 버전 변환은 지원하지 않아요. (지금 앱: v${currentSchemaVersion})`);
  }
  // 이 파일의 스키마에 들어 있어야 하는 테이블 목록
  const expected: readonly TableName[] = (typeof f.schemaVersion === 'number' && tableNamesForSchema(f.schemaVersion)) || TABLE_NAMES;

  const tables = f.tables as Record<string, unknown> | undefined;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) {
    errors.push('데이터(tables)가 없어요.');
    return { ok: false, errors };
  }
  const unknownTables = Object.keys(tables).filter((t) => !(expected as readonly string[]).includes(t));
  if (unknownTables.length) errors.push(`알 수 없는 데이터 종류가 있어요: ${unknownTables.join(', ')}`);

  for (const t of expected) {
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

/**
 * 인증 정보는 백업·복원 대상이 아니다.
 * 접근 코드는 localStorage에만 있어 원래 IndexedDB(백업 대상)에 없지만, 혹시라도 앱 설정(appMeta)에
 * 인증처럼 보이는 키가 생기면 내보내지도, 가져오지도 않도록 이름으로 한 번 더 걸러 낸다.
 */
const AUTH_LIKE_KEY = /access.?code|auth|token|bearer|secret|password/i;
export function isAuthLikeMetaKey(key: string): boolean {
  return AUTH_LIKE_KEY.test(key);
}
export function excludeAuthData(tables: BackupTables): BackupTables {
  if (!tables.appMeta.some((m) => isAuthLikeMetaKey(String(m.key)))) return tables;
  return { ...tables, appMeta: tables.appMeta.filter((m) => !isAuthLikeMetaKey(String(m.key))) };
}
