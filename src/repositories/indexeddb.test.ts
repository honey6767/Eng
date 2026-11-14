import { describe, expect, it } from 'vitest';
import { createTestRepos } from '@/test/helpers';
import { initializeApp, seedSampleData } from '@/services/seedService';
import { loadDashboardStats } from '@/services/statsService';
import { CURRENT_SCHEMA_VERSION } from '@/db/migrations';
import { StudyDatabase } from '@/db/database';
import { createIndexedDbRepositories } from './indexeddb';

describe('IndexedDB 저장소', () => {
  it('최초 실행 시 샘플 데이터를 한 번만 저장한다', async () => {
    const { repos } = createTestRepos();
    await initializeApp(repos, CURRENT_SCHEMA_VERSION);
    await initializeApp(repos, CURRENT_SCHEMA_VERSION);
    const videos = await repos.videos.list();
    expect(videos).toHaveLength(3);
    expect(videos.every((v) => v.isSample)).toBe(true);
    expect(await repos.meta.get('schemaVersion')).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('샘플 데이터: 핵심 문장 5개가 대화문에 원문 그대로 연결된다', async () => {
    const { repos } = createTestRepos();
    await seedSampleData(repos);
    const [v1] = await repos.videos.list();
    const sentences = await repos.keySentences.listByVideo(v1.id);
    expect(sentences.map((s) => s.order)).toEqual([1, 2, 3, 4, 5]);
    const dialogues = await repos.dialogues.listByVideo(v1.id);
    expect(dialogues).toHaveLength(1);
    const keySegs = dialogues[0].lines.flatMap((l) => l.segments).filter((s) => s.kind === 'key');
    expect(keySegs).toHaveLength(5);
    for (const seg of keySegs) {
      const s = sentences.find((x) => x.id === seg.keySentenceId)!;
      expect(seg.text).toBe(s.english);
    }
  });

  it('같은 표현은 중복 생성하지 않고 출처를 누적한다', async () => {
    const { repos } = createTestRepos();
    const a = await repos.expressions.upsert({ text: 'Not a big deal.', meaningKo: '별일 아니다', sourceRef: { videoId: 'v1' } });
    const b = await repos.expressions.upsert({ text: 'not a big deal', meaningKo: '', sourceRef: { videoId: 'v2' } });
    expect(b.id).toBe(a.id);
    expect(b.sourceRefs.map((r) => r.videoId)).toEqual(['v1', 'v2']);
    expect(b.meaningKo).toBe('별일 아니다');
    expect(await repos.expressions.list()).toHaveLength(1);
  });

  it('즐겨찾기 저장 후 다시 불러와도 유지된다 (새 연결)', async () => {
    const { db, repos } = createTestRepos();
    await seedSampleData(repos);
    const [d] = await repos.dialogues.list();
    await repos.dialogues.setFavorite(d.id, true);
    const [e] = await repos.expressions.list();
    await repos.expressions.setFavorite(e.id, true);
    db.close();
    const reopened = createIndexedDbRepositories(new StudyDatabase(db.name));
    expect((await reopened.dialogues.get(d.id))?.isFavorite).toBe(true);
    expect((await reopened.expressions.get(e.id))?.isFavorite).toBe(true);
  });

  it('샘플 삭제 시 사용자 데이터는 보존된다', async () => {
    const { repos } = createTestRepos();
    await seedSampleData(repos);
    const [v1] = await repos.videos.list();
    // 사용자 데이터가 샘플과 같은 표현을 사용 → 사용자 표현으로 전환
    await repos.expressions.upsert({ text: 'running behind', meaningKo: '', sourceRef: { videoId: 'user-video' } });
    await repos.expressions.upsert({ text: 'call it a day', meaningKo: '그만하다', sourceRef: { videoId: 'user-video' } });
    const deleted = await repos.maintenance.deleteSampleData();
    expect(deleted).toBeGreaterThan(0);
    expect(await repos.videos.list()).toHaveLength(0);
    const remaining = await repos.expressions.list();
    expect(remaining.map((e) => e.text).sort()).toEqual(['call it a day', 'running behind']);
    // 삭제된 샘플 영상 참조는 정리된다
    expect(remaining.flatMap((e) => e.sourceRefs).some((r) => r.videoId === v1.id)).toBe(false);
    expect(await repos.maintenance.hasSampleData()).toBe(false);
  });

  it('전체 초기화는 모든 테이블을 비운다', async () => {
    const { repos } = createTestRepos();
    await initializeApp(repos, CURRENT_SCHEMA_VERSION);
    await repos.maintenance.clearAll();
    const counts = await repos.maintenance.countAll();
    expect(counts.every((c) => c.total === 0)).toBe(true);
  });

  it('대시보드 통계를 저장된 데이터로 계산한다', async () => {
    const { repos } = createTestRepos();
    await seedSampleData(repos);
    const stats = await loadDashboardStats(repos);
    expect(stats.totalVideos).toBe(3);
    expect(stats.completedVideos).toBe(1);
    expect(stats.inProgressVideos).toBe(1);
    expect(stats.totalDialogues).toBe(3);
    expect(stats.memorizedDialogues).toBe(1);
    expect(stats.studiedDialogues).toBe(2);
    expect(stats.totalExpressions).toBe(10);
    expect(stats.weakExpressions).toBe(4); // 85, 65, 55, 50
    // 오늘 복습: 표현 3개 + 대화문 1개, 우선순위 순
    expect(stats.dueItems.map((d) => d.priority)).toEqual([1, 2, 3, 4]);
    expect(stats.dueItems[0].title).toBe('That makes two of us');
    expect(stats.weekly).toHaveLength(7);
    expect(stats.todayCount).toBe(3);
    expect(stats.weekTotal).toBe(34);
    expect(stats.stepProgress).toBe(47); // (5+2)/15
    expect(stats.continueDialogue?.dialogue.title).toBe('저녁 메뉴 정하기');
  });
});
