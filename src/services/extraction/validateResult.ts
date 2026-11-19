/**
 * Gemini 결과 검사 (초안 저장 전)
 *
 * - 깨진 JSON·형식 오류: 초안으로 저장하지 않는다(fatal).
 * - 영상 길이(+5초)를 넘거나 순서가 맞지 않는 타임스탬프: 그 전사 구간은 거부하고(초안에서 뺌) 문제로 기록한다.
 * - 품질 문제: 긴 공백(전사 누락 의심), 끝부분 누락, 낮은 전사 비율, 전사에 없는 근거 문장 — 표시만 한다.
 * 초안은 항상 '검토 대기'로 저장되고, 학습 데이터에는 검토·승인(B1-d) 전까지 들어가지 않는다.
 */

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}
export interface KeyExpressionDraft {
  text: string;
  meaningKo: string;
  sourceSentence: string;
  timestampSec: number | null;
  onScreen: boolean;
  confidence: number;
}
export interface IntroChunkDraft {
  text: string;
  meaningKo: string;
  timestampSec: number | null;
}
export interface ExtractionResult {
  language: string;
  dayNumber: number | null;
  transcript: TranscriptSegment[];
  keyExpressions: KeyExpressionDraft[];
  introChunks: IntroChunkDraft[];
  notes: string;
}

export type IssueCode =
  | 'timestamp_out_of_range'
  | 'timestamp_order'
  | 'expression_timestamp_out_of_range'
  | 'gap'
  | 'incomplete_end'
  | 'low_coverage'
  | 'empty_transcript'
  | 'source_not_found';

export interface ValidationIssue {
  code: IssueCode;
  message: string;
  /** 관련 구간·표현 */
  detail?: string;
}

export type ValidationOutcome =
  | { ok: true; result: ExtractionResult; issues: ValidationIssue[]; rejectedSegments: TranscriptSegment[] }
  | { ok: false; error: string };

/** 타임스탬프 허용 오차 (초) */
export const TIMESTAMP_TOLERANCE_SEC = 5;
/** 이보다 긴 공백은 전사 누락 의심 */
export const GAP_WARN_SEC = 20;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function validateExtraction(text: string, durationSec: number): ValidationOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'AI 응답이 올바른 JSON이 아니에요.' };
  }
  if (!isObj(raw) || !Array.isArray(raw.transcript) || !Array.isArray(raw.keyExpressions)) return { ok: false, error: 'AI 응답에 필요한 항목(transcript·keyExpressions)이 없어요.' };

  const limit = durationSec + TIMESTAMP_TOLERANCE_SEC;
  const issues: ValidationIssue[] = [];
  const kept: TranscriptSegment[] = [];
  const rejectedSegments: TranscriptSegment[] = [];
  let prevStart = -1;
  for (const s of raw.transcript) {
    if (!isObj(s)) continue;
    const seg = { start: num(s.start) ?? -1, end: num(s.end) ?? -1, text: str(s.text).trim() };
    if (!seg.text) continue;
    if (seg.start < 0 || seg.end < seg.start || seg.start > limit || seg.end > limit) {
      rejectedSegments.push(seg);
      continue;
    }
    if (seg.start < prevStart) issues.push({ code: 'timestamp_order', message: '전사 구간의 시간 순서가 맞지 않아요.', detail: `${fmt(seg.start)} "${seg.text.slice(0, 30)}"` });
    prevStart = seg.start;
    kept.push(seg);
  }
  if (rejectedSegments.length) {
    issues.push({
      code: 'timestamp_out_of_range',
      message: `영상 길이(${fmt(durationSec)})를 넘거나 잘못된 시간의 전사 구간 ${rejectedSegments.length}개를 뺐어요.`,
      detail: rejectedSegments.slice(0, 5).map((r) => `${r.start}~${r.end}초`).join(', '),
    });
  }
  if (kept.length === 0) issues.push({ code: 'empty_transcript', message: '사용할 수 있는 전사 구간이 없어요.' });

  // 품질: 공백·끝부분·전사 비율
  const sorted = [...kept].sort((a, b) => a.start - b.start);
  let covered = 0;
  let cursor = 0;
  for (const s of sorted) {
    if (s.start - cursor > GAP_WARN_SEC) issues.push({ code: 'gap', message: '전사가 비어 있는 구간이 있어요(누락 의심).', detail: `${fmt(cursor)}~${fmt(s.start)}` });
    covered += Math.max(0, s.end - Math.max(s.start, cursor));
    cursor = Math.max(cursor, s.end);
  }
  if (sorted.length && durationSec - cursor > GAP_WARN_SEC) issues.push({ code: 'incomplete_end', message: '영상 끝부분 전사가 없어요(누락 의심).', detail: `${fmt(cursor)}~${fmt(durationSec)}` });
  if (sorted.length && covered / durationSec < 0.5) issues.push({ code: 'low_coverage', message: `전사가 영상의 ${Math.round((covered / durationSec) * 100)}%만 덮어요.` });

  const allText = kept.map((s) => s.text).join('\n');
  const keyExpressions: KeyExpressionDraft[] = [];
  for (const k of raw.keyExpressions) {
    if (!isObj(k) || !str(k.text).trim()) continue;
    let ts = num(k.timestampSec);
    if (ts !== null && (ts < 0 || ts > limit)) {
      issues.push({ code: 'expression_timestamp_out_of_range', message: '핵심 표현의 시각이 영상 길이를 넘어요(시각을 비웠어요).', detail: str(k.text) });
      ts = null;
    }
    const src = str(k.sourceSentence).trim();
    if (src && !allText.includes(src)) issues.push({ code: 'source_not_found', message: '핵심 표현의 근거 문장이 전사에 없어요.', detail: str(k.text) });
    keyExpressions.push({ text: str(k.text).trim(), meaningKo: str(k.meaningKo), sourceSentence: src, timestampSec: ts, onScreen: k.onScreen === true, confidence: num(k.confidence) ?? 0 });
  }
  const introChunks: IntroChunkDraft[] = (Array.isArray(raw.introChunks) ? raw.introChunks : [])
    .filter(isObj)
    .filter((c) => str(c.text).trim())
    .map((c) => {
      const ts = num(c.timestampSec);
      return { text: str(c.text).trim(), meaningKo: str(c.meaningKo), timestampSec: ts !== null && ts >= 0 && ts <= limit ? ts : null };
    });
  const day = num(raw.dayNumber);
  return {
    ok: true,
    result: { language: str(raw.language) || 'mixed', dayNumber: day && day > 0 ? Math.floor(day) : null, transcript: kept, keyExpressions, introChunks, notes: str(raw.notes) },
    issues,
    rejectedSegments,
  };
}
