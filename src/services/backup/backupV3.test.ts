import { describe, expect, it } from 'vitest';
import { StudyDatabase } from '@/db/database';
import { META_MIGRATION_LOG } from '@/db/migrations';
import { TABLE_NAMES, V2_TABLE_NAMES, V3_NEW_TABLE_NAMES, type TableName } from '@/db/tables';
import { openAndVerify, readRawTables, snapshotBeforeUpgrade } from '@/db/upgradeGuard';
import { createBackupStore, createSnapshotStore } from '@/repositories/backupStore';
import { createV2Fixture } from '@/test/v2Fixture';
import { computeChecksum, validateBackup, type BackupFile, type BackupTables } from './backupFormat';
import { applyRestore, buildBackupFile, createBackup, parseBackupText, previewRestore, serializeBackup } from './backupService';
import { DEVICE_META_KEYS } from './restorePlan';

let n = 0;
const snaps = () => createSnapshotStore(`test-snap-b3-${Date.now()}-${n++}`);
const pk = (t: TableName, r: Record<string, unknown>) => String(t === 'appMeta' ? r.key : r.id);
const sorted = (t: TableName, rows: Record<string, unknown>[]) => [...rows].sort((a, b) => pk(t, a).localeCompare(pk(t, b)));
const freshV3 = async () => {
  const db = new StudyDatabase(`fresh-v3-${Date.now()}-${n++}`);
  await db.open();
  return db;
};
async function readAll(db: StudyDatabase): Promise<BackupTables> {
  const out = {} as BackupTables;
  for (const t of TABLE_NAMES) out[t] = (await db.table(t).toArray()) as Record<string, unknown>[];
  return out;
}
/** 운영 규모 v2 테스트 DB → v2 백업 파일(업그레이드 전) + 안전장치를 거쳐 v3로 올린 DB */
async function migratedFixture() {
  const { name, db: v2 } = await createV2Fixture();
  v2.close();
  const v2Tables = await readRawTables(name, V2_TABLE_NAMES);
  const v2File = buildBackupFile(v2Tables, 2, new Date('2026-11-14T00:00:00Z'));
  const snap = await snapshotBeforeUpgrade(snaps(), name);
  const db = new StudyDatabase(name);
  expect((await openAndVerify(db, snap.before)).ok).toBe(true);
  return { db, v2Tables, v2File };
}
const withoutDeviceMeta = (rows: Record<string, unknown>[]) => rows.filter((r) => !DEVICE_META_KEYS.has(String(r.key)));

describe('백업 v3 — 형식과 왕복', () => {
  it('v3 백업 파일: schemaVersion 3, 테이블 19개, 개수·검증값이 맞고, 빈 기기에 그대로 복원된다', async () => {
    const { db } = await migratedFixture();
    const file = await createBackup(createBackupStore(db));
    expect(file.schemaVersion).toBe(3);
    expect(Object.keys(file.tables).sort()).toEqual([...TABLE_NAMES].sort());
    expect(file.checksum.value).toBe(computeChecksum(3, file.tables));
    const parsed = parseBackupText(serializeBackup(file), 3);
    expect(parsed.ok).toBe(true);

    const target = await freshV3();
    const res = await applyRestore(createBackupStore(target), snaps(), (parsed as { backup: BackupFile }).backup);
    expect(res.plan.mode).toBe('empty');
    expect(res.plan.totals.conflict).toBe(0);
    const src = await readAll(db);
    const out = await readAll(target);
    for (const t of TABLE_NAMES) {
      if (t === 'appMeta') expect(sorted(t, out[t])).toEqual(sorted(t, withoutDeviceMeta(src[t])));
      else expect(sorted(t, out[t]), t).toEqual(sorted(t, src[t]));
    }
    // 기기별 기록(migrationLog)은 다른 기기로 옮기지 않는다
    expect(out.appMeta.some((r) => r.key === META_MIGRATION_LOG)).toBe(false);
  });

  it('v2 앱(지금 배포본)은 v3 파일을 ‘더 새 버전’으로 거부한다', async () => {
    const { db } = await migratedFixture();
    const file = await createBackup(createBackupStore(db));
    const r = validateBackup(file, 2);
    expect(r.ok).toBe(false);
    expect((r as { errors: string[] }).errors.join(' ')).toContain('더 새로운 버전');
  });
});

describe('백업 v3 — 기존 v2 백업 파일 복원 호환성', () => {
  it('v2 파일(테이블 12개)은 검증값 확인 후 통과하고, 빈 v3 기기에 복원한 결과 = DB를 v3로 올린 결과', async () => {
    const { db, v2File } = await migratedFixture();
    const parsed = parseBackupText(serializeBackup(v2File), 3);
    expect(parsed.ok).toBe(true);
    const target = await freshV3();
    const res = await applyRestore(createBackupStore(target), snaps(), (parsed as { backup: BackupFile }).backup);
    expect(res.plan.totals.conflict).toBe(0);
    const migrated = await readAll(db);
    const restored = await readAll(target);
    for (const t of TABLE_NAMES) {
      if (t === 'appMeta') expect(sorted(t, restored[t])).toEqual(sorted(t, withoutDeviceMeta(migrated[t])));
      else expect(sorted(t, restored[t]), t).toEqual(sorted(t, migrated[t]));
    }
  });

  it('같은 v2 파일을 이미 v3로 올라간 같은 데이터 기기에 복원하면 추가 0건 · 충돌 0건 (결정적 id)', async () => {
    const { db, v2File } = await migratedFixture();
    const before = await readAll(db);
    const plan = await previewRestore(createBackupStore(db), v2File);
    expect(plan.mode).toBe('merge');
    expect(plan.totals.add).toBe(0);
    expect(plan.totals.conflict).toBe(0);
    await applyRestore(createBackupStore(db), snaps(), v2File);
    const after = await readAll(db);
    for (const t of TABLE_NAMES) expect(sorted(t, after[t])).toEqual(sorted(t, before[t]));
  });

  it('조작된 v2 파일은 거부하고, 원본 파일 객체는 변환 뒤에도 바뀌지 않는다', async () => {
    const { v2File } = await migratedFixture();
    const snapshot = JSON.stringify(v2File);
    const forged = JSON.parse(snapshot) as BackupFile;
    (forged.tables.videos[0] as Record<string, unknown>).title = '조작';
    expect(validateBackup(forged, 3).ok).toBe(false);
    await previewRestore(createBackupStore(await freshV3()), v2File);
    expect(JSON.stringify(v2File)).toBe(snapshot);
  });

  it('v2 파일에 v3 새 테이블이 섞여 있으면 거부 (버전과 테이블 목록이 맞아야 함)', async () => {
    const { v2File } = await migratedFixture();
    const tables = { ...v2File.tables, learningItems: [] } as BackupTables;
    const f = { ...v2File, tables, counts: { ...v2File.counts, learningItems: 0 }, checksum: { algorithm: 'SHA-256' as const, value: computeChecksum(2, tables) } };
    expect(validateBackup(f, 3).ok).toBe(false);
  });
});

describe('백업 v3 — 새 테이블 연결 검사와 중복 검사 (데이터가 있는 기기에 병합)', () => {
  it('연결 대상이 없는 새 테이블 레코드는 보류하고 연쇄 보류, 같은 영상의 다른 Day 기록은 중복으로 충돌', async () => {
    const { db } = await migratedFixture();
    const file = await createBackup(createBackupStore(db));
    const t = file.tables;
    const now = '2026-11-15T00:00:00.000Z';
    const extra: Partial<Record<TableName, Record<string, unknown>[]>> = {
      learningItems: [{ id: 'li-orphan', expressionId: 'ex-nowhere', videoId: 'v-001', sourceType: 'other', dayNumber: null, kind: 'key', dialogueId: null, sourceText: null, timestampSec: null, onScreen: false, origin: 'user', status: 'confirmed', extractionDraftId: null, legacyKeySentenceId: null, createdAt: now, updatedAt: now }],
      extractionJobs: [{ id: 'job-orphan', videoId: 'v-nowhere', status: 'queued', attempts: 0, attemptAfter: null, lastError: null, currentRequestId: null, segments: [], leaseOwner: null, leaseUntil: null, model: null, apiStyle: 'interactions', promptVersion: null, videoDurationSec: null, draftId: null, createdAt: now, updatedAt: now }],
      extractionDrafts: [{ id: 'draft-chained', videoId: 'v-001', jobId: 'job-orphan', requestId: 'r1', status: 'pending_review', result: {}, edited: null, validation: [], approvedRefs: [], createdAt: now, updatedAt: now }],
      aiRequests: [{ id: 'req-chained', jobId: 'job-orphan', videoId: 'v-001', status: 'succeeded', bodyHash: null, interactionId: null, estVideoSec: 1, estTokens: 1, inputTokens: 1, sentAt: now, finishedAt: now, pacificDate: '2026-11-14', httpStatus: 200, errorCode: null, responseHash: null, createdAt: now, updatedAt: now }],
      dayAssignments: [{ id: 'day-other-id', videoId: 'v-001', dayNumber: 1, status: 'confirmed', source: 'user', createdAt: now, updatedAt: now }],
    };
    const tables = Object.fromEntries(TABLE_NAMES.map((k) => [k, [...t[k], ...(extra[k] ?? [])]])) as BackupTables;
    const plan = await previewRestore(createBackupStore(db), { ...file, tables });
    const byId = new Map(plan.conflicts.map((c) => [c.id, c]));
    expect(byId.get('li-orphan')?.kind).toBe('missing_link');
    expect(byId.get('job-orphan')?.kind).toBe('missing_link');
    expect(byId.get('draft-chained')?.kind).toBe('missing_link'); // 보류된 작업을 가리켜 연쇄 보류
    expect(byId.get('req-chained')?.kind).toBe('missing_link');
    expect(byId.get('day-other-id')?.kind).toBe('duplicate_target');
    expect(plan.totals.add).toBe(0);
  });

  it('인증처럼 보이는 앱 설정은 v3 백업에서도 제외된다', async () => {
    const { db } = await migratedFixture();
    await db.appMeta.put({ key: 'accessCode', value: 'should-not-export' });
    const file = await createBackup(createBackupStore(db));
    expect(JSON.stringify(file)).not.toContain('should-not-export');
    for (const t of V3_NEW_TABLE_NAMES) expect(Array.isArray(file.tables[t])).toBe(true);
  });
});
