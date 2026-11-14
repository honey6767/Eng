import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/ui/Icon';

export function PageHeader({
  title,
  description,
  back,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  back?: { to: string; label: string };
  action?: ReactNode;
}) {
  return (
    <div className="mb-6">
      {back && (
        <Link to={back.to} className="mb-2 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-ink">
          <Icon name="chevronLeft" className="size-4" />
          {back.label}
        </Link>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] leading-snug font-extrabold tracking-tight text-ink sm:text-2xl">{title}</h1>
          {description && <p className="mt-1 text-[15px] text-muted">{description}</p>}
        </div>
        {action}
      </div>
    </div>
  );
}
