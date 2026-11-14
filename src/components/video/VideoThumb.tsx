import { Icon } from '@/components/ui/Icon';

const palettes = ['#2f5d50', '#3b5f9a', '#8a5a2b', '#5b4a8a', '#2d6f73'];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function VideoThumb({ title, thumbnailUrl, className = '' }: { title: string; thumbnailUrl: string | null; className?: string }) {
  if (thumbnailUrl) {
    return <img src={thumbnailUrl} alt="" loading="lazy" className={`aspect-video rounded-xl bg-canvas object-cover ${className}`} />;
  }
  const color = palettes[hash(title) % palettes.length];
  return (
    <div
      className={`grid aspect-video place-items-center rounded-xl text-white/90 ${className}`}
      style={{ background: `linear-gradient(135deg, ${color}, ${color}cc)` }}
      aria-hidden="true"
    >
      <Icon name="play" className="size-6 opacity-80" />
    </div>
  );
}
