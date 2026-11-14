import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export function EmptyState({ icon = 'book', title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <div className="mb-3 grid size-12 place-items-center rounded-2xl bg-canvas text-subtle">
        <Icon name={icon} className="size-6" />
      </div>
      <p className="font-semibold text-ink">{title}</p>
      {children && <div className="mt-1 max-w-sm text-sm text-muted">{children}</div>}
    </div>
  );
}
