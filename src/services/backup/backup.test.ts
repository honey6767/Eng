import { describe, expect, it } from 'vitest';
import { TABLE_NAMES, type StudyDatabase } from '@/db/database';
import { CURRENT_SCHEMA_VERSION } from '@/db/migrations';
import { createBackupStore, createSnapshotStore } from '@/repositories/backupStore';
import { seedSampleData } from '@/services/seedService';
import { createTestRepos } from '@/test/helpers';
import type { BackupTables } from './backupFormat';
import { computeChecksum, validateBackup } from './backupFormat';
import {
  applyRestore,
  createBackup,
  createSnapshot,
  parseBackupText,
  previewRestore,
  serializeBackup,
  snapshotToBackupFile,
} from './backupService';
import { canonicalJson, sha256Hex } from './sha256';

let snapCounter = 0;
const newSnapshots = () => createSnapshotStore(`test-snapshots-${Date.now()}-${snapCounter++}`);

/** 샘플 + 사용자 학습 흔적(즐겨찾기·복습 상태·학습 기록·진행)이 있는 DB */
async function seededDb() {
  const { db, repos } = createTestRepos();
  await seedSampleData(repos, new Date('2026-11-01T09:00:00Z'));
  // 샘플이 이미 만든 복습 상태·진행이 없는 표현·대화문을 골라 사용자 학습 흔적을 더한다
  const reviewed = new Set((await db.reviewStates.toArray()).map((r) => r.id));
  const progressed = new Set((await db.dialogueProgress.toArray()).map((p) => p.dialogueId));
  const expr = (await db.expressions.toArray()).find((e) => !reviewed.has(`expression:${e.id}`))!;
  const dialogue = (await db.dialogues.toArray()).find((d) => !progressed.has(d.id))!;
  await db.expressions.update(expr.id, { isFavorite: true, isMarkedDifficult: true });
  await db.dialogues.update(dialogue.id, { isFavorite: true });
  await db.reviewStates.add({
    id: `expression:${expr.id}`, itemType: 'expression', itemId: expr.id, correctCount: 2, wrongCount: 1,
    lastResult: 'hard', lastStudiedAt: '2026-11-14T10:00:00Z', nextReviewAt: '2026-11-17T10:00:00Z', weakness: 55,
    streak: 0, intervalIndex: 1, reviewCount: 3, lastQuizzedAt: null,
  });
  await db.studyLogs.add({
    id: 'log-1', timestamp: '2026-11-14T10:00:00Z', date: '2026-11-14', activity: 'dialogue_step',
    itemType: 'dialogue', itemId: dialogue.id, step: 5, rating: 'easy', accuracy: 1, isReview: false,
  });
  await db.dialogueProgress.add({
    id: dialogue.id, dialogueId: dialogue.id, currentStep: 3, highestCompletedStep: 2, stepResults: [],
    memorized: false, memorizedAt: null, blankMastery: { 'l1:0': 0.5 }, updatedAt: '2026-11-14T10:00:00Z',
  });
  await db.appMeta.put({ key: 'studyQueue', value: { cycle: 1, order: ['a', 'b'] } });
  await db.appMeta.put({ key: 'initializedAt', value: '2026-11-01T09:00:00Z' });
  await db.appMeta.put({ key: 'schemaVersion', value: CURRENT_SCHEMA_VERSION });
  return { db, repos, expr, dialogue };
}

const sortRows = (t: string, rows: Record<string, unknown>[]) =>
  [...rows].sort((a, b) => String(t === 'appMeta' ? a.key : a.id).localeCompare(String(t === 'appMeta' ? b.key : b.id)));

async function dump(db: StudyDatabase): Promise<BackupTables> {
  const store = createBackupStore(db);
  const all = await store.readAll();
  return Object.fromEntries(TABLE_NAMES.map((t) => [t, sortRows(t, all[t])])) as BackupTables;
}

/** 새 기기처럼: 앱 초기화 메타만 있는 빈 DB */
async function emptyDeviceDb() {
  const { db } = createTestRepos();
  await db.appMeta.put({ key: 'initializedAt', value: '2026-11-15T00:00:00Z' });
  await db.appMeta.put({ key: 'schemaVersion', value: CURRENT_SCHEMA_VERSION });
  return db;
}

describe('SHA-256 / 정렬 JSON', () => {
  it('표준 값과 같다 (빈 문자열, abc, 한글·긴 문자열)', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // 기준값: Node.js crypto.createHash('sha256')로 계산 (블록 경계 55/64바이트·멀티블록·한글·이모지)
    const vectors: [string, string][] = [
      ['안녕하세요 That makes two of us', '6f4d27d50eed73c78576c7d5ece7f863f31c981688b264923b1613a3752c94a3'],
      ['x'.repeat(55), 'd5e285683cd4efc02d021a5c62014694958901005d6f71e89e0989fac77e4072'],
      ['y'.repeat(64), 'ffbf30ab94107b2c14d75cfb455ec94f200400ddc5ce304e0c21894090db055f'],
      ['z'.repeat(1000), '950f88b09cf1d5e2cdbc5660c77dce3962265c548797950095629a0ea2daea46'],
      ['😀'.repeat(77), 'e4dbbc1b769c9b56941d4d0e382ed3e9b60fc9dd30534c9a08ca3790f699e5db'],
    ];
    for (const [s, hex] of vectors) expect(sha256Hex(s)).toBe(hex);
  });
  it('키 순서가 달라도 같은 문자열', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }], u: undefined })).toBe(canonicalJson({ a: [{ c: null, d: 2 }], b: 1 }));
  });
});

describe('내보내기', () => {
  it('모든 테이블·개수·검증값을 담고, 기존 DB를 바꾸지 않는다', async () => {
    const { db } = await seededDb();
    const before = await dump(db);
    const file = await createBackup(createBackupStore(db), new Date('2026-11-15T05:00:00Z'));
    expect(await dump(db)).toEqual(before);
    expect(Object.keys(file.tables).sort()).toEqual([...TABLE_NAMES].sort());
    for (const t of TABLE_NAMES) expect(file.counts[t]).toBe(before[t].length);
    expect(file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(file.checksum.value).toBe(computeChecksum(file.schemaVersion, file.tables));
    expect(validateBackup(JSON.parse(serializeBackup(file)), CURRENT_SCHEMA_VERSION).ok).toBe(true);
  });
});

describe('빈 기기 전체 복원', () => {
  it('내보낸 파일을 빈 DB에 복원하면 모든 테이블이 완전히 같다 (즐겨찾기·복습·기록·진행 포함)', async () => {
    const { db, expr, dialogue } = await seededDb();
    const original = await dump(db);
    const text = serializeBackup(await createBackup(createBackupStore(db)));

    const target = await emptyDeviceDb();
    const parsed = parseBackupText(text, CURRENT_SCHEMA_VERSION);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const store = createBackupStore(target);
    const preview = await previewRestore(store, parsed.backup);
    expect(preview.mode).toBe('empty');
    expect(preview.conflicts).toEqual([]);

    const { plan } = await applyRestore(store, newSnapshots(), parsed.backup);
    const restored = await dump(target);
    for (const t of TABLE_NAMES) {
      if (t === 'appMeta') continue;
      expect(restored[t], t).toEqual(original[t]);
    }
    // 기기별 설정(initializedAt·schemaVersion)은 새 기기 값 유지, 나머지 설정(studyQueue)은 복원
    expect(restored.appMeta.find((m) => m.key === 'studyQueue')).toEqual({ key: 'studyQueue', value: { cycle: 1, order: ['a', 'b'] } });
    expect(restored.appMeta.find((m) => m.key === 'initializedAt')?.value).toBe('2026-11-15T00:00:00Z');
    expect(plan.tables.find((x) => x.table === 'appMeta')?.skipped).toBe(2);
    // 즐겨찾기·어려워요 표시 그대로
    expect((await target.expressions.get(expr.id))?.isFavorite).toBe(true);
    expect((await target.expressions.get(expr.id))?.isMarkedDifficult).toBe(true);
    expect((await target.dialogues.get(dialogue.id))?.isFavorite).toBe(true);
  });

  it('원본에서 이미 끊겨 있던 연결은 고치지 않고 그대로 옮기며 목록으로 알려 준다', async () => {
    const { db } = await seededDb();
    await db.studyLogs.add({ id: 'orphan-log', timestamp: '2026-11-10T00:00:00Z', date: '2026-11-10', activity: 'expression_review', itemType: 'expression', itemId: 'deleted-expression', isReview: true });
    const file = await createBackup(createBackupStore(db));
    expect(file.integrity.brokenLinks).toBe(1);
    const target = await emptyDeviceDb();
    const { plan } = await applyRestore(createBackupStore(target), newSnapshots(), file);
    expect(plan.preexistingBrokenLinks).toEqual([{ table: 'studyLogs', id: 'orphan-log', missing: [{ field: 'itemId', table: 'expressions', id: 'deleted-expression' }] }]);
    expect(await target.studyLogs.get('orphan-log')).toMatchObject({ itemId: 'deleted-expression' });
  });
});

describe('병합 복원 — 덮어쓰지 않음 · 연결 관계 검사', () => {
  it('같은 데이터를 다시 복원하면 모두 "이미 있음"이고 아무것도 바뀌지 않는다', async () => {
    const { db } = await seededDb();
    const file = await createBackup(createBackupStore(db));
    const before = await dump(db);
    const { plan } = await applyRestore(createBackupStore(db), newSnapshots(), file);
    expect(plan.mode).toBe('merge');
    expect(plan.totals.add).toBe(0);
    expect(plan.totals.conflict).toBe(0);
    expect(await dump(db)).toEqual(before);
  });

  it('같은 id·다른 내용은 충돌로 표시하고 기존 내용을 덮어쓰지 않는다', async () => {
    const { db, expr } = await seededDb();
    const file = await createBackup(createBackupStore(db));
    await db.expressions.update(expr.id, { meaningKo: '기기에서 고친 뜻' });
    await db.reviewStates.update(`expression:${expr.id}`, { weakness: 10 });
    const { plan } = await applyRestore(createBackupStore(db), newSnapshots(), file);
    expect(plan.conflicts.map((c) => `${c.table}:${c.kind}`).sort()).toEqual(['expressions:same_id_different', 'reviewStates:same_id_different']);
    expect((await db.expressions.get(expr.id))?.meaningKo).toBe('기기에서 고친 뜻');
    expect((await db.reviewStates.get(`expression:${expr.id}`))?.weakness).toBe(10);
  });

  it('연결 대상이 없는 레코드는 가져오지 않고, 그 레코드에 연결된 것도 연쇄로 보류한다', async () => {
    const { db: source } = await seededDb();
    const file = await createBackup(createBackupStore(source));
    // 기기 B: 다른 사용자 데이터가 있는 DB (같은 샘플 아님)
    const { db: target } = createTestRepos();
    await target.expressions.add({ id: 'local-expr', createdAt: 'x', updatedAt: 'x', normalizedKey: 'local only', text: 'local only', meaningKo: '', sourceRefs: [], isFavorite: true, isMarkedDifficult: false });
    // 백업에서 영상 하나를 빼고 검사 (그 영상을 가리키는 자막·노트·핵심 문장·대화문 등이 연쇄 보류되어야 함)
    const removedVideo = file.tables.videos.find((v) => file.tables.dialogues.some((d) => d.videoId === v.id))!;
    expect(removedVideo).toBeTruthy();
    const tables = { ...file.tables, videos: file.tables.videos.filter((v) => v.id !== removedVideo.id) };
    const before = await dump(target);
    const plan = (await import('./restorePlan')).planRestore(tables, before);
    const held = plan.conflicts.filter((c) => c.kind === 'missing_link');
    expect(held.length).toBeGreaterThan(0);
    // 직접 연결: 그 영상의 자막
    const dialogue = file.tables.dialogues.find((d) => d.videoId === removedVideo.id)!;
    expect(held.some((c) => c.table === 'dialogues' && c.id === dialogue.id)).toBe(true);
    // 연쇄: 보류된 대화문의 진행·학습 기록도 보류 (기기에 그 대화문이 없으므로)
    for (const p of file.tables.dialogueProgress.filter((p) => p.dialogueId === dialogue.id))
      expect(held.some((c) => c.table === 'dialogueProgress' && c.id === p.id)).toBe(true);
    // 추가 대상에는 끊긴 연결이 하나도 없다 (기기 + 추가 대상 안에서 모든 연결이 닫혀 있음)
    const merged = Object.fromEntries(TABLE_NAMES.map((t) => [t, [...before[t], ...plan.toAdd[t]]])) as BackupTables;
    const { findBrokenLinks } = await import('./restorePlan');
    expect(findBrokenLinks(merged)).toEqual([]);
    // 실제 적용 후에도 기기 데이터는 그대로 있고 끊긴 연결이 없다
    await createBackupStore(target).addRows(plan.toAdd);
    expect(await target.expressions.get('local-expr')).toMatchObject({ isFavorite: true });
    expect(findBrokenLinks(await dump(target))).toEqual([]);
  });

  it('id는 다르지만 같은 대상(같은 표현 문구)이 이미 있으면 중복을 만들지 않고 충돌로 표시한다', async () => {
    const { db: source } = await seededDb();
    const file = await createBackup(createBackupStore(source));
    const { db: target } = createTestRepos();
    const e = file.tables.expressions[0];
    await target.expressions.add({ ...(e as object), id: 'other-id', meaningKo: '기기의 뜻' } as never);
    const plan = await previewRestore(createBackupStore(target), file);
    expect(plan.conflicts.some((c) => c.table === 'expressions' && c.id === e.id && c.kind === 'duplicate_target')).toBe(true);
    // 그 표현을 가리키던 백업 레코드는 '기기의 다른 id 표현'에 임의로 연결되지 않고 보류된다
    const linked = plan.conflicts.filter((c) => c.kind === 'missing_link' && c.missing?.some((m) => m.table === 'expressions' && m.id === e.id));
    expect(linked.length).toBeGreaterThan(0);
    await createBackupStore(target).addRows(plan.toAdd);
    expect(await target.expressions.where('normalizedKey').equals(String(e.normalizedKey)).count()).toBe(1);
    expect((await target.expressions.get('other-id'))?.meaningKo).toBe('기기의 뜻');
  });

  it('쓰는 도중 이미 있는 id를 만나면 전체가 취소되어 일부만 들어가지 않는다', async () => {
    const { db } = await seededDb();
    const store = createBackupStore(db);
    const before = await dump(db);
    const existing = before.expressions[0];
    const rows = Object.fromEntries(TABLE_NAMES.map((t) => [t, []])) as unknown as BackupTables;
    rows.studyLogs = [{ id: 'new-log', timestamp: 't', date: '2026-11-15', activity: 'preview', itemType: 'expression', itemId: String(existing.id), isReview: false }];
    rows.expressions = [existing];
    await expect(store.addRows(rows)).rejects.toThrow();
    expect(await dump(db)).toEqual(before);
  });
});

describe('파일 검사 — 문제 있으면 복원 거부', () => {
  it('내용이 수정되면 검증값 불일치로 거부', async () => {
    const { db } = await seededDb();
    const file = JSON.parse(serializeBackup(await createBackup(createBackupStore(db))));
    file.tables.expressions[0].meaningKo = '몰래 바꿈';
    const r = validateBackup(file, CURRENT_SCHEMA_VERSION);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('검증값');
  });
  it('개수 불일치·같은 id 두 번·테이블 누락·알 수 없는 테이블·형식 오류', async () => {
    const { db } = await seededDb();
    const good = JSON.parse(serializeBackup(await createBackup(createBackupStore(db))));
    const clone = () => JSON.parse(JSON.stringify(good));
    const a = clone(); a.counts.videos += 1;
    const b = clone(); b.tables.videos.push(b.tables.videos[0]); b.counts.videos += 1;
    const c = clone(); delete c.tables.studyLogs;
    const d = clone(); d.tables.hacked = [];
    for (const f of [a, b, c, d]) expect(validateBackup(f, CURRENT_SCHEMA_VERSION).ok).toBe(false);
    expect(parseBackupText('{not json', CURRENT_SCHEMA_VERSION).ok).toBe(false);
    expect(validateBackup({ format: 'other' }, CURRENT_SCHEMA_VERSION).ok).toBe(false);
    expect(validateBackup([], CURRENT_SCHEMA_VERSION).ok).toBe(false);
  });
  it('더 새로운/이전 DB 버전 파일은 거부', async () => {
    const { db } = await seededDb();
    const file = await createBackup(createBackupStore(db));
    for (const v of [CURRENT_SCHEMA_VERSION + 1, CURRENT_SCHEMA_VERSION - 1]) {
      const f = { ...file, schemaVersion: v, checksum: { algorithm: 'SHA-256' as const, value: computeChecksum(v, file.tables) } };
      expect(validateBackup(f, CURRENT_SCHEMA_VERSION).ok).toBe(false);
    }
  });
});

describe('임시 안전 복사본 (같은 기기 브라우저 안)', () => {
  it('복원 직전에 자동으로 만들어지고, 파일로 내보내면 그 시점 DB와 같다', async () => {
    const { db } = await seededDb();
    const before = await dump(db);
    const snaps = newSnapshots();
    const file = await createBackup(createBackupStore(db));
    const { snapshotId } = await applyRestore(createBackupStore(db), snaps, file);
    const list = await snaps.list();
    expect(list.map((s) => s.id)).toContain(snapshotId);
    expect(list[0].reason).toBe('before_restore');
    const asFile = await snapshotToBackupFile(snaps, snapshotId);
    expect(asFile && validateBackup(JSON.parse(serializeBackup(asFile)), CURRENT_SCHEMA_VERSION).ok).toBe(true);
    for (const t of TABLE_NAMES) expect(sortRows(t, asFile!.tables[t])).toEqual(before[t]);
  });
  it('직접 만들기 — 기존 학습 DB는 바뀌지 않는다', async () => {
    const { db } = await seededDb();
    const before = await dump(db);
    const snaps = newSnapshots();
    await createSnapshot(createBackupStore(db), snaps, 'manual');
    expect(await dump(db)).toEqual(before);
    expect((await snaps.list()).length).toBe(1);
  });
});

describe('많은 데이터', () => {
  it('학습 기록 1만 건도 내보내기·복원 후 같다', async () => {
    const { db } = await seededDb();
    const expr = (await db.expressions.toArray())[0];
    await db.studyLogs.bulkAdd(
      Array.from({ length: 10000 }, (_, i) => ({
        id: `bulk-${i}`, timestamp: '2026-11-14T10:00:00Z', date: '2026-11-14', activity: 'expression_review' as const,
        itemType: 'expression' as const, itemId: expr.id, rating: 'easy' as const, isReview: true,
      })),
    );
    const original = await dump(db);
    const text = serializeBackup(await createBackup(createBackupStore(db)));
    const parsed = parseBackupText(text, CURRENT_SCHEMA_VERSION);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const target = await emptyDeviceDb();
    await applyRestore(createBackupStore(target), newSnapshots(), parsed.backup);
    expect((await dump(target)).studyLogs).toEqual(original.studyLogs);
  }, 60000);
});

describe('학습 순서 — 새 기기의 빈 기본값만, 확인했을 때만 백업 값으로', () => {
  const defaultQueue = { version: 1, cycle: 1, order: [], visited: [], includeCompleted: false, shuffledAt: '2026-11-15T00:00:00Z' };
  const backupQueue = (videoIds: string[]) => ({ version: 1, cycle: 3, order: videoIds, visited: videoIds.slice(0, 1), includeCompleted: false, shuffledAt: '2026-11-10T00:00:00Z' });

  async function sourceFile() {
    const { db } = await seededDb();
    const ids = (await db.videos.toArray()).map((v) => v.id);
    await db.appMeta.put({ key: 'studyQueue', value: backupQueue(ids) });
    return { file: await createBackup(createBackupStore(db)), queue: backupQueue(ids) };
  }
  async function newDevice(queue: unknown) {
    const target = await emptyDeviceDb();
    await target.appMeta.put({ key: 'studyQueue', value: queue });
    return target;
  }

  it('빈 기본값이면 충돌이 아니라 "바꿀 수 있음"으로 보여 주고, 확인하지 않으면 바꾸지 않는다', async () => {
    const { file } = await sourceFile();
    const target = await newDevice(defaultQueue);
    const plan = await previewRestore(createBackupStore(target), file);
    expect(plan.conflicts).toEqual([]);
    expect(plan.replaceableMeta.map((m) => m.key)).toEqual(['studyQueue']);
    expect(plan.replaceableMeta[0].summary).toContain('빈 기본값');
    expect(plan.tables.find((t) => t.table === 'appMeta')?.replaceable).toBe(1);
    const res = await applyRestore(createBackupStore(target), newSnapshots(), file);
    expect(res.replacedMeta).toEqual([]);
    expect((await target.appMeta.get('studyQueue'))?.value).toEqual(defaultQueue);
  });

  it('확인하면 백업의 학습 순서로 바꾼다', async () => {
    const { file, queue } = await sourceFile();
    const target = await newDevice(defaultQueue);
    const res = await applyRestore(createBackupStore(target), newSnapshots(), file, { replaceMeta: [{ key: 'studyQueue', expectedDeviceValue: defaultQueue }] });
    expect(res.replacedMeta).toEqual(['studyQueue']);
    expect((await target.appMeta.get('studyQueue'))?.value).toEqual(queue);
  });

  it('사용자가 정한 값(다시 섞음·옵션 변경·영상 있음)은 바꿀 수 있음으로 보지 않고, 요청해도 덮어쓰지 않는다', async () => {
    const { file } = await sourceFile();
    for (const userValue of [
      { ...defaultQueue, cycle: 2 },
      { ...defaultQueue, includeCompleted: true },
      { ...defaultQueue, order: ['some-video'] },
      { ...defaultQueue, visited: ['some-video'] },
      'not-an-object',
    ]) {
      const target = await newDevice(userValue);
      const plan = await previewRestore(createBackupStore(target), file);
      expect(plan.replaceableMeta).toEqual([]);
      expect(plan.conflicts.some((c) => c.table === 'appMeta' && c.id === 'studyQueue')).toBe(true);
      await expect(
        applyRestore(createBackupStore(target), newSnapshots(), file, { replaceMeta: [{ key: 'studyQueue', expectedDeviceValue: userValue }] }),
      ).rejects.toThrow();
      expect((await target.appMeta.get('studyQueue'))?.value).toEqual(userValue);
    }
  });

  it('데이터가 있는 기기(병합)에서는 빈 기본값처럼 보여도 바꾸지 않는다', async () => {
    const { file } = await sourceFile();
    const { db: target } = createTestRepos();
    await target.expressions.add({ id: 'local-expr', createdAt: 'x', updatedAt: 'x', normalizedKey: 'local only', text: 'local only', meaningKo: '', sourceRefs: [], isFavorite: false, isMarkedDifficult: false });
    await target.appMeta.put({ key: 'studyQueue', value: defaultQueue });
    const plan = await previewRestore(createBackupStore(target), file);
    expect(plan.mode).toBe('merge');
    expect(plan.replaceableMeta).toEqual([]);
    expect((await target.appMeta.get('studyQueue'))?.value).toEqual(defaultQueue);
  });

  it('미리보기 이후 이 기기 값이 바뀌었으면 전체를 취소하고 아무것도 쓰지 않는다', async () => {
    const { file } = await sourceFile();
    const target = await newDevice(defaultQueue);
    const store = createBackupStore(target);
    await previewRestore(store, file);
    const changed = { ...defaultQueue, cycle: 2 };
    await target.appMeta.put({ key: 'studyQueue', value: changed });
    const before = await dump(target);
    await expect(applyRestore(store, newSnapshots(), file, { replaceMeta: [{ key: 'studyQueue', expectedDeviceValue: defaultQueue }] })).rejects.toThrow();
    expect(await dump(target)).toEqual(before);
  });

  it('저장소 수준 안전장치: 현재 값이 예상과 다르면 추가 레코드까지 모두 취소', async () => {
    const target = await newDevice({ ...defaultQueue, cycle: 5 });
    const store = createBackupStore(target);
    const rows = Object.fromEntries(TABLE_NAMES.map((t) => [t, []])) as unknown as BackupTables;
    rows.playlists = [{ id: 'p-new', createdAt: 'x', updatedAt: 'x', url: '', youtubePlaylistId: null, title: 't', lastSyncedAt: null, syncStatus: 'never' }];
    const before = await dump(target);
    await expect(store.addRows(rows, [{ key: 'studyQueue', expected: defaultQueue, value: { x: 1 } }])).rejects.toThrow();
    expect(await dump(target)).toEqual(before);
  });
});

describe('인증 정보는 백업·복원 대상이 아님', () => {
  it('앱 설정에 인증처럼 보이는 키가 있어도 백업 파일·임시 복사본에 넣지 않는다', async () => {
    const { db } = await seededDb();
    await db.appMeta.put({ key: 'mes:accessCode', value: 'should-never-be-exported' });
    await db.appMeta.put({ key: 'authToken', value: 'token-value-xyz' });
    const file = await createBackup(createBackupStore(db));
    const text = serializeBackup(file);
    expect(text).not.toContain('should-never-be-exported');
    expect(text).not.toContain('token-value-xyz');
    expect(file.tables.appMeta.map((m) => m.key)).not.toContain('mes:accessCode');
    expect(validateBackup(JSON.parse(text), CURRENT_SCHEMA_VERSION).ok).toBe(true);
    // 기기 DB는 그대로 (지우지 않음)
    expect(await db.appMeta.get('mes:accessCode')).toBeTruthy();
    const snaps = newSnapshots();
    const id = await createSnapshot(createBackupStore(db), snaps, 'manual');
    expect(JSON.stringify(await snaps.get(id))).not.toContain('should-never-be-exported');
  });
  it('조작된 백업 파일에 인증 키가 있어도 복원하지 않는다', async () => {
    const { db } = await seededDb();
    const file = await createBackup(createBackupStore(db));
    const tables = { ...file.tables, appMeta: [...file.tables.appMeta, { key: 'accessCode', value: 'injected-code' }] };
    const forged = { ...file, tables, counts: { ...file.counts, appMeta: tables.appMeta.length }, checksum: { algorithm: 'SHA-256' as const, value: computeChecksum(file.schemaVersion, tables) } };
    const target = await emptyDeviceDb();
    const { plan } = await applyRestore(createBackupStore(target), newSnapshots(), forged);
    expect(await target.appMeta.get('accessCode')).toBeUndefined();
    expect(plan.tables.find((t) => t.table === 'appMeta')?.skipped).toBe(3);
  });
  it('기존 앱 설정 키(학습 순서 등)는 걸러지지 않는다 — 기존 백업과 호환', async () => {
    const { isAuthLikeMetaKey } = await import('./backupFormat');
    for (const k of ['initializedAt', 'schemaVersion', 'sampleSeededAt', 'studyQueue']) expect(isAuthLikeMetaKey(k)).toBe(false);
  });
});
