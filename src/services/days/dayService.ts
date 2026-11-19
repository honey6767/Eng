import type { ExtractionStore } from '@/repositories/extractionStore';
import type { DayAssignment, ExtractionDraft, Video } from '@/types/models';
import { parseDayNumber } from '@/db/upgradeV2toV3';

/**
 * B1-d — Day 정리
 *
 * - 제안: Day 기록(업그레이드 때 제목에서 만든 것 포함) → 없으면 영상 제목의 [Day N] → 없으면 AI가 찾은 Day 번호
 * - '제안 모두 확정': 번호가 다른 영상과 겹치지 않는 제안만 한 번에 확정 (영상마다 따로 확인할 필요 없음)
 * - 겹치는 번호는 '확인 필요'로 표시하고 사용자가 고른다
 * - 확정하면 dayAssignments와 그 영상의 학습 대상(learningItems, 새 테이블)만 바뀐다. 영상 레코드는 그대로.
 */

export type DayRowStatus = 'confirmed' | 'suggested' | 'conflict' | 'none';

export interface DayRow {
  video: Video;
  dayNumber: number | null;
  status: DayRowStatus;
  source: DayAssignment['source'] | 'ai_draft' | null;
  /** 같은 번호를 가진 다른 영상 */
  conflictWith: string[];
}

export function buildDayRows(videos: Video[], days: DayAssignment[], drafts: ExtractionDraft[]): DayRow[] {
  const dayByVideo = new Map(days.map((d) => [d.videoId, d]));
  const aiDay = new Map<string, number>();
  for (const d of drafts) {
    const n = (d.result as { dayNumber?: number | null } | null)?.dayNumber;
    if (typeof n === 'number' && n > 0 && d.status !== 'rejected' && d.status !== 'superseded') aiDay.set(d.videoId, n);
  }
  const rows: DayRow[] = videos
    .filter((v) => !v.isSample)
    .map((v) => {
      const a = dayByVideo.get(v.id);
      if (a) return { video: v, dayNumber: a.dayNumber, status: a.status === 'confirmed' ? 'confirmed' : 'suggested', source: a.source, conflictWith: [] };
      const t = parseDayNumber(v.title);
      if (t) return { video: v, dayNumber: t, status: 'suggested', source: 'title', conflictWith: [] };
      const n = aiDay.get(v.id);
      return n ? { video: v, dayNumber: n, status: 'suggested', source: 'ai_draft', conflictWith: [] } : { video: v, dayNumber: null, status: 'none', source: null, conflictWith: [] };
    });
  const byNumber = new Map<number, DayRow[]>();
  for (const r of rows) if (r.dayNumber) byNumber.set(r.dayNumber, [...(byNumber.get(r.dayNumber) ?? []), r]);
  for (const group of byNumber.values()) {
    if (group.length < 2) continue;
    for (const r of group) {
      r.conflictWith = group.filter((x) => x !== r).map((x) => x.video.id);
      if (r.status === 'suggested') r.status = 'conflict';
    }
  }
  return rows.sort((a, b) => (a.dayNumber ?? 9999) - (b.dayNumber ?? 9999) || a.video.orderIndex - b.video.orderIndex);
}

export async function loadDayRows(store: ExtractionStore): Promise<DayRow[]> {
  const { videos, days, drafts } = await store.readDays();
  return buildDayRows(videos, days, drafts);
}

/** 겹치지 않는 제안을 모두 확정 — 확정한 수 */
export async function confirmAllSuggestions(store: ExtractionStore, now = new Date()): Promise<number> {
  const rows = await loadDayRows(store);
  const updates = rows.filter((r) => r.status === 'suggested' && r.dayNumber).map((r) => ({ videoId: r.video.id, dayNumber: r.dayNumber! }));
  return updates.length ? store.setDays(updates, now.toISOString()) : 0;
}

/** 한 영상의 Day를 정하거나 바꾼다 (1~999) */
export async function setVideoDay(store: ExtractionStore, videoId: string, dayNumber: number, now = new Date()): Promise<boolean> {
  if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 999) return false;
  return (await store.setDays([{ videoId, dayNumber }], now.toISOString())) === 1;
}
