import { describe, expect, it } from 'vitest';
import { parseTranscript } from './transcriptParser';

describe('parseTranscript', () => {
  it('한 줄 타임스탬프 형식', () => {
    const segs = parseTranscript('0:15 Hello there\n[01:02] Second line\n1:02:03 - Third');
    expect(segs).toEqual([
      { startSec: 15, endSec: 62, text: 'Hello there' },
      { startSec: 62, endSec: 3723, text: 'Second line' },
      { startSec: 3723, endSec: null, text: 'Third' },
    ]);
  });

  it('YouTube 스크립트 복사 형식(타임스탬프 다음 줄에 텍스트)', () => {
    const segs = parseTranscript('0:00\nWelcome back\n0:05\nToday we will\nlearn five phrases');
    expect(segs.map((s) => [s.startSec, s.text])).toEqual([
      [0, 'Welcome back'],
      [5, 'Today we will learn five phrases'],
    ]);
  });

  it('SRT 형식', () => {
    const srt = '1\n00:00:01,500 --> 00:00:04,000\nHi.\n\n2\n00:00:04,000 --> 00:00:06,250\nHow are you?\n';
    expect(parseTranscript(srt)).toEqual([
      { startSec: 1.5, endSec: 4, text: 'Hi.' },
      { startSec: 4, endSec: 6.25, text: 'How are you?' },
    ]);
  });

  it('WebVTT 형식', () => {
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:03.000\nFirst cue\n\n00:03.000 --> 00:05.000\nSecond cue';
    expect(parseTranscript(vtt).map((s) => s.text)).toEqual(['First cue', 'Second cue']);
  });

  it('타임스탬프 없는 일반 텍스트', () => {
    expect(parseTranscript('Line one\n\nLine two')).toEqual([
      { startSec: null, endSec: null, text: 'Line one' },
      { startSec: null, endSec: null, text: 'Line two' },
    ]);
  });
});
