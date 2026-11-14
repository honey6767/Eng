/**
 * 테스트 전용 가짜 Google/YouTube 응답 (YOUTUBE_API_MOCK=1 일 때만 사용).
 * 실제 서비스와 혼동되지 않도록 ID와 제목에 'mock' / '[MOCK]'을 붙인다.
 *
 * - 재생목록 PLmockPlaylist0000001: 항목 122개(3페이지) — 영상 120개 + 비공개 1 + 삭제 1
 * - 재생목록 PLmockPlaylist0000002: 항목 3개 — 첫 재생목록과 영상 2개가 겹침(중복 테스트)
 * - 개별 영상 mocksolo001 (재생목록에 없음), mockvid0005 (재생목록에 있음)
 * - 자막: mockvid0001은 영어 자동 생성 자막 트랙 있음, 나머지는 없음
 * - 재생목록 PLmockQuotaExceeded01: 할당량 초과 응답
 */
const PL1 = 'PLmockPlaylist0000001';
const PL2 = 'PLmockPlaylist0000002';
const PL_QUOTA = 'PLmockQuotaExceeded01';

const vid = (n: number) => `mockvid${String(n).padStart(4, '0')}`;

function videoResource(id: string) {
  const n = Number(id.replace(/\D/g, '')) || 7;
  return {
    id,
    snippet: {
      title: id.startsWith('mocksolo') ? '[MOCK] 개별 등록 테스트 영상' : `[MOCK] 테스트 영상 ${n}`,
      channelTitle: '[MOCK] 테스트 채널',
      publishedAt: '2026-01-01T00:00:00Z',
      thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } },
    },
    contentDetails: { duration: `PT${10 + (n % 5)}M${(n * 7) % 60}S` },
    status: { privacyStatus: 'public' },
  };
}

function playlistItems(playlistId: string): { videoId: string; title: string }[] {
  if (playlistId === PL1) {
    const items = Array.from({ length: 120 }, (_, i) => ({ videoId: vid(i + 1), title: `[MOCK] 테스트 영상 ${i + 1}` }));
    items.splice(10, 0, { videoId: 'mockpriv001', title: 'Private video' });
    items.splice(50, 0, { videoId: 'mockdele001', title: 'Deleted video' });
    return items;
  }
  if (playlistId === PL2) {
    return [
      { videoId: vid(3), title: '' },
      { videoId: vid(5), title: '' },
      { videoId: vid(200), title: '' },
    ];
  }
  return [];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const mockFetch: typeof fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const p = url.searchParams;
  const resource = url.pathname.split('/').pop();

  if (url.hostname === 'www.googleapis.com') {
    if (resource === 'playlists') {
      const id = p.get('id')!;
      if (id === PL_QUOTA) return json({ error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }, 403);
      const items = playlistItems(id);
      if (!items.length) return json({ items: [] });
      return json({
        items: [
          {
            id,
            snippet: { title: id === PL1 ? '[MOCK] 테스트 재생목록' : '[MOCK] 겹치는 재생목록', channelTitle: '[MOCK] 테스트 채널', thumbnails: {} },
            contentDetails: { itemCount: items.length },
          },
        ],
      });
    }
    if (resource === 'playlistItems') {
      const all = playlistItems(p.get('playlistId')!);
      const start = Number(p.get('pageToken') ?? 0);
      const page = all.slice(start, start + 50);
      const next = start + 50 < all.length ? String(start + 50) : undefined;
      return json({
        items: page.map((it, i) => ({
          snippet: { title: it.title, position: start + i, resourceId: { videoId: it.videoId } },
          contentDetails: { videoId: it.videoId },
        })),
        nextPageToken: next,
      });
    }
    if (resource === 'videos') {
      const ids = (p.get('id') ?? '').split(',');
      const items = ids.filter((id) => /^mock(vid|solo)/.test(id)).map(videoResource);
      return json({ items });
    }
    if (resource === 'captions') {
      const id = p.get('videoId');
      return json({ items: id === vid(1) ? [{ snippet: { language: 'en', name: '', trackKind: 'asr' } }] : [] });
    }
  }
  return json({ error: { code: 404, message: 'mock: not found' } }, 404);
};
