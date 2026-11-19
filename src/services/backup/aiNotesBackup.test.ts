import { describe, expect, it } from 'vitest';
import { QaDatabase } from '@/services/qa/qaDb';
import { exportAiNotes, planAiNotesRestore, restoreAiNotes, validateAiNotes } from './aiNotesBackup';
import { buildBackupFile } from './backupService';
import { validateBackup } from './backupFormat';

let seq = 0;
const T = '2026-11-18T12:00:00.000Z';

async function seeded() {
  const db = new QaDatabase(`notes-bk-${++seq}`);
  await db.sessions.add({ id: 's1', chunkKey: 'li-1', chunkLabel: 'look tired', role: 'extra', videoId: 'd11', videoTitle: 'Day 11', dayNumber: 11, context: { source: 'Day 11', dayNumber: 11, role: 'extra', base: 'look tired' }, createdAt: T, updatedAt: T, turnCount: 1 });
  await db.turns.add({ id: 't1', sessionId: 's1', turn: 1, parentTurnId: null, question: 'q', status: 'answered', answer: null, error: null, requestId: 'r', chunkKey: 'li-1', chunkLabel: 'look tired', videoId: 'd11', dayNumber: 11, history: [], createdAt: T, answeredAt: T });
  await db.phraseSets.add({ dialogueId: 'dlg-1', phrases: [], requestId: 'r2', promptVersion: 'ph1', createdAt: T });
  await db.phraseAttempts.add({ id: 'a1', dialogueId: 'dlg-1', status: 'failed', requestId: 'r1', at: T, error: { code: 'gemini_failed', message: 'x', httpStatus: 502 }, count: 0 });
  await db.tasks.put({ key: 'ask:t1', state: { requestId: 'r', body: {} as never, status: 'applied', startedAt: T, updatedAt: T, resultText: null, error: null } });
  return db;
}

describe('백업: AI 부가 기록 블록 (기존 백업 형식과 충돌 없음)', () => {
  it('내보내기: 질문·✨ 기록만 (기기별 진행 중 요청 상태는 빼고), 자기 검증값', async () => {
    const block = (await exportAiNotes(await seeded()))!;
    expect(block.counts).toEqual({ qaSessions: 1, qaTurns: 1, phraseSets: 1, phraseAttempts: 1 });
    expect(Object.keys(block.tables)).not.toContain('tasks');
    expect(validateAiNotes(block)).toMatchObject({ ok: true });
    expect(await exportAiNotes(new QaDatabase(`notes-empty-${++seq}`))).toBeNull(); // 기록이 없으면 블록을 넣지 않음
  });

  it('학습 데이터 백업의 검증·형식 버전은 그대로 — 블록이 붙어도 이전 앱의 검사를 통과하고, 블록이 없는 이전 파일도 그대로', async () => {
    const base = buildBackupFile({} as never, 3, new Date(T));
    const withNotes = { ...base, aiNotes: await exportAiNotes(await seeded()) };
    expect(withNotes.formatVersion).toBe(1);
    expect(validateBackup(JSON.parse(JSON.stringify(withNotes)), 3).ok).toBe(true);
    expect(validateBackup(JSON.parse(JSON.stringify(base)), 3).ok).toBe(true);
    expect(withNotes.checksum).toEqual(base.checksum);
    expect(validateAiNotes(undefined)).toEqual({ ok: true, block: null });
  });

  it('손상된 블록은 그 블록만 거부 (학습 데이터 복원과 별개)', async () => {
    const block = (await exportAiNotes(await seeded()))!;
    const tampered = JSON.parse(JSON.stringify(block));
    tampered.tables.qaTurns[0].question = '바뀐 질문';
    expect(validateAiNotes(tampered)).toMatchObject({ ok: false });
    expect(validateAiNotes({ ...block, counts: { ...block.counts, qaTurns: 9 } })).toMatchObject({ ok: false });
  });

  it('복원은 추가만 — 같은 id는 그대로 두고 없는 것만 추가', async () => {
    const block = (await exportAiNotes(await seeded()))!;
    const target = new QaDatabase(`notes-target-${++seq}`);
    await target.turns.add({ ...(block.tables.qaTurns[0] as Record<string, unknown>), question: '이 기기의 질문(그대로 둬야 함)' } as never);
    const plan = await planAiNotesRestore(target, block);
    expect([plan.add, plan.same]).toEqual([3, 1]);
    expect(await restoreAiNotes(target, block)).toBe(3);
    expect((await target.turns.get('t1'))?.question).toBe('이 기기의 질문(그대로 둬야 함)');
    expect(await target.phraseAttempts.count()).toBe(1);
    expect(await restoreAiNotes(target, block)).toBe(0); // 두 번 해도 중복 없음
  });
});
