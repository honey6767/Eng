import { describe, expect, it } from 'vitest';
import { StudyDatabase } from './database';
import { CURRENT_SCHEMA_VERSION } from './migrations';
import { createIndexedDbRepositories } from '@/repositories/indexeddb';

describe('마이그레이션 v1 → v2', () => {
  it('기존 데이터를 보존하고 새 필드를 채운다', async () => {
    const name = `migration-${Date.now()}`;
    const v1 = new StudyDatabase(name, 1);
    await v1.open();
    const base = { createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' };
    await v1.table('videos').bulkAdd([
      { id: 'v-pl', ...base, playlistId: 'p1', youtubeVideoId: null, title: '기존 영상', url: null, thumbnailUrl: null, durationSec: 100, orderIndex: 0, randomOrderKey: 0.5, status: 'completed', completedAt: base.createdAt, isSample: true },
      { id: 'v-solo', ...base, playlistId: null, youtubeVideoId: 'abcdefghijk', title: '개별', url: null, thumbnailUrl: null, durationSec: null, orderIndex: 1, randomOrderKey: 0.1, status: 'in_progress', completedAt: null },
    ]);
    await v1.table('transcripts').add({ id: 't1', ...base, videoId: 'v-pl', source: 'manual_paste', status: 'success', rawText: 'x', segments: [] });
    await v1.table('expressions').add({ id: 'e1', ...base, normalizedKey: 'k', text: 'k', meaningKo: '', sourceRefs: [], isFavorite: true, isMarkedDifficult: false });
    v1.close();

    const v2 = new StudyDatabase(name);
    await v2.open();
    expect(v2.verno).toBe(CURRENT_SCHEMA_VERSION);
    const repos = createIndexedDbRepositories(v2);
    const pl = (await repos.videos.get('v-pl'))!;
    expect(pl.status).toBe('completed');
    expect(pl.sources).toEqual([{ kind: 'playlist', playlistId: 'p1', position: 0, addedAt: base.createdAt }]);
    expect(pl.metadataSource).toBe('sample');
    expect(pl.captionCheck).toBeNull();
    const solo = (await repos.videos.get('v-solo'))!;
    expect(solo.sources).toEqual([{ kind: 'manual', addedAt: base.createdAt }]);
    expect(solo.status).toBe('in_progress');
    expect((await repos.transcripts.getByVideo('v-pl'))!.format).toBeNull();
    expect((await repos.expressions.get('e1'))!.isFavorite).toBe(true);
  });
});
