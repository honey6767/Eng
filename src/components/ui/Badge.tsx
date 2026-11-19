import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger' | 'info' | 'key' | 'peach' | 'butter';

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-canvas text-muted border-line',
  brand: 'bg-brand-soft text-brand border-transparent',
  ok: 'bg-ok-soft text-ok border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  info: 'bg-info-soft text-info border-transparent',
  key: 'bg-key text-key-ink border-transparent',
  peach: 'bg-peach text-peach-ink border-transparent',
  butter: 'bg-butter text-butter-ink border-transparent',
};

export function Badge({ tone = 'neutral', children, className = '' }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-bold whitespace-nowrap ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
