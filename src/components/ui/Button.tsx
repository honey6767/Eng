import type { ComponentProps, ReactNode } from 'react';
import { Link } from 'react-router-dom';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-strong disabled:bg-line-strong disabled:text-subtle',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-canvas disabled:text-subtle',
  ghost: 'text-muted hover:bg-black/5 hover:text-ink disabled:text-subtle',
  danger: 'bg-danger text-white hover:brightness-95 disabled:opacity-50',
};
const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm gap-1.5',
  md: 'h-11 px-4 text-[15px] gap-2',
  lg: 'h-13 px-5 text-base gap-2',
};

export function buttonClass(variant: Variant = 'primary', size: Size = 'md', extra = '') {
  return `inline-flex items-center justify-center rounded-xl font-semibold transition-colors disabled:cursor-not-allowed select-none ${variants[variant]} ${sizes[size]} ${extra}`;
}

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...rest
}: ComponentProps<'button'> & { variant?: Variant; size?: Size }) {
  return <button type="button" className={buttonClass(variant, size, className)} {...rest} />;
}

export function LinkButton({
  to,
  variant = 'primary',
  size = 'md',
  className = '',
  children,
}: {
  to: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link to={to} className={buttonClass(variant, size, className)}>
      {children}
    </Link>
  );
}
