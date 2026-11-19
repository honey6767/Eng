import { TABLE_NAMES, type TableName } from '@/db/tables';
import { canonicalJson } from './sha256';
import { primaryKeyOf, referencesOf, uniqueKeysOf, type RowRef } from './references';
import { isAuthLikeMetaKey, type BackupTables } from './backupFormat';

/**
 * 복원 계획 — 실제로 쓰기 전에 무엇을 추가하고 무엇을 건너뛰는지 계산한다.
 *
 * 원칙
 * 1. 기존 레코드는 절대 덮어쓰거나 지우지 않는다. (추가만)
 * 2. 같은 id인데 내용이 다르면 '충돌'로 표시하고 가져오지 않는다.
 * 3. id는 다르지만 같은 대상(같은 YouTube 영상, 같은 표현 문구 등)이 이미 있으면 '충돌' — 중복을 만들지 않는다.
 * 4. 연결 대상(영상·표현·대화문·핵심 문장)이 기기에도 백업에도 없으면 가져오지 않고 '충돌'로 표시한다.
 *    다른 대상에 임의로 연결하지 않는다. 가져오지 못한 레코드에 연결된 레코드도 연쇄적으로 보류된다.
 * 5. 빈 기기 전체 복원(mode='empty')은 파일을 그대로 옮긴다. 원본에서 이미 끊겨 있던 연결은
 *    고치거나 새로 연결하지 않고 원본 그대로 두며, 목록으로 알려 준다.
 */

export type RestoreMode = 'empty' | 'merge';

/** 기기마다 따로 관리하는 앱 설정 — 복원 대상이 아니다 (충돌로 세지 않음). migrationLog는 그 기기의 v3 업그레이드 기록 */
export const DEVICE_META_KEYS = new Set(['initializedAt', 'schemaVersion', 'migrationLog']);

/** 학습 순서(무작위 영상 순서) 설정 키 — services/studyQueue의 META_STUDY_QUEUE와 같은 값 */
export const STUDY_QUEUE_META_KEY = 'studyQueue';

/**
 * 새 기기가 처음 열릴 때 자동으로 만든 '빈 기본값' 학습 순서인지.
 * 순서·학습한 영상이 모두 비어 있고, 회차 1·완료 영상 제외(기본 옵션)일 때만 true.
 * 사용자가 다시 섞었거나(회차 2 이상) 옵션을 바꿨거나 영상이 하나라도 있으면 false → 절대 바꾸지 않는다.
 */
export function isDefaultEmptyStudyQueue(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    v.cycle === 1 &&
    Array.isArray(v.order) && v.order.length === 0 &&
    Array.isArray(v.visited) && v.visited.length === 0 &&
    v.includeCompleted === false
  );
}

/**
 * 사용자가 확인하면 백업 값으로 바꿀 수 있는 설정.
 * 빈 기기 복원(mode='empty')에서, 이 기기 값이 자동으로 만든 빈 기본값일 때만 생긴다.
 */
export interface ReplaceableMeta {
  key: string;
  /** 사람이 읽는 이름 */
  label: string;
  deviceValue: unknown;
  backupValue: unknown;
  /** 화면에 보여 줄 변경 내용 */
  summary: string;
}

export type ConflictKind =
  /** 같은 id, 다른 내용 */
  | 'same_id_different'
  /** 다른 id, 같은 대상 */
  | 'duplicate_target'
  /** 연결 대상이 없음 */
  | 'missing_link';

export interface RestoreConflict {
  table: TableName;
  id: string;
  kind: ConflictKind;
  /** 사람이 읽는 설명 */
  detail: string;
  /** missing_link일 때 끊긴 연결 */
  missing?: RowRef[];
}

export interface TablePlan {
  table: TableName;
  inBackup: number;
  /** 새로 추가할 레코드 */
  add: number;
  /** 이미 똑같이 있음 (건너뜀) */
  same: number;
  /** 충돌로 가져오지 않음 */
  conflict: number;
  /** 기기별 설정이라 건너뜀 */
  skipped: number;
  /** 확인하면 바꿀 수 있음 (빈 기본값 설정) */
  replaceable: number;
}

export interface RestorePlan {
  mode: RestoreMode;
  tables: TablePlan[];
  /** 추가할 레코드 (테이블별) */
  toAdd: BackupTables;
  conflicts: RestoreConflict[];
  /** 빈 기기 복원에서 원본 그대로 옮기는, 원래부터 끊겨 있던 연결 */
  preexistingBrokenLinks: { table: TableName; id: string; missing: RowRef[] }[];
  /** 사용자가 확인하면 백업 값으로 바꿀 수 있는 설정 (기본은 바꾸지 않음) */
  replaceableMeta: ReplaceableMeta[];
  totals: { add: number; same: number; conflict: number };
}

type Row = Record<string, unknown>;
type IdIndex = Record<TableName, Map<string, Row>>;

function indexById(tables: BackupTables): IdIndex {
  return Object.fromEntries(
    TABLE_NAMES.map((t) => [t, new Map((tables[t] ?? []).map((r) => [primaryKeyOf(t, r), r]))]),
  ) as IdIndex;
}

/** appMeta를 뺀 모든 테이블이 비어 있으면 '빈 기기' */
export function isEmptyDatabase(current: BackupTables): boolean {
  return TABLE_NAMES.every((t) => t === 'appMeta' || (current[t] ?? []).length === 0);
}

/** 기기 DB에 원래부터 끊겨 있는 연결 목록 (내보내기 때 기록용) */
export function findBrokenLinks(tables: BackupTables): { table: TableName; id: string; missing: RowRef[] }[] {
  const idx = indexById(tables);
  const out: { table: TableName; id: string; missing: RowRef[] }[] = [];
  for (const t of TABLE_NAMES) {
    for (const row of tables[t] ?? []) {
      const missing = referencesOf(t, row).filter((r) => !idx[r.table].has(r.id));
      if (missing.length) out.push({ table: t, id: primaryKeyOf(t, row), missing });
    }
  }
  return out;
}

const TABLE_KO: Record<TableName, string> = {
  playlists: '재생목록',
  videos: '영상',
  transcripts: '자막',
  expressionNotes: '표현 노트',
  keySentences: '핵심 문장',
  dialogues: '대화문',
  dialogueCompositions: '대화문 구성',
  expressions: '표현',
  reviewStates: '복습 상태',
  dialogueProgress: '대화문 진행',
  studyLogs: '학습 기록',
  appMeta: '앱 설정',
  learningItems: '학습 대상',
  dayAssignments: 'Day 제안·확정',
  studySessions: '학습 세션',
  dialogueDrafts: '대화문 초안',
  extractionJobs: '자동 추출 작업',
  extractionDrafts: '자동 추출 초안',
  aiRequests: 'AI 요청 기록',
};
export const tableLabel = (t: TableName) => TABLE_KO[t];

export function planRestore(backup: BackupTables, current: BackupTables): RestorePlan {
  const mode: RestoreMode = isEmptyDatabase(current) ? 'empty' : 'merge';
  const cur = indexById(current);
  const conflicts: RestoreConflict[] = [];
  const counts = Object.fromEntries(
    TABLE_NAMES.map((t) => [t, { table: t, inBackup: (backup[t] ?? []).length, add: 0, same: 0, conflict: 0, skipped: 0, replaceable: 0 }]),
  ) as Record<TableName, TablePlan>;

  // 기기에 이미 있는 고유 값 (다른 id로 같은 대상이 있는지)
  const curUnique = new Map<string, string>();
  for (const t of TABLE_NAMES) for (const r of current[t] ?? []) for (const u of uniqueKeysOf(t, r)) curUnique.set(u.key, primaryKeyOf(t, r));

  // 1) 후보 선정: 같은 id / 같은 대상 검사
  const replaceableMeta: ReplaceableMeta[] = [];
  const candidates = Object.fromEntries(TABLE_NAMES.map((t) => [t, new Map<string, Row>()])) as IdIndex;
  for (const t of TABLE_NAMES) {
    for (const row of backup[t] ?? []) {
      const id = primaryKeyOf(t, row);
      if (t === 'appMeta' && (DEVICE_META_KEYS.has(id) || isAuthLikeMetaKey(id))) {
        counts[t].skipped++;
        continue;
      }
      const existing = cur[t].get(id);
      if (existing) {
        if (canonicalJson(existing) === canonicalJson(row)) counts[t].same++;
        else if (t === 'appMeta' && mode === 'empty' && id === STUDY_QUEUE_META_KEY && isDefaultEmptyStudyQueue(existing.value)) {
          counts[t].replaceable++;
          replaceableMeta.push({
            key: id,
            label: '학습 순서',
            deviceValue: existing.value,
            backupValue: row.value,
            summary: describeQueueChange(existing.value, row.value),
          });
        } else conflicts.push({ table: t, id, kind: 'same_id_different', detail: `이 기기에 있는 같은 ${tableLabel(t)} 항목과 내용이 달라요. 기존 내용을 그대로 둡니다.` });
        continue;
      }
      const dup = uniqueKeysOf(t, row).find((u) => curUnique.has(u.key) && curUnique.get(u.key) !== id);
      if (dup) {
        conflicts.push({ table: t, id, kind: 'duplicate_target', detail: `같은 대상(${dup.label})의 ${tableLabel(t)} 항목이 이 기기에 다른 id로 이미 있어요. 중복으로 만들지 않습니다.` });
        continue;
      }
      candidates[t].set(id, row);
    }
  }

  // 2) 연결 검사 — 연결 대상이 기기에도, 가져올 후보에도 없으면 보류. 보류가 연쇄될 수 있어 변화가 없을 때까지 반복.
  const preexistingBrokenLinks: RestorePlan['preexistingBrokenLinks'] = [];
  if (mode === 'empty') {
    // 파일 그대로 옮긴다. 원본에서 이미 끊긴 연결은 기록만 한다.
    for (const t of TABLE_NAMES) {
      for (const [id, row] of candidates[t]) {
        const missing = referencesOf(t, row).filter((r) => !candidates[r.table].has(r.id) && !cur[r.table].has(r.id));
        if (missing.length) preexistingBrokenLinks.push({ table: t, id, missing });
      }
    }
  } else {
    let changed = true;
    const held = new Map<string, RestoreConflict>();
    while (changed) {
      changed = false;
      for (const t of TABLE_NAMES) {
        for (const [id, row] of [...candidates[t]]) {
          const missing = referencesOf(t, row).filter((r) => !candidates[r.table].has(r.id) && !cur[r.table].has(r.id));
          if (missing.length) {
            candidates[t].delete(id);
            held.set(`${t}:${id}`, {
              table: t,
              id,
              kind: 'missing_link',
              detail: `연결 대상이 없어요: ${missing.map((m) => `${tableLabel(m.table)}(${m.field})`).join(', ')}. 임의로 연결하지 않고 보류합니다.`,
              missing,
            });
            changed = true;
          }
        }
      }
    }
    conflicts.push(...held.values());
  }

  const toAdd = Object.fromEntries(TABLE_NAMES.map((t) => [t, [...candidates[t].values()]])) as BackupTables;
  for (const t of TABLE_NAMES) counts[t].add = toAdd[t].length;
  for (const c of conflicts) counts[c.table].conflict++;
  const tables = TABLE_NAMES.map((t) => counts[t]);
  return {
    mode,
    tables,
    toAdd,
    conflicts,
    preexistingBrokenLinks,
    replaceableMeta,
    totals: {
      add: tables.reduce((s, x) => s + x.add, 0),
      same: tables.reduce((s, x) => s + x.same, 0),
      conflict: conflicts.length,
    },
  };
}

function describeQueueChange(device: unknown, backup: unknown): string {
  const b = (backup ?? {}) as { order?: unknown[]; visited?: unknown[]; cycle?: unknown };
  const n = Array.isArray(b.order) ? b.order.length : 0;
  const v = Array.isArray(b.visited) ? b.visited.length : 0;
  void device;
  return `이 기기: 빈 기본값(아직 영상 없음) → 백업: 영상 ${n}개의 학습 순서 · ${String(b.cycle ?? '?')}회차 · 이번 회차에 시작한 영상 ${v}개`;
}
