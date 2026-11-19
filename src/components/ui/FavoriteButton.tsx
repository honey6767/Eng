import { Icon } from './Icon';

export function FavoriteButton({
  active,
  onToggle,
  label,
  className = '',
}: {
  active: boolean;
  onToggle: () => void;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      aria-pressed={active}
      aria-label={active ? `${label} 즐겨찾기 해제` : `${label} 즐겨찾기`}
      title={active ? '즐겨찾기 해제' : '즐겨찾기'}
      className={`grid size-9 shrink-0 place-items-center rounded-full transition-colors hover:bg-black/5 ${
        active ? 'text-[#e0a92a]' : 'text-subtle'
      } ${className}`}
    >
      <Icon name="star" className="size-5" fill={active ? 'currentColor' : 'none'} />
    </button>
  );
}
