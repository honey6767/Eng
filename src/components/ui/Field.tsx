import type { ComponentProps, ReactNode } from 'react';

const base = 'w-full rounded-xl border border-line-strong bg-surface px-3 text-[15px] outline-none focus:border-brand disabled:bg-canvas disabled:text-subtle';

/** 라벨 + 입력칸 묶음 */
export function Field({ label, hint, children, className = '' }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-sm font-semibold text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-subtle">{hint}</span>}
    </label>
  );
}

export function TextInput({ className = '', ...rest }: ComponentProps<'input'>) {
  return <input type="text" className={`${base} h-11 ${className}`} {...rest} />;
}

export function TextArea({ className = '', ...rest }: ComponentProps<'textarea'>) {
  return <textarea className={`${base} py-2.5 leading-relaxed ${className}`} {...rest} />;
}
