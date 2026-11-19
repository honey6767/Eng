import type { ComponentProps, ReactNode } from 'react';
import { Link } from 'react-router-dom';

type Variant = 'primary' | 'secondary' | 'soft' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg' | 'xl';

/** 디자인 시스템 버튼 — 주 버튼은 살짝 떠 있는 입체감(눌리면 내려앉음) */
const variants: Record<Variant, string> = {
  primary:
    'bg-brand text-white shadow-[0_4px_0_var(--color-brand-strong)] hover:bg-brand-strong active:translate-y-[2px] active:shadow-[0_2px_0_var(--color-brand-strong)] disabled:bg-line-strong disabled:text-subtle disabled:shadow-none disabled:translate-y-0',
  secondary: 'bg-surface text-ink border-[1.5px] border-line-strong hover:bg-canvas disabled:text-subtle',
  soft: 'bg-brand-soft text-brand-strong hover:bg-brand-tint/60 disabled:text-subtle',
  ghost: 'text-muted hover:bg-brand-soft/70 hover:text-ink disabled:text-subtle',
  danger: 'bg-danger text-white hover:brightness-95 disabled:opacity-50',
};
const sizes: Record<Size, string> = {
  sm: 'h-10 px-3.5 text-sm gap-1.5 rounded-xl font-semibold',
  md: 'h-12 px-5 text-[15px] gap-2 rounded-2xl font-bold',
  lg: 'h-14 px-6 text-[17px] gap-2 rounded-[20px] font-extrabold',
  xl: 'h-16 px-7 text-lg gap-2.5 rounded-[22px] font-extrabold',
};

export function buttonClass(variant: Variant = 'primary', size: Size = 'md', extra = '') {
  return `inline-flex items-center justify-center transition-[background-color,transform,box-shadow] disabled:cursor-not-allowed select-none ${variants[variant]} ${sizes[size]} ${extra}`;
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
  'data-testid': testId,
}: {
  to: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
  'data-testid'?: string;
}) {
  return (
    <Link to={to} className={buttonClass(variant, size, className)} data-testid={testId}>
      {children}
    </Link>
  );
}
