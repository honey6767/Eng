import type { BadgeTone } from '@/components/ui/Badge';
import type { ContentOrigin, LearningStatus, TranscriptStatus, VideoStatus } from '@/types/models';

export const VIDEO_STATUS: Record<VideoStatus, { label: string; tone: BadgeTone }> = {
  new: { label: '신규', tone: 'info' },
  in_progress: { label: '학습 중', tone: 'warn' },
  completed: { label: '학습 완료', tone: 'ok' },
};

export const TRANSCRIPT_STATUS: Record<TranscriptStatus | 'none', { label: string; tone: BadgeTone }> = {
  none: { label: '자막 없음', tone: 'neutral' },
  not_attempted: { label: '자막 미시도', tone: 'neutral' },
  success: { label: '자막 있음', tone: 'ok' },
  failed: { label: '자막 가져오기 실패', tone: 'danger' },
};

export const LEARNING_STATUS: Record<LearningStatus, { label: string; tone: BadgeTone }> = {
  not_started: { label: '시작 전', tone: 'neutral' },
  learning: { label: '학습 중', tone: 'warn' },
  reviewing: { label: '복습 중', tone: 'info' },
  memorized: { label: '암기 완료', tone: 'ok' },
};

export const ORIGIN: Record<ContentOrigin, { label: string; tone: BadgeTone }> = {
  video: { label: '영상 설명', tone: 'brand' },
  ai_supplement: { label: 'AI 보충', tone: 'info' },
  user: { label: '직접 입력', tone: 'neutral' },
};

export const STEP_NAMES: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: '전체 대화문 보기',
  2: '핵심 Chunk 빈칸',
  3: '주요 단어 빈칸',
  4: '대부분 빈칸',
  5: '보지 않고 말하기',
};

export function weaknessTone(w: number): BadgeTone {
  if (w >= 70) return 'danger';
  if (w >= 50) return 'warn';
  if (w >= 30) return 'neutral';
  return 'ok';
}
