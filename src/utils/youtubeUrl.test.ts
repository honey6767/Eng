import { describe, expect, it } from 'vitest';
import { parseYouTubeUrl } from './youtubeUrl';

describe('parseYouTubeUrl', () => {
  it('사용자의 재생목록 URL (si 파라미터 포함)', () => {
    expect(parseYouTubeUrl('https://youtube.com/playlist?list=PLml2lyu7IgZojEeDqGHTamBHgT-k0ib16&si=2ZwyFwTHrGNKVOwF')).toEqual({
      kind: 'playlist',
      playlistId: 'PLml2lyu7IgZojEeDqGHTamBHgT-k0ib16',
    });
  });
  it('다양한 영상 URL 형식', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'youtube.com/shorts/dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
      'dQw4w9WgXcQ',
    ]) {
      expect(parseYouTubeUrl(url)).toEqual({ kind: 'video', videoId: 'dQw4w9WgXcQ' });
    }
  });
  it('재생목록 안의 영상 URL은 선택지로 반환', () => {
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLml2lyu7IgZojEeDqGHTamBHgT-k0ib16&index=3')).toEqual({
      kind: 'video_in_playlist',
      videoId: 'dQw4w9WgXcQ',
      playlistId: 'PLml2lyu7IgZojEeDqGHTamBHgT-k0ib16',
    });
  });
  it('잘못된 입력', () => {
    expect(parseYouTubeUrl('').kind).toBe('invalid');
    expect(parseYouTubeUrl('https://vimeo.com/123').kind).toBe('invalid');
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=short').kind).toBe('invalid');
    expect(parseYouTubeUrl('https://www.youtube.com/playlist').kind).toBe('invalid');
  });
});
