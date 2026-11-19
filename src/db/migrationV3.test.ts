import { describe, expect, it } from 'vitest';
import { StudyDatabase } from './database';
import { CURRENT_SCHEMA_VERSION, META_MIGRATION_LOG } from './migrations';
import { V2_TABLE_NAMES, V3_NEW_TABLE_NAMES, type TableName } from './tables';
import {
  checkStorage,
  compareTables,
  getNativeDbVersion,
  getUpgradeStatus,
  openAndVerify,
  readRawTables,
  snapshotBeforeUpgrade,
  UpgradeError,
} from './upgradeGuard';
import { upgradeV2toV3, type MigrationLog, type V2Tables } from './upgradeV2toV3';
import { createSnapshotStore } from '@/repositories/backupStore';
import { buildBackupFile } from '@/services/backup/backupService';
import { toCurrentTables, type BackupTables } from '@/services/backup/backupFormat';
import { createV2Fixture } from '@/test/v2Fixture';

let n = 0;
const snaps = () => createSnapshotStore(`test-snap-v3-${Date.now()}-${n++}`);
const pk = (t: TableName, r: Record<string, unknown>) => String(t === 'appMeta' ? r.key : r.id);
const sorted = (t: TableName, rows: Record<string, unknown>[]) => [...rows].sort((a, b) => pk(t, a).localeCompare(pk(t, b)));

async function readAll(db: StudyDatabase, names: readonly TableName[]): Promise<BackupTables> {
  const out = {} as BackupTables;
  for (const t of names) out[t] = (await db.table(t).toArray()) as Record<string, unknown>[];
  return out;
}

describe('DB v2 → v3 업그레이드 (운영 규모 테스트 데이터, 격리된 메모리 DB)', () => {
  it('기존 12개 테이블의 모든 레코드가 업그레이드 전과 완전히 같고, 새 테이블만 생긴다', async () => {
    const { name, db: v2 } = await createV2Fixture();
    v2.close();
    expect(await getNativeDbVersion(name)).toBe(20);
    expect(await getUpgradeStatus(name)).toEqual({ kind: 'needs_upgrade', fromVersion: 2 });

    // 업그레이드 전 상태를 안전장치와 별개로 직접 읽어 둔다 (비교 기준)
    const independentBefore = await readRawTables(name, V2_TABLE_NAMES);

    const snapStore = snaps();
    const snap = await snapshotBeforeUpgrade(snapStore, name, new Date('2026-11-15T00:00:00Z'));
    const v3 = new StudyDatabase(name);
    const verification = await openAndVerify(v3, snap.before);

    expect(verification.ok).toBe(true);
    expect(v3.verno).toBe(CURRENT_SCHEMA_VERSION);
    v3.close();
    expect(await getNativeDbVersion(name)).toBe(30);
    expect(await getUpgradeStatus(name)).toEqual({ kind: 'current' });

    // 독립 비교: 기존 12개 테이블을 id 순서로 정렬해 레코드 전체를 깊은 비교
    const v3b = new StudyDatabase(name);
    await v3b.open();
    const after = await readAll(v3b, [...V2_TABLE_NAMES, ...V3_NEW_TABLE_NAMES]);
    for (const t of V2_TABLE_NAMES) {
      const a = t === 'appMeta' ? after[t].filter((r) => r.key !== META_MIGRATION_LOG) : after[t];
      expect(sorted(t, a), `${t} 레코드가 달라졌어요`).toEqual(sorted(t, independentBefore[t]));
    }
    // appMeta에 더해진 것은 migrationLog 하나뿐
    expect(after.appMeta.length).toBe(independentBefore.appMeta.length + 1);

    // 새 테이블 개수 = migrationLog 기록 = 순수 함수 결과
    const log = after.appMeta.find((r) => r.key === META_MIGRATION_LOG)!.value as MigrationLog;
    const expected = upgradeV2toV3(independentBefore as unknown as V2Tables, log.migratedAt).newTables;
    for (const t of V3_NEW_TABLE_NAMES) {
      expect(after[t].length).toBe(log.created[t]);
      expect(sorted(t, after[t])).toEqual(sorted(t, expected[t]));
    }
    for (const t of V2_TABLE_NAMES) expect(log.countsBefore[t]).toBe(independentBefore[t].length);

    // 사용자 데이터 기준 기대값
    const day = new Map(after.dayAssignments.map((d) => [d.videoId, d]));
    expect(day.get('v-007')).toMatchObject({ dayNumber: 7, status: 'suggested', source: 'title' });
    expect(day.get('v-101')).toMatchObject({ dayNumber: 7, status: 'suggested' });
    expect(day.get('v-100')).toMatchObject({ dayNumber: 100 });
    expect(day.has('v-102')).toBe(false);
    expect(day.has('v-103')).toBe(false);
    expect(log.warnings.some((w) => w.code === 'duplicate_day_number' && w.ids.includes('v-007') && w.ids.includes('v-101'))).toBe(true);
    const items = after.learningItems.filter((r) => String(r.legacyKeySentenceId).startsWith('ks-'));
    expect(items.filter((r) => r.legacyKeySentenceId === 'ks-1').map((r) => r.expressionId).sort()).toEqual(['ex-1', 'ex-2']);
    expect(items.some((r) => r.legacyKeySentenceId === 'ks-4')).toBe(false); // 표현 없는 문장
    expect(items.some((r) => r.legacyKeySentenceId === 'ks-8')).toBe(false); // 없는 표현을 가리킨 문장
    expect(log.warnings.some((w) => w.code === 'key_sentence_without_expression' && w.ids[0] === 'ks-4')).toBe(true);
    expect(log.warnings.some((w) => w.code === 'missing_expression' && w.ids[0] === 'ks-8')).toBe(true);
    for (const r of items) expect(r).toMatchObject({ kind: 'key', origin: 'migrated', status: 'confirmed', sourceType: 'other', dayNumber: null });
    for (const t of ['studySessions', 'dialogueDrafts', 'extractionJobs', 'extractionDrafts', 'aiRequests'] as const) expect(after[t]).toEqual([]);

    // 비교 결과 보고서 (B1A_REPORT 경로가 있을 때만 파일로 남김)
    const reportPath = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.B1A_REPORT;
    if (reportPath) {
      const comparison = compareTables(independentBefore, after);
      const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as { writeFileSync: (p: string, d: string) => void };
      fs.writeFileSync(
        reportPath,
        JSON.stringify(
          {
            fixture: '테스트 전용 v2 DB (샘플 데이터 + 영상 103개 등, 개인 데이터 아님)',
            nativeVersion: { before: 20, after: 30 },
            existingTables: comparison.map(({ differingIds, ...c }) => ({ ...c, differingCount: differingIds.length })),
            appMetaAddedKeys: [META_MIGRATION_LOG],
            newTables: V3_NEW_TABLE_NAMES.map((t) => ({ table: t, count: after[t].length, loggedCount: log.created[t] })),
            warnings: log.warnings,
            snapshot: { id: snap.snapshotId, schemaVersion: snap.schemaVersion },
          },
          null,
          2,
        ),
      );
    }
    v3b.close();
  });

  it('임시 안전 복사본: 업그레이드 직전에 저장되고, 개수·검증값이 업그레이드 전 DB와 같다', async () => {
    const { name, db: v2 } = await createV2Fixture();
    const before = await readAll(v2, V2_TABLE_NAMES);
    v2.close();
    const store = snaps();
    const snap = await snapshotBeforeUpgrade(store, name);
    const saved = (await store.get(snap.snapshotId))!;
    expect(saved.reason).toBe('before_upgrade_v3');
    expect(saved.schemaVersion).toBe(2);
    expect(Object.keys(saved.tables).sort()).toEqual([...V2_TABLE_NAMES].sort());
    for (const t of V2_TABLE_NAMES) {
      expect(saved.counts[t]).toBe(before[t].length);
      expect(sorted(t, saved.tables[t])).toEqual(sorted(t, before[t]));
    }
    // 복사본을 만드는 것만으로는 DB 버전이 바뀌지 않는다
    expect(await getNativeDbVersion(name)).toBe(20);
  });

  it('업그레이드 중 오류가 나면 전체가 취소되어 DB는 v2(20)와 기존 데이터 그대로 남는다', async () => {
    const { name, db: v2 } = await createV2Fixture();
    // 업그레이드가 추가하려는 키를 미리 넣어 두면 add가 실패 → 업그레이드 트랜잭션 전체가 취소되어야 한다
    await v2.table('appMeta').add({ key: META_MIGRATION_LOG, value: 'pre-existing' });
    const before = await readAll(v2, V2_TABLE_NAMES);
    v2.close();
    const snap = await snapshotBeforeUpgrade(snaps(), name);
    const v3 = new StudyDatabase(name);
    await expect(openAndVerify(v3, snap.before)).rejects.toBeInstanceOf(UpgradeError);
    v3.close();
    expect(await getNativeDbVersion(name)).toBe(20);
    const raw = await readRawTables(name, [...V2_TABLE_NAMES, ...V3_NEW_TABLE_NAMES]);
    for (const t of V2_TABLE_NAMES) expect(sorted(t, raw[t])).toEqual(sorted(t, before[t]));
    for (const t of V3_NEW_TABLE_NAMES) expect(raw[t]).toEqual([]); // 새 테이블도 생기지 않음
  });

  it('DB 업그레이드 결과 = v2 백업 파일을 메모리에서 변환한 결과 (같은 함수, 결정적 id·시각)', async () => {
    const { name, db: v2 } = await createV2Fixture();
    const before = await readAll(v2, V2_TABLE_NAMES);
    v2.close();
    const file = buildBackupFile(before, 2, new Date('2026-11-15T00:00:00Z'));
    const converted = toCurrentTables(file);
    const snap = await snapshotBeforeUpgrade(snaps(), name);
    const v3 = new StudyDatabase(name);
    expect((await openAndVerify(v3, snap.before)).ok).toBe(true);
    const after = await readAll(v3, [...V2_TABLE_NAMES, ...V3_NEW_TABLE_NAMES]);
    for (const t of V3_NEW_TABLE_NAMES) expect(sorted(t, after[t])).toEqual(sorted(t, converted[t]));
    for (const t of V2_TABLE_NAMES.filter((x) => x !== 'appMeta')) expect(sorted(t, after[t])).toEqual(sorted(t, converted[t]));
    // 파일 변환은 기기별 기록(migrationLog)을 만들지 않는다
    expect(converted.appMeta.some((r) => r.key === META_MIGRATION_LOG)).toBe(false);
    v3.close();
  });

  it('v1 DB도 v2 → v3 순서로 올라간다 (v2 단계의 기존 동작 + v3 새 테이블)', async () => {
    const name = `v1-to-v3-${Date.now()}`;
    const v1 = new StudyDatabase(name, 1);
    await v1.open();
    const base = { createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
    await v1.table('videos').add({ id: 'v1', ...base, playlistId: null, youtubeVideoId: 'abcdefghijk', title: '[Day 3] 옛 영상', url: null, thumbnailUrl: null, durationSec: 200, orderIndex: 0, randomOrderKey: 0.3, status: 'new', completedAt: null });
    v1.close();
    expect(await getUpgradeStatus(name)).toEqual({ kind: 'needs_upgrade', fromVersion: 1 });
    const v3 = new StudyDatabase(name);
    await v3.open();
    expect((await v3.table('videos').get('v1'))!.sources).toEqual([{ kind: 'manual', addedAt: base.createdAt }]);
    expect(await v3.dayAssignments.get('day-v1')).toMatchObject({ videoId: 'v1', dayNumber: 3 });
    v3.close();
  });

  it('버전 확인은 DB가 없을 때 새로 만들지 않는다 (새 기기는 앱이 바로 v3로 만든다)', async () => {
    const name = `never-created-${Date.now()}`;
    expect(await getNativeDbVersion(name)).toBeNull();
    expect(await getNativeDbVersion(name)).toBeNull();
    expect(await getUpgradeStatus(name)).toEqual({ kind: 'fresh' });
    const fresh = new StudyDatabase(name);
    await fresh.open();
    expect(fresh.verno).toBe(3);
    expect(await fresh.table('appMeta').get(META_MIGRATION_LOG)).toBeUndefined(); // 새 기기에는 업그레이드 기록이 없다
    fresh.close();
    expect(await getUpgradeStatus(name)).toEqual({ kind: 'current' });
  });

  it('저장 공간 확인: 남은 공간이 사용량의 2배 미만이면 멈춘다, 값을 모르면 건너뛴다', async () => {
    await expect(checkStorage(async () => ({ usage: 100e6, quota: 250e6 }))).rejects.toMatchObject({ code: 'insufficient_storage' });
    await expect(checkStorage(async () => ({ usage: 100e6, quota: 400e6 }))).resolves.toMatchObject({ checked: true });
    await expect(checkStorage(async () => ({ usage: 1 }))).resolves.toEqual({ checked: false });
    await expect(checkStorage(undefined)).resolves.toEqual({ checked: false });
  });
});
