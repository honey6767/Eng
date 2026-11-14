/**
 * 표현 중복 판별용 정규화 키
 * - 대소문자 무시, 곡선 따옴표 통일, 끝 구두점 제거, 공백 정리
 * 예: "It's not a big deal." / "it’s not a big deal" → "it's not a big deal"
 */
export function normalizeExpressionKey(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s"'(]+|[\s.,!?;:"')]+$/g, '')
    .trim();
}

/** 대화 한 줄의 영어 전체 문장 */
export function joinSegments(segments: { text: string }[]): string {
  return segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(' ');
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}
