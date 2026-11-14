import type { ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * 아직 구현되지 않은 기능 표시.
 * 작동하지 않는 버튼 대신 이 컴포넌트를 사용해 '미구현/연동 대기' 상태를 명확히 보여준다.
 */
export function PlannedNotice({ stage, title, children }: { stage: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-xl border border-dashed border-line-strong bg-canvas/60 p-3.5">
      <Icon name="lock" className="mt-0.5 size-4.5 shrink-0 text-subtle" />
      <div className="min-w-0 text-sm">
        <p className="font-semibold text-muted">
          {title} <span className="ml-1 font-medium text-subtle">· {stage} 예정</span>
        </p>
        {children && <div className="mt-1 text-subtle">{children}</div>}
      </div>
    </div>
  );
}

/** 비활성 버튼 + 예정 단계 라벨 (클릭해도 아무 일도 일어나지 않음이 명확) */
export function PlannedButton({ label, stage, className = '' }: { label: string; stage: string; className?: string }) {
  return (
    <button
      type="button"
      disabled
      title={`${stage} 예정 기능`}
      className={`inline-flex h-11 cursor-not-allowed items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong px-4 text-[15px] font-semibold text-subtle ${className}`}
    >
      <Icon name="lock" className="size-4" />
      {label}
      <span className="text-xs font-medium">({stage} 예정)</span>
    </button>
  );
}
