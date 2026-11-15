import type { DayAssignment, KeySentence, LearningItem, Video } from '@/types/models';
import { V2_TABLE_NAMES, V3_NEW_TABLE_NAMES, type V2TableName, type V3NewTableName } from './tables';

/**
 * v2 → v3 변환 (순수 함수)
 *
 * DB 업그레이드(Dexie version(3).upgrade)와 v2 백업 파일 변환이 이 함수 하나를 함께 쓴다.
 *
 * 원칙
 * - 입력(v2 테이블 12개)은 읽기만 한다. 기존 레코드를 고치거나 지우지 않는다.
 * - 새 테이블 7개에 넣을 레코드만 만든다. 결과는 입력이 같으면 항상 같다(결정적):
 *   id는 원본 id에서 만들고, 시각은 원본 레코드의 시각을 쓴다.
 *   → 같은 v2 데이터를 DB로 올린 결과와 파일로 변환한 결과가 같고, 같은 파일을 두 번 복원해도 중복이 생기지 않는다.
 */

type Row = Record<string, unknown>;
export type V2Tables = Record<V2TableName, Row[]>;
export type V3NewTables = Record<V3NewTableName, Row[]>;

export interface MigrationWarning {
  code: 'key_sentence_without_expression' | 'missing_expression' | 'duplicate_day_number';
  detail: string;
  ids: string[];
}

export interface MigrationLog {
  fromVersion: number;
  toVersion: 3;
  migratedAt: string;
  /** 업그레이드 전 기존 테이블 레코드 수 (업그레이드 뒤에도 같아야 한다) */
  countsBefore: Record<V2TableName, number>;
  /** 새로 만든 레코드 수 */
  created: Record<V3NewTableName, number>;
  warnings: MigrationWarning[];
}

/** 영상 제목의 ‘[Day N]’ — 대괄호 안의 Day 번호만 인정한다 */
const DAY_IN_TITLE = /\[\s*day\s*0*(\d{1,3})\s*\]/i;

export function parseDayNumber(title: unknown): number | null {
  if (typeof title !== 'string') return null;
  const m = DAY_IN_TITLE.exec(title);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 999 ? n : null;
}

export const dayAssignmentId = (videoId: string) => `day-${videoId}`;
export const migratedLearningItemId = (keySentenceId: string, expressionId: string) => `li-ks-${keySentenceId}-${expressionId}`;

function sampleFlag(src: Row): { isSample?: true } {
  return src.isSample === true ? { isSample: true } : {};
}

export function upgradeV2toV3(v2: V2Tables, migratedAt: string, fromVersion = 2): { newTables: V3NewTables; log: MigrationLog } {
  const newTables = Object.fromEntries(V3_NEW_TABLE_NAMES.map((t) => [t, [] as Row[]])) as V3NewTables;
  const warnings: MigrationWarning[] = [];

  // 1) Day 제안 — 영상 제목을 읽기만 하고 dayAssignments에 새로 기록
  const byDay = new Map<number, string[]>();
  for (const raw of v2.videos) {
    const v = raw as unknown as Video;
    const day = parseDayNumber(v.title);
    if (day === null) continue;
    const row: DayAssignment = {
      id: dayAssignmentId(v.id),
      videoId: v.id,
      dayNumber: day,
      status: 'suggested',
      source: 'title',
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
      ...sampleFlag(raw),
    };
    newTables.dayAssignments.push(row as unknown as Row);
    byDay.set(day, [...(byDay.get(day) ?? []), v.id]);
  }
  for (const [day, ids] of byDay) {
    if (ids.length > 1) warnings.push({ code: 'duplicate_day_number', detail: `Day ${day} 제목을 가진 영상이 ${ids.length}개예요. 모두 제안으로만 두었어요.`, ids });
  }

  // 2) 학습 대상 — 기존 핵심 문장을 읽기만 하고, 연결된 표현마다 learningItems에 새로 기록
  const expressionIds = new Set(v2.expressions.map((e) => String(e.id)));
  for (const raw of v2.keySentences) {
    const ks = raw as unknown as KeySentence;
    const linked = [...new Set([...(ks.expressionIds ?? []), ...(ks.expressionSpans ?? []).map((s) => s.expressionId)])].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    if (linked.length === 0) {
      warnings.push({ code: 'key_sentence_without_expression', detail: '연결된 표현이 없는 핵심 문장 — 학습 대상을 만들지 않았어요(확인 필요).', ids: [ks.id] });
      continue;
    }
    for (const expressionId of linked) {
      if (!expressionIds.has(expressionId)) {
        warnings.push({ code: 'missing_expression', detail: '핵심 문장이 가리키는 표현이 없어요 — 학습 대상을 만들지 않았어요.', ids: [ks.id, expressionId] });
        continue;
      }
      const item: LearningItem = {
        id: migratedLearningItemId(ks.id, expressionId),
        expressionId,
        videoId: ks.videoId ?? null,
        sourceType: 'other',
        dayNumber: null,
        kind: 'key',
        dialogueId: null,
        sourceText: typeof ks.english === 'string' ? ks.english : null,
        timestampSec: typeof ks.timestampSec === 'number' ? ks.timestampSec : null,
        onScreen: false,
        origin: 'migrated',
        status: 'confirmed',
        extractionDraftId: null,
        legacyKeySentenceId: ks.id,
        createdAt: ks.createdAt,
        updatedAt: ks.updatedAt,
        ...sampleFlag(raw),
      };
      newTables.learningItems.push(item as unknown as Row);
    }
  }

  const log: MigrationLog = {
    fromVersion,
    toVersion: 3,
    migratedAt,
    countsBefore: Object.fromEntries(V2_TABLE_NAMES.map((t) => [t, v2[t].length])) as Record<V2TableName, number>,
    created: Object.fromEntries(V3_NEW_TABLE_NAMES.map((t) => [t, newTables[t].length])) as Record<V3NewTableName, number>,
    warnings,
  };
  return { newTables, log };
}
