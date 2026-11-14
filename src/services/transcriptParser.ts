import type { TranscriptSegment } from '@/types/models';

/**
 * 자막 텍스트 파서 (붙여넣기용)
 *
 * 지원 형식:
 *  - 타임스탬프 + 텍스트 한 줄: "0:15 Hello", "00:01:15 Hello", "[01:15] Hello", "(1:15) Hello"
 *  - 타임스탬프만 있는 줄 다음 줄에 텍스트 (YouTube '스크립트 표시' 복사 형식)
 *  - SRT / WebVTT: "00:00:01,000 --> 00:00:04,000" 블록
 *  - 타임스탬프 없는 일반 텍스트: 줄 단위 세그먼트, startSec=null
 */
const TS = String.raw`(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?`;
const RANGE_RE = new RegExp(`^${TS}\\s*-->\\s*${TS}`);
const LEADING_TS_RE = new RegExp(`^[\\[(]?${TS}[\\])]?\\s*(?:[-–—:]\\s*)?(.*)$`);

function toSec(h: string | undefined, m: string, s: string, ms?: string): number {
  return (h ? Number(h) * 3600 : 0) + Number(m) * 60 + Number(s) + (ms ? Number(ms.padEnd(3, '0')) / 1000 : 0);
}

export function parseTranscript(raw: string): TranscriptSegment[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim());
  const segments: TranscriptSegment[] = [];
  let pendingStart: number | null = null;
  let pendingEnd: number | null = null;
  let pendingText: string[] = [];
  let hasTimestamp = false;

  const flush = () => {
    const text = pendingText.join(' ').replace(/\s+/g, ' ').trim();
    if (text) segments.push({ startSec: pendingStart, endSec: pendingEnd, text });
    pendingText = [];
    pendingStart = null;
    pendingEnd = null;
  };

  for (const line of lines) {
    if (!line || line === 'WEBVTT' || /^\d+$/.test(line)) {
      // 빈 줄 / VTT 헤더 / SRT 번호
      if (!line) flush();
      continue;
    }
    const range = line.match(RANGE_RE);
    if (range) {
      flush();
      hasTimestamp = true;
      pendingStart = toSec(range[1], range[2], range[3], range[4]);
      pendingEnd = toSec(range[5], range[6], range[7], range[8]);
      continue;
    }
    const lead = line.match(LEADING_TS_RE);
    if (lead) {
      flush();
      hasTimestamp = true;
      pendingStart = toSec(lead[1], lead[2], lead[3], lead[4]);
      const rest = lead[5]?.trim();
      if (rest) pendingText.push(rest);
      continue;
    }
    if (!hasTimestamp) {
      segments.push({ startSec: null, endSec: null, text: line });
      continue;
    }
    pendingText.push(line);
  }
  flush();

  // 다음 세그먼트 시작을 이전 세그먼트 끝으로 보정
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].endSec == null && segments[i].startSec != null) {
      segments[i].endSec = segments[i + 1].startSec;
    }
  }
  return segments;
}
