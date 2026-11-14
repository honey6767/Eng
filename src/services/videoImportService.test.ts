import { describe, expect, it } from 'vitest';
import { createTestRepos } from '@/test/helpers';
import { handleYouTubeApi } from '../../server/youtube/handler';
import { QuotaTracker, memoryQuotaStore } from '../../server/youtube/quota';
import { mockFetch } from '../../server/youtube/mock';
import type { YouTubeClient } from './integrations/youtubeClient';
import { YouTubeApiError } from './integrations/youtubeClient';
import { checkCaptions, importPlaylist, importVideo, importVideoWithoutProxy } from './videoImportService';
import { seedSampleData } from './seedService';
import { setVideoStatus, startVideo, syncStudyQueue, viewQueue, META_STUDY_QUEUE, type StudyQueueState } from './studyQueue';

/** 실제 서버 핸들러 + 가짜 Google 응답으로 만든 클라이언트 (브라우저 fetch 경로만 생략) */
function mockClient(apiKey: string | null = 'k'): YouTubeClient {
  const deps = { apiKey, quota: new QuotaTracker(memoryQuotaStore(), 9000), fetch: mockFetch };
  const req = async <T,>(path: string): Promise<T> => {
    const r = await handleYouTubeApi(new URL(`http://x/api/youtube/${path}`), deps);
    const body = r!.body as { ok: boolean; code?: string; message?: string };
    if (!body.ok) throw new YouTubeApiError(body.code as never, body.message!);
    return body as T;
  };
  return {
    status: async () => ({ available: true, status: await req('status') }),
    video: (id) => req(`video?id=${id}`),
    playlist: (id) => req(`playlist?id=${id}`),
    captions: (id) => req(`captions?id=${id}`),
  };
}

describe('영상 등록 서비스', () => {
  it('재생목록 전체 등록 + 같은 재생목록 재등록 시 중복 없음', async () => {
    const { repos } = createTestRepos();
    const client = mockClient();
    const first = await importPlaylist(repos, client, 'PLmockPlaylist0000001');
    expect(first.playlistCreated).toBe(true);
    expect(first.added).toBe(120);
    expect(first.unavailable).toHaveLength(2);
    const again = await importPlaylist(repos, client, 'PLmockPlaylist0000001');
    expect(again.playlistCreated).toBe(false);
    expect(again.added).toBe(0);
    expect(again.unchanged).toBe(120);
    expect(await repos.playlists.list()).toHaveLength(1);
    expect(await repos.videos.list()).toHaveLength(120);
    const pl = (await repos.playlists.list())[0];
    expect(pl.syncStatus).toBe('success');
    expect(pl.lastSyncSummary).toMatchObject({ totalItems: 122, added: 0, unavailable: 2, complete: true });
  });

  it('개별 URL ↔ 재생목록 중복 방지: 학습 상태는 유지하고 출처만 연결', async () => {
    const { repos } = createTestRepos();
    const client = mockClient();
    await importPlaylist(repos, client, 'PLmockPlaylist0000001');
    const v5 = (await repos.videos.getByYouTubeId('mockvid0005'))!;
    await setVideoStatus(repos, v5, 'completed');

    const single = await importVideo(repos, client, 'mockvid0005');
    expect(single.added).toBe(0);
    expect(single.linked).toBe(1);
    const after = (await repos.videos.getByYouTubeId('mockvid0005'))!;
    expect(after.id).toBe(v5.id);
    expect(after.status).toBe('completed');
    expect(after.sources.map((s) => s.kind)).toEqual(['playlist', 'manual']);

    // 개별 먼저 → 재생목록 나중
    const solo = await importVideo(repos, client, 'mocksolo001');
    expect(solo.added).toBe(1);
    const overlap = await importPlaylist(repos, client, 'PLmockPlaylist0000002');
    expect(overlap.added).toBe(1); // mockvid0200만 신규
    expect(overlap.linked).toBe(2); // mockvid0003, 0005는 두 번째 재생목록 출처 연결
    expect((await repos.videos.list()).filter((v) => v.youtubeVideoId === 'mockvid0005')).toHaveLength(1);
    expect((await repos.videos.getByYouTubeId('mockvid0005'))!.sources).toHaveLength(3);
  });

  it('프록시 없이 등록한 영상은 나중에 API 정보로 보강된다', async () => {
    const { repos } = createTestRepos();
    const manual = await importVideoWithoutProxy(repos, 'mocksolo001', '');
    expect(manual.videos[0]).toMatchObject({ title: 'YouTube 영상 (mocksolo001)', durationSec: null, metadataSource: 'manual' });
    expect(manual.videos[0].thumbnailUrl).toBe('https://i.ytimg.com/vi/mocksolo001/hqdefault.jpg');
    await importVideo(repos, mockClient(), 'mocksolo001');
    const v = (await repos.videos.getByYouTubeId('mocksolo001'))!;
    expect(v.title).toBe('[MOCK] 개별 등록 테스트 영상');
    expect(v.durationSec).toBeGreaterThan(0);
    expect(v.metadataSource).toBe('youtube_api');
  });

  it('자막 확인: 트랙이 있어도 자막은 자동 등록하지 않는다', async () => {
    const { repos } = createTestRepos();
    await importPlaylist(repos, mockClient(), 'PLmockPlaylist0000001');
    const v1 = (await repos.videos.getByYouTubeId('mockvid0001'))!;
    const c1 = await checkCaptions(repos, mockClient(), v1);
    expect(c1.result).toBe('tracks_found_no_permission');
    expect(await repos.transcripts.getByVideo(v1.id)).toBeUndefined();
    const v2 = (await repos.videos.getByYouTubeId('mockvid0002'))!;
    expect((await checkCaptions(repos, mockClient(), v2)).result).toBe('no_tracks');
    const v3 = (await repos.videos.getByYouTubeId('mockvid0003'))!;
    expect((await checkCaptions(repos, mockClient(null), v3)).result).toBe('not_configured');
    expect((await repos.videos.get(v1.id))!.captionCheck?.result).toBe('tracks_found_no_permission');
  });

  it('무작위 학습: 실제 영상만 대상, 완료 제외, 전체 학습 후 재셔플, 저장 후 유지', async () => {
    const { repos } = createTestRepos();
    await seedSampleData(repos);
    await importPlaylist(repos, mockClient(), 'PLmockPlaylist0000002'); // 영상 3개
    const videos = await repos.videos.list();
    let state = (await repos.meta.get<StudyQueueState>(META_STUDY_QUEUE))!;
    expect(state.order).toHaveLength(3); // 샘플 3개 제외
    const firstPick = viewQueue(state, videos).current!;

    // 새로고침 = 다시 sync → 순서 그대로
    await syncStudyQueue(repos);
    expect((await repos.meta.get<StudyQueueState>(META_STUDY_QUEUE))!.order).toEqual(state.order);

    await startVideo(repos, firstPick);
    expect((await repos.videos.get(firstPick.id))!.status).toBe('in_progress');
    const second = viewQueue(await repos.meta.get(META_STUDY_QUEUE), await repos.videos.list()).current!;
    expect(second.id).not.toBe(firstPick.id);
    await setVideoStatus(repos, second, 'completed');
    const third = viewQueue(await repos.meta.get(META_STUDY_QUEUE), await repos.videos.list()).current!;
    await startVideo(repos, third);

    state = (await repos.meta.get<StudyQueueState>(META_STUDY_QUEUE))!;
    expect(state.cycle).toBe(2); // 전부 한 번씩 학습 → 재셔플
    expect(state.order).toHaveLength(2); // 완료 영상 제외
    expect(state.order).not.toContain(second.id);
  });

  it('샘플 삭제 시 실제 YouTube 영상·자막은 보존', async () => {
    const { repos } = createTestRepos();
    await seedSampleData(repos);
    await importVideo(repos, mockClient(), 'mocksolo001');
    const v = (await repos.videos.getByYouTubeId('mocksolo001'))!;
    await repos.transcripts.save(v.id, { source: 'manual_paste', status: 'success', rawText: '0:01 hi', segments: [{ startSec: 1, endSec: null, text: 'hi' }], format: 'timestamped' });
    await repos.maintenance.deleteSampleData();
    expect((await repos.videos.list()).map((x) => x.youtubeVideoId)).toEqual(['mocksolo001']);
    expect(await repos.transcripts.getByVideo(v.id)).toBeDefined();
  });
});
