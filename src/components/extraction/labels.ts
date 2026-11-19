/** AI 자막 관리 화면에서 쓰는 사람이 읽는 이름 */
export const ISSUE_LABEL: Record<string, string> = {
  empty_transcript: '전사 없음',
  low_coverage: '전사가 영상의 절반도 안 됨',
  no_key_expressions: '핵심 표현을 찾지 못함',
  timestamp_out_of_range: '영상 길이를 넘는 시간 구간 제거',
  timestamp_order: '시간 순서가 맞지 않음',
  expression_timestamp_out_of_range: '표현 시각이 영상 길이를 넘음',
  gap: '중간에 빈 구간(누락 의심)',
  incomplete_end: '끝부분 누락 의심',
  source_not_found: '근거 문장이 전사에 없음',
};

export const ERROR_LABEL: Record<string, string> = {
  gemini_failed: 'AI 처리 실패',
  gemini_rejected: 'AI가 영상을 처리할 수 없음(비공개 등)',
  unknown: '결과를 확인하지 못함',
  expired: '결과 보관 기간이 지남',
  invalid_result: 'AI 응답 형식 오류',
  too_long: '긴 영상',
  no_duration: '영상 길이를 모름',
  key_conflict: '요청 기록 충돌',
};

export const issueText = (code: string) => ISSUE_LABEL[code] ?? code;
export const errorText = (code: string | undefined | null) => (code ? ERROR_LABEL[code] ?? code : '');
