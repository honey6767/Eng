export function ProgressBar({
  value,
  className = '',
  tone = 'brand',
  label,
}: {
  /** 0~100 */
  value: number;
  className?: string;
  tone?: 'brand' | 'warn' | 'ok';
  label?: string;
}) {
  const color = { brand: 'bg-brand', warn: 'bg-warn', ok: 'bg-ok' }[tone];
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={v}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={`h-2.5 w-full overflow-hidden rounded-full bg-line ${className}`}
    >
      <div className={`h-full rounded-full ${color} transition-[width] duration-500`} style={{ width: `${v}%` }} />
    </div>
  );
}

/** 5단계 진행 표시 점 */
export function StepDots({ completed, current }: { completed: number; current?: number }) {
  return (
    <div className="flex items-center gap-1.5" aria-label={`5단계 중 ${completed}단계 완료`}>
      {[1, 2, 3, 4, 5].map((s) => (
        <span
          key={s}
          className={`h-2 w-6 rounded-full ${s <= completed ? 'bg-brand' : s === current ? 'bg-brand-tint' : 'bg-line'}`}
        />
      ))}
    </div>
  );
}

/** 5단계 진행 막대 (홈·상세의 큰 표시) — 끝낸 단계는 채움, 지금 단계는 연하게 */
export function StepBar({ completed, current, className = '' }: { completed: number; current?: number; className?: string }) {
  return (
    <div className={`flex items-center gap-1.5 ${className}`} role="img" aria-label={`5단계 중 ${completed}단계 완료`}>
      {[1, 2, 3, 4, 5].map((s) => (
        <span
          key={s}
          className={`h-2.5 flex-1 rounded-full ${s <= completed ? 'bg-brand' : s === current ? 'bg-brand-tint' : 'bg-line'}`}
        />
      ))}
    </div>
  );
}
