/**
 * 마스코트 '톡이' — 말풍선 친구. 정복한 대화문 수에 따라 자란다.
 * 성장 단계는 정복한 대화문 수로만 계산하므로, 쉬는 날이 있어도 줄어들지 않는다.
 */
export type TokiStage = 'egg' | 'sprout' | 'kid' | 'chatty' | 'native';

export const TOKI_STAGES: { stage: TokiStage; name: string; from: number }[] = [
  { stage: 'egg', name: '말풍선 알', from: 0 },
  { stage: 'sprout', name: '새싹 톡이', from: 1 },
  { stage: 'kid', name: '꼬마 톡이', from: 5 },
  { stage: 'chatty', name: '수다 톡이', from: 20 },
  { stage: 'native', name: '원어민 톡이', from: 100 },
];

/** 정복한 대화문 수 → 현재 단계와 다음 단계까지 남은 수 */
export function tokiProgress(memorized: number) {
  let idx = 0;
  TOKI_STAGES.forEach((s, i) => {
    if (memorized >= s.from) idx = i;
  });
  const current = TOKI_STAGES[idx];
  const next = TOKI_STAGES[idx + 1] ?? null;
  return {
    current,
    next,
    remaining: next ? next.from - memorized : 0,
    /** 현재 단계 안에서의 진행률 0~100 */
    percent: next ? Math.round(((memorized - current.from) / (next.from - current.from)) * 100) : 100,
  };
}

const BUBBLE = 'M22 14h76a18 18 0 0 1 18 18v38a18 18 0 0 1-18 18H52l-18 16 4-16H22A18 18 0 0 1 4 70V32a18 18 0 0 1 18-18z';

export function Toki({
  stage = 'kid',
  mood = 'smile',
  size = 64,
  label,
  className = '',
}: {
  stage?: TokiStage;
  mood?: 'smile' | 'happy';
  size?: number;
  /** 없으면 장식으로 취급(스크린리더에서 숨김) */
  label?: string;
  className?: string;
}) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const };
  const h = Math.round((size * 110) / 120);

  if (stage === 'egg') {
    return (
      <svg width={size} height={h} viewBox="0 0 120 110" className={className} {...a11y}>
        <ellipse cx="60" cy="58" rx="34" ry="42" fill="#edeafb" />
        <path d="M40 52l8 6 8-8 8 8 8-6" stroke="#b9b2f2" strokeWidth="3" fill="none" strokeLinejoin="round" />
        <circle cx="50" cy="72" r="3" fill="#b9b2f2" />
        <circle cx="70" cy="72" r="3" fill="#b9b2f2" />
      </svg>
    );
  }

  const body = stage === 'native' ? '#b3a8ff' : stage === 'chatty' ? '#c7beff' : '#d9d3ff';
  return (
    <svg width={size} height={h} viewBox="0 0 120 110" className={className} {...a11y}>
      <path d={BUBBLE} fill={body} />
      {stage === 'native' ? (
        <path d="M40 14l6-12 8 8 6-10 6 10 8-8 6 12z" fill="#ffd25e" />
      ) : (
        <path d="M60 14c-2-8 3-13 10-12-1 6-5 10-10 12z" fill="#7fd3ac" />
      )}
      {mood === 'happy' ? (
        <path d="M38 50q6-7 12 0M70 50q6-7 12 0" stroke="#26233a" strokeWidth="3.5" fill="none" strokeLinecap="round" />
      ) : (
        <>
          <circle cx="44" cy="50" r="5" fill="#26233a" />
          <circle cx="76" cy="50" r="5" fill="#26233a" />
        </>
      )}
      {stage !== 'sprout' && (
        <>
          <circle cx="34" cy="62" r="6" fill="#ffc2d1" />
          <circle cx="86" cy="62" r="6" fill="#ffc2d1" />
        </>
      )}
      {mood === 'happy' || stage === 'chatty' ? (
        <path d="M49 60q11 13 22 0z" fill="#26233a" />
      ) : (
        <path d="M52 62q8 8 16 0" stroke="#26233a" strokeWidth="3.5" fill="none" strokeLinecap="round" />
      )}
    </svg>
  );
}
