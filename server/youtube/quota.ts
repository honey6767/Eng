import type { YtQuota } from '../../src/types/youtubeApi.ts';

/** YouTube Data API 기본 무료 할당량 (하루, 태평양 시간 자정 초기화) */
export const DEFAULT_DAILY_LIMIT = 10_000;
/** 이 앱의 자체 상한 — 무료 할당량보다 낮게 두어 여유를 남긴다 */
export const DEFAULT_LOCAL_CAP = 9_000;

/** 호출별 할당량 비용 (YouTube Data API 문서 기준) */
export const UNIT_COST = {
  'playlists.list': 1,
  'playlistItems.list': 1,
  'videos.list': 1,
  'captions.list': 50,
} as const;

export interface QuotaState {
  date: string;
  used: number;
  exhausted: boolean;
}

export interface QuotaStore {
  load(): QuotaState | null;
  save(state: QuotaState): void;
}

export const memoryQuotaStore = (): QuotaStore => {
  let state: QuotaState | null = null;
  return { load: () => state, save: (s) => void (state = s) };
};

export function pacificDate(now: Date): string {
  // en-CA 형식은 YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now);
}

/**
 * 할당량 추적기.
 * Google이 실제 할당량을 강제하며(초과 시 403, 과금 없음), 이 추적기는 그보다 먼저
 * 자체 상한에서 호출을 멈추기 위한 안전장치다.
 */
export class QuotaTracker {
  constructor(
    private store: QuotaStore,
    private cap = DEFAULT_LOCAL_CAP,
    private now: () => Date = () => new Date(),
  ) {}

  private current(): QuotaState {
    const date = pacificDate(this.now());
    const saved = this.store.load();
    if (!saved || saved.date !== date) return { date, used: 0, exhausted: false };
    return saved;
  }

  snapshot(): YtQuota {
    const s = this.current();
    return { used: s.used, cap: this.cap, dailyLimit: DEFAULT_DAILY_LIMIT, date: s.date, exhausted: s.exhausted };
  }

  canSpend(units: number): boolean {
    const s = this.current();
    return !s.exhausted && s.used + units <= this.cap;
  }

  spend(units: number): void {
    const s = this.current();
    this.store.save({ ...s, used: s.used + units });
  }

  /** Google이 quotaExceeded를 응답하면 오늘은 더 이상 호출하지 않는다 */
  markExhausted(): void {
    const s = this.current();
    this.store.save({ ...s, exhausted: true });
  }
}
