import type { HTMLAttributes, ReactNode } from 'react';

export function Card({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-2xl border border-line bg-surface ${className}`} {...rest} />;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <h2 className="text-[17px] font-bold text-ink">{children}</h2>
      {action}
    </div>
  );
}
