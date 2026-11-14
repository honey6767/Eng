import type { TranscriptFormat, TranscriptSegment } from '@/types/models';

/**
 * 자막 텍스트 파서 (붙여넣기·파일 업로드용)
 *
 * 지원 형식:
 *  - SRT: "1\n00:00:01,000 --> 00:00:04,000\n텍스트"
 *  - WebVTT: "WEBVTT" 헤더, 큐 식별자, 큐 설정(align:start 등), <c> 태그, 인라인 타임스탬프, NOTE/STYLE 블록
 *  - 타임스탬프 + 텍스트 한 줄: "0:15 Hello", "00:01:15 Hello", "[01:15] Hello", "(1:15) Hello", "1:15 - Hello"
 *  - 타임스탬프만 있는 줄 다음 줄에 텍스트 (YouTube '스크립트 표시' 복사 형식)
 *  - 타임스탬프 없는 일반 텍스트: 줄(문단) 단위 세그먼트, startSec=null
 */
const TS = String.raw`(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?`;
const RANGE_RE = new RegExp(`^${TS}\\s*-->\\s*${TS}`);
const LEADING_TS_RE = new RegExp(`^[\\[(]?${TS}[\\])]?(?:\\s+(?:[-–—:]\\s*)?(.*)|\\s*$)`);

function toSec(h: string | undefined, m: string, s: string, ms?: string): number {
  const sec = (h ? Number(h) * 3600 : 0) + Number(m) * 60 + Number(s) + (ms ? Number(ms.padEnd(3, '0')) / 1000 : 0);
  return Math.round(sec * 1000) / 1000;
}

/** VTT 태그/인라인 타임스탬프/HTML 엔티티 제거 */
function cleanCueText(text: string): string {
  return text
    .replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/g, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ParsedTranscript {
  format: TranscriptFormat;
  segments: TranscriptSegment[];
  /** 타임스탬프가 있는 세그먼트 수 */
  timedCount: number;
}

export function detectFormat(raw: string): TranscriptFormat {
  const text = raw.replace(/^﻿/, '').trimStart();
  if (/^WEBVTT/.test(text)) return 'vtt';
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => RANGE_RE.test(l))) {
    return lines.some((l) => /\d,\d{3}\s*-->/.test(l)) ? 'srt' : 'vtt';
  }
  if (lines.some((l) => LEADING_TS_RE.test(l))) return 'timestamped';
  return 'plain';
}

export function parseTranscriptDetailed(raw: string): ParsedTranscript {
  const format = detectFormat(raw);
  const lines = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim());
  const segments: TranscriptSegment[] = [];
  let pendingStart: number | null = null;
  let pendingEnd: number | null = null;
  let pendingText: string[] = [];
  let skipBlock = false;

  const flush = () => {
    const text = cleanCueText(pendingText.join(' '));
    if (text) {
      // YouTube 자동 자막 VTT의 롤링 중복(직전과 동일한 문장) 제거
      const prev = segments[segments.length - 1];
      if (!(prev && prev.text === text)) segments.push({ startSec: pendingStart, endSec: pendingEnd, text });
    }
    pendingText = [];
    pendingStart = null;
    pendingEnd = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      flush();
      skipBlock = false;
      continue;
    }
    if (skipBlock) continue;

    if (format === 'srt' || format === 'vtt') {
      if (/^WEBVTT/.test(line) || /^(Kind|Language):/i.test(line)) continue;
      if (/^(NOTE|STYLE|REGION)\b/.test(line)) {
        skipBlock = true;
        continue;
      }
      const range = line.match(RANGE_RE);
      if (range) {
        flush();
        pendingStart = toSec(range[1], range[2], range[3], range[4]);
        pendingEnd = toSec(range[5], range[6], range[7], range[8]);
        continue;
      }
      // 큐 번호(SRT) 또는 큐 식별자(VTT): 다음 줄이 시간 범위면 무시
      if (pendingStart === null && (lines[i + 1] ?? '').match(RANGE_RE)) continue;
      if (pendingStart === null && /^\d+$/.test(line)) continue;
      pendingText.push(line);
      continue;
    }

    if (format === 'timestamped') {
      const lead = line.match(LEADING_TS_RE);
      if (lead) {
        flush();
        pendingStart = toSec(lead[1], lead[2], lead[3], lead[4]);
        const rest = lead[5]?.trim();
        if (rest) pendingText.push(rest);
        continue;
      }
      pendingText.push(line);
      continue;
    }

    // plain: 줄 단위
    segments.push({ startSec: null, endSec: null, text: cleanCueText(line) });
  }
  flush();

  // 끝 시간이 없으면 다음 세그먼트 시작으로 보정
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].endSec == null && segments[i].startSec != null) {
      segments[i].endSec = segments[i + 1].startSec;
    }
  }
  return { format, segments, timedCount: segments.filter((s) => s.startSec != null).length };
}

/** 이전 버전 호환: 세그먼트만 반환 */
export function parseTranscript(raw: string): TranscriptSegment[] {
  return parseTranscriptDetailed(raw).segments;
}
