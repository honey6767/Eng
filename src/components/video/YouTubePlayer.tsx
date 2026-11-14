import { useState } from 'react';
import { embedUrl } from '@/utils/youtubeUrl';
import { Icon } from '@/components/ui/Icon';
import { formatTimestamp } from '@/utils/date';

export interface SeekRequest {
  sec: number;
  /** 같은 위치를 다시 눌러도 새로 이동하도록 */
  nonce: number;
}

/**
 * YouTube 공식 임베드 플레이어 (youtube-nocookie.com).
 * 처음에는 썸네일만 보여주고, 재생을 누르거나 자막 타임스탬프를 누르면 해당 위치부터 재생한다.
 */
export function YouTubePlayer({
  videoId,
  title,
  thumbnailUrl,
  seek,
  onPlay,
}: {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  seek: SeekRequest | null;
  onPlay: () => void;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  if (!seek) {
    return (
      <button
        type="button"
        onClick={onPlay}
        className="group relative block aspect-video w-full overflow-hidden rounded-xl bg-black"
        aria-label={`${title} 재생`}
      >
        {thumbnailUrl && !thumbFailed && (
          <img
            src={thumbnailUrl}
            alt=""
            onError={() => setThumbFailed(true)}
            className="h-full w-full object-cover opacity-90 transition-opacity group-hover:opacity-100"
          />
        )}
        <span className="absolute inset-0 grid place-items-center">
          <span className="grid size-14 place-items-center rounded-full bg-black/60 text-white">
            <Icon name="play" className="ml-0.5 size-6" />
          </span>
        </span>
      </button>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl bg-black">
      <iframe
        key={seek.nonce}
        src={embedUrl(videoId, seek.sec, true)}
        title={title}
        className="aspect-video w-full"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        data-testid="youtube-player"
      />
      {seek.sec > 0 && <p className="bg-ink px-3 py-1 text-xs text-white/80">{formatTimestamp(seek.sec)}부터 재생</p>}
    </div>
  );
}
