export function Loading({ label = '불러오는 중…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted" role="status">
      <span className="size-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      {label}
    </div>
  );
}
