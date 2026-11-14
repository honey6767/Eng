import { describe, expect, it, vi } from 'vitest';
import { handleYouTubeApi, type HandlerDeps } from './handler.ts';
import { QuotaTracker, memoryQuotaStore } from './quota.ts';
import { mockFetch } from './mock.ts';
import { parseIsoDuration, parsePlaylistRss } from './parse.ts';

const deps = (over: Partial<HandlerDeps> = {}): HandlerDeps => ({
  apiKey: 'test-key',
  quota: new QuotaTracker(memoryQuotaStore(), 9000),
  fetch: mockFetch,
  ...over,
});
const call = (path: string, d = deps()) => handleYouTubeApi(new URL(`http://x/api/youtube/${path}`), d);

describe('YouTube 프록시 핸들러', () => {
  it('재생목록 전체를 페이지네이션으로 가져오고, 비공개/삭제 영상을 구분한다', async () => {
    const d = deps();
    const r = await call('playlist?id=PLmockPlaylist0000001', d);
    expect(r!.status).toBe(200);
    const body = r!.body as { videos: { videoId: string; durationSec: number }[]; unavailable: { reason: string }[]; complete: boolean; unitsUsed: number };
    expect(body.videos).toHaveLength(120);
    expect(body.unavailable.map((u) => u.reason).sort()).toEqual(['비공개 영상', '삭제된 영상'].sort());
    expect(body.complete).toBe(true);
    expect(body.videos[0].durationSec).toBeGreaterThan(0);
    // playlists 1 + playlistItems 3페이지 + videos 3배치
    expect(body.unitsUsed).toBe(7);
    expect(d.quota.snapshot().used).toBe(7);
  });

  it('API 키는 헤더로만 전달하고 URL·응답에 포함하지 않는다', async () => {
    const spy = vi.fn(mockFetch);
    const r = await call('video?id=mocksolo001', deps({ apiKey: 'SECRET-KEY-123', fetch: spy as typeof fetch }));
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).not.toContain('SECRET');
    expect((init?.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('SECRET-KEY-123');
    expect(JSON.stringify(r!.body)).not.toContain('SECRET');
  });

  it('할당량 초과 응답을 받으면 오늘은 더 이상 호출하지 않는다', async () => {
    const d = deps();
    const r = await call('playlist?id=PLmockQuotaExceeded01', d);
    expect(r!.status).toBe(429);
    expect((r!.body as { code: string }).code).toBe('quota_exceeded');
    const spy = vi.fn(mockFetch);
    const r2 = await call('video?id=mocksolo001', { ...d, fetch: spy as typeof fetch });
    expect(r2!.status).toBe(429);
    expect(spy).not.toHaveBeenCalled();
  });

  it('자체 상한에 도달하면 호출 전에 중단한다', async () => {
    const d = deps({ quota: new QuotaTracker(memoryQuotaStore(), 60) });
    expect((await call('captions?id=mockvid0001', d))!.status).toBe(200); // 50
    const r = await call('captions?id=mockvid0001', d); // 100 > 60
    expect((r!.body as { code: string }).code).toBe('local_cap_reached');
  });

  it('자막: 트랙이 있어도 다운로드 불가로 응답한다', async () => {
    const r = await call('captions?id=mockvid0001');
    expect(r!.body).toMatchObject({ ok: true, downloadable: false, tracks: [{ language: 'en', kind: 'asr' }] });
  });

  it('키가 없으면 제한 모드, 자막 확인은 not_configured', async () => {
    const r = await call('status', deps({ apiKey: null }));
    expect((r!.body as { mode: string }).mode).toBe('limited');
    const c = await call('captions?id=mockvid0001', deps({ apiKey: null }));
    expect((c!.body as { code: string }).code).toBe('not_configured');
  });

  it('제한 모드: oEmbed로 영상 정보 (길이 없음)', async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ title: 'Hello', author_name: 'Ch', thumbnail_url: 'https://i.ytimg.com/x.jpg' }))) as typeof fetch;
    const r = await call('video?id=dQw4w9WgXcQ', deps({ apiKey: null, fetch: fake }));
    expect(r!.body).toMatchObject({ ok: true, source: 'oembed', video: { title: 'Hello', durationSec: null } });
  });

  it('제한 모드: RSS로 재생목록 (complete=false)', async () => {
    const xml = `<?xml version="1.0"?><feed><title>My List</title><author><name>Ch</name></author>
      <entry><yt:videoId>dQw4w9WgXcQ</yt:videoId><title>A &amp; B</title><author><name>Ch</name></author><published>2026-01-01</published><media:group><media:thumbnail url="https://i.ytimg.com/a.jpg" width="480"/></media:group></entry></feed>`;
    const fake = (async () => new Response(xml)) as typeof fetch;
    const r = await call('playlist?id=PLml2lyu7IgZojEeDqGHTamBHgT-k0ib16', deps({ apiKey: null, fetch: fake }));
    expect(r!.body).toMatchObject({ source: 'rss', complete: false, playlist: { title: 'My List' }, videos: [{ videoId: 'dQw4w9WgXcQ', title: 'A & B' }] });
  });

  it('Google 오류 매핑: 잘못된 키 / API 미활성화', async () => {
    const badKey = (async () =>
      new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', errors: [{ reason: 'badRequest' }] } }), { status: 400 })) as typeof fetch;
    expect(((await call('video?id=mocksolo001', deps({ fetch: badKey })))!.body as { code: string }).code).toBe('invalid_key');
    const disabled = (async () =>
      new Response(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } }), { status: 403 })) as typeof fetch;
    expect(((await call('video?id=mocksolo001', deps({ fetch: disabled })))!.body as { code: string }).code).toBe('forbidden');
  });

  it('잘못된 ID는 Google을 호출하지 않는다', async () => {
    const spy = vi.fn(mockFetch);
    const r = await call('video?id=bad', deps({ fetch: spy as typeof fetch }));
    expect(r!.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('ISO 기간 파싱 / RSS 파서', () => {
    expect(parseIsoDuration('PT12M35S')).toBe(755);
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
    expect(parseIsoDuration('P1DT1S')).toBe(86401);
    expect(parseIsoDuration('P0D')).toBeNull();
    expect(parsePlaylistRss('<feed><title>T</title></feed>').entries).toEqual([]);
  });
});
