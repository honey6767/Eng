/**
 * 스키마 버전별 테이블 목록
 *
 * - V2_TABLE_NAMES: v1·v2 DB와 v2 백업 파일에 있는 12개 테이블. 순서·이름을 바꾸지 않는다.
 * - V3_NEW_TABLE_NAMES: v3에서 새로 생긴 7개 테이블. 기존 12개 테이블의 레코드는 v3에서도 그대로다.
 * - TABLE_NAMES: 지금 앱(v3)의 전체 19개 테이블.
 */
export const V2_TABLE_NAMES = [
  'playlists',
  'videos',
  'transcripts',
  'expressionNotes',
  'keySentences',
  'dialogues',
  'dialogueCompositions',
  'expressions',
  'reviewStates',
  'dialogueProgress',
  'studyLogs',
  'appMeta',
] as const;

export const V3_NEW_TABLE_NAMES = [
  'learningItems',
  'dayAssignments',
  'studySessions',
  'dialogueDrafts',
  'extractionJobs',
  'extractionDrafts',
  'aiRequests',
] as const;

export const TABLE_NAMES = [...V2_TABLE_NAMES, ...V3_NEW_TABLE_NAMES] as const;

export type V2TableName = (typeof V2_TABLE_NAMES)[number];
export type V3NewTableName = (typeof V3_NEW_TABLE_NAMES)[number];
export type TableName = (typeof TABLE_NAMES)[number];

/** 백업 파일·임시 복사본의 schemaVersion별로 반드시 있어야 하는 테이블 */
export function tableNamesForSchema(schemaVersion: number): readonly TableName[] | null {
  if (schemaVersion === 1 || schemaVersion === 2) return V2_TABLE_NAMES;
  if (schemaVersion === 3) return TABLE_NAMES;
  return null;
}
