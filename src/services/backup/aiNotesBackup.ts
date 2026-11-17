import type { QaDatabase } from '@/services/qa/qaDb';
import { canonicalJson, sha256Hex } from './sha256';

/**
 * 백업 파일의 선택 블록 — AI 부가 기록(질문 기록 · ✨ 분석 결과·시도 기록)
 *
 * 기존 백업 형식과 충돌하지 않게:
 * - format · formatVersion(1) · schemaVersion · tables · counts · checksum 은 그대로 (학습 데이터 백업과 똑같음)
 * - 이 블록은 파일 최상위의 aiNotes 에만 담고, 자기 검증값을 따로 가진다
 *   → 이전 앱은 이 블록을 무시하고 학습 데이터만 복원, 이전 백업 파일에는 블록이 없음
 * - 진행 중 요청 상태(tasks)는 기기별 정보라 담지 않는다
 * - 복원은 추가만 (같은 id가 있으면 그대로 둠). 블록에 문제가 있으면 이 블록만 건너뛰고 학습 데이터는 그대로 복원
 */

export const AI_NOTES_TABLES = ['qaSessions', 'qaTurns', 'phraseSets', 'phraseAttempts'] as const;
export type AiNotesTable = (typeof AI_NOTES_TABLES)[number];

export interface AiNotesBlock {
  version: 1;
  tables: Record<AiNotesTable, Record<string, unknown>[]>;
  counts: Record<AiNotesTable, number>;
  checksum: { algorithm: 'SHA-256'; value: string };
}

const pkOf: Record<AiNotesTable, string> = { qaSessions: 'id', qaTurns: 'id', phraseSets: 'dialogueId', phraseAttempts: 'id' };
const storeOf = (db: QaDatabase, t: AiNotesTable) => (t === 'qaSessions' ? db.sessions : t === 'qaTurns' ? db.turns : t === 'phraseSets' ? db.phraseSets : db.phraseAttempts) as unknown as {
  toArray(): Promise<Record<string, unknown>[]>;
  bulkGet(keys: string[]): Promise<(Record<string, unknown> | undefined)[]>;
  bulkAdd(rows: Record<string, unknown>[]): Promise<unknown>;
};

const checksumOf = (tables: AiNotesBlock['tables']) => sha256Hex(canonicalJson({ version: 1, tables }));

/** 내보내기 (읽기만) — 기록이 하나도 없으면 null (블록을 넣지 않음) */
export async function exportAiNotes(db: QaDatabase): Promise<AiNotesBlock | null> {
  const entries = await Promise.all(AI_NOTES_TABLES.map(async (t) => [t, await storeOf(db, t).toArray()] as const));
  const tables = Object.fromEntries(entries) as AiNotesBlock['tables'];
  if (AI_NOTES_TABLES.every((t) => tables[t].length === 0)) return null;
  return { version: 1, tables, counts: Object.fromEntries(AI_NOTES_TABLES.map((t) => [t, tables[t].length])) as AiNotesBlock['counts'], checksum: { algorithm: 'SHA-256', value: checksumOf(tables) } };
}

export type AiNotesValidation = { ok: true; block: AiNotesBlock } | { ok: false; errors: string[] } | { ok: true; block: null };

/** 블록 검사 — 없으면 block null (이전 백업 파일) */
export function validateAiNotes(input: unknown): AiNotesValidation {
  if (input === undefined || input === null) return { ok: true, block: null };
  const b = input as Partial<AiNotesBlock>;
  const errors: string[] = [];
  if (!b || typeof b !== 'object' || b.version !== 1 || !b.tables || typeof b.tables !== 'object') return { ok: false, errors: ['AI 기록 형식이 아니에요.'] };
  for (const t of AI_NOTES_TABLES) {
    const rows = (b.tables as Record<string, unknown>)[t];
    if (!Array.isArray(rows)) {
      errors.push(`'${t}' 기록이 없어요.`);
      continue;
    }
    if (rows.some((r) => !r || typeof r !== 'object' || typeof (r as Record<string, unknown>)[pkOf[t]] !== 'string')) errors.push(`'${t}'에 id가 없는 항목이 있어요.`);
    if (b.counts?.[t] !== rows.length) errors.push(`'${t}' 개수가 맞지 않아요.`);
  }
  if (Object.keys(b.tables).some((t) => !(AI_NOTES_TABLES as readonly string[]).includes(t))) errors.push('알 수 없는 AI 기록 종류가 있어요.');
  if (errors.length) return { ok: false, errors };
  if (b.checksum?.algorithm !== 'SHA-256' || b.checksum.value !== checksumOf(b.tables as AiNotesBlock['tables'])) return { ok: false, errors: ['AI 기록 검증값이 맞지 않아요.'] };
  return { ok: true, block: b as AiNotesBlock };
}

export interface AiNotesPlan {
  add: number;
  same: number;
  toAdd: Record<AiNotesTable, Record<string, unknown>[]>;
}

/** 복원 미리보기 — 아무것도 쓰지 않는다 */
export async function planAiNotesRestore(db: QaDatabase, block: AiNotesBlock): Promise<AiNotesPlan> {
  const toAdd = {} as AiNotesPlan['toAdd'];
  let add = 0;
  let same = 0;
  for (const t of AI_NOTES_TABLES) {
    const rows = block.tables[t];
    const existing = await storeOf(db, t).bulkGet(rows.map((r) => String(r[pkOf[t]])));
    toAdd[t] = rows.filter((_, i) => !existing[i]);
    add += toAdd[t].length;
    same += rows.length - toAdd[t].length;
  }
  return { add, same, toAdd };
}

/** 추가만 하는 복원 (같은 id가 있으면 그대로 둠) */
export async function restoreAiNotes(db: QaDatabase, block: AiNotesBlock): Promise<number> {
  return db.transaction('rw', [db.sessions, db.turns, db.phraseSets, db.phraseAttempts], async () => {
    const plan = await planAiNotesRestore(db, block);
    for (const t of AI_NOTES_TABLES) if (plan.toAdd[t].length) await storeOf(db, t).bulkAdd(plan.toAdd[t]);
    return plan.add;
  });
}
