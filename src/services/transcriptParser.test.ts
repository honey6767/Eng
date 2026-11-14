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

import { detectFormat, parseTranscriptDetailed } from './transcriptParser';

describe('parseTranscriptDetailed (2단계)', () => {
  it('형식 감지', () => {
    expect(detectFormat('1\n00:00:01,000 --> 00:00:02,000\nHi')).toBe('srt');
    expect(detectFormat('WEBVTT\n\n00:01.000 --> 00:02.000\nHi')).toBe('vtt');
    expect(detectFormat('0:01 Hi')).toBe('timestamped');
    expect(detectFormat('Hi there')).toBe('plain');
  });

  it('VTT: 큐 식별자, 큐 설정, 태그, NOTE, 롤링 중복 제거', () => {
    const vtt = [
      'WEBVTT',
      'Kind: captions',
      'Language: en',
      '',
      'NOTE 이 블록은 무시',
      '',
      'intro',
      '00:00:01.000 --> 00:00:03.500 align:start position:0%',
      '<c.colorE5E5E5>Hello</c> <00:00:02.000><c>world</c>',
      '',
      '00:00:03.500 --> 00:00:05.000',
      'Hello world',
      '',
      '00:00:05.000 --> 00:00:07.000',
      'It&#39;s &amp; done',
    ].join('\n');
    const r = parseTranscriptDetailed(vtt);
    expect(r.format).toBe('vtt');
    expect(r.segments).toEqual([
      { startSec: 1, endSec: 3.5, text: 'Hello world' },
      { startSec: 5, endSec: 7, text: "It's & done" },
    ]);
  });

  it('SRT: 여러 줄 텍스트, BOM, CRLF', () => {
    const srt = '﻿1\r\n00:01:02,345 --> 00:01:04,000\r\nLine one\r\nline two\r\n\r\n2\r\n00:01:04,000 --> 00:01:05,000\r\nNext\r\n';
    const r = parseTranscriptDetailed(srt);
    expect(r.format).toBe('srt');
    expect(r.segments[0]).toEqual({ startSec: 62.345, endSec: 64, text: 'Line one line two' });
    expect(r.timedCount).toBe(2);
  });

  it('타임스탬프 텍스트: 괄호·대시 형식과 시간 단위', () => {
    const r = parseTranscriptDetailed('(0:05) First\n1:02:03 — Second\n[12:00] Third');
    expect(r.segments.map((s) => [s.startSec, s.text])).toEqual([
      [5, 'First'],
      [3723, 'Second'],
      [720, 'Third'],
    ]);
  });
});
