import { repos } from '@/repositories';
import { setVideoStatus } from '@/services/studyQueue';
import { useToast } from '@/hooks/useToast';
import type { Video, VideoStatus } from '@/types/models';
import { VIDEO_STATUS } from '@/utils/labels';

const ORDER: VideoStatus[] = ['new', 'in_progress', 'completed'];

export function VideoStatusControl({ video }: { video: Video }) {
  const toast = useToast();
  return (
    <div role="radiogroup" aria-label="학습 상태" className="inline-flex rounded-xl border border-line-strong bg-surface p-0.5">
      {ORDER.map((s) => {
        const active = video.status === s;
        return (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={async () => {
              if (active) return;
              await setVideoStatus(repos, video, s);
              toast(`학습 상태를 ‘${VIDEO_STATUS[s].label}’(으)로 바꿨어요`);
            }}
            className={`h-9 rounded-[10px] px-3 text-sm font-semibold transition-colors ${
              active ? 'bg-ink text-white' : 'text-muted hover:text-ink'
            }`}
          >
            {VIDEO_STATUS[s].label}
          </button>
        );
      })}
    </div>
  );
}
