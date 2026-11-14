import { describe, expect, it } from 'vitest';
import type { Video } from '@/types/models';
import { reconcileQueue, skipVideo, markVisited, viewQueue, eligibleVideos } from './studyQueue';

const mk = (id: string, status: Video['status'] = 'new', isSample = false): Video => ({
  id,
  status,
  isSample: isSample || undefined,
  createdAt: '',
  updatedAt: '',
  playlistId: null,
  youtubeVideoId: id,
  title: id,
  url: null,
  thumbnailUrl: null,
  durationSec: null,
  orderIndex: 0,
  randomOrderKey: 0,
  completedAt: null,
  sources: [],
  channelTitle: null,
  metadataSource: 'youtube_api',
  captionCheck: null,
});

// 결정적 난수 (테스트 재현용)
function seeded(seed = 1) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

describe('studyQueue', () => {
  it('처음에는 대상 영상을 모두 무작위로 섞고, 완료 영상은 제외한다', () => {
    const videos = [mk('a'), mk('b'), mk('c', 'completed'), mk('d', 'in_progress')];
    const q = reconcileQueue(undefined, videos, seeded());
    expect([...q.order].sort()).toEqual(['a', 'b', 'd']);
    expect(q.cycle).toBe(1);
  });

  it('변경이 없으면 같은 상태를 유지한다 (새로고침해도 순서 유지)', () => {
    const videos = [mk('a'), mk('b'), mk('c')];
    const q = reconcileQueue(undefined, videos, seeded());
    expect(reconcileQueue(q, videos, seeded(99))).toBe(q);
  });

  it('새 영상은 현재 추천 영상 뒤쪽에 끼워 넣고 기존 순서는 유지한다', () => {
    const videos = [mk('a'), mk('b'), mk('c')];
    const q = reconcileQueue(undefined, videos, seeded());
    const current = viewQueue(q, videos).current!.id;
    const q2 = reconcileQueue(q, [...videos, mk('x'), mk('y')], seeded(5));
    expect(viewQueue(q2, [...videos, mk('x'), mk('y')]).current!.id).toBe(current);
    expect(q2.order.filter((id) => !['x', 'y'].includes(id))).toEqual(q.order);
    expect(q2.order).toHaveLength(5);
  });

  it('한 번씩 모두 학습하면 다시 섞는다 (회차 증가), 완료 영상은 빠진다', () => {
    let videos = [mk('a'), mk('b'), mk('c')];
    let q = reconcileQueue(undefined, videos, seeded());
    for (const id of [...q.order]) {
      q = markVisited(q, id);
    }
    videos = [mk('a', 'completed'), mk('b', 'in_progress'), mk('c', 'in_progress')];
    q = reconcileQueue(q, videos, seeded(3));
    expect(q.cycle).toBe(2);
    expect([...q.order].sort()).toEqual(['b', 'c']);
    expect(q.visited).toEqual([]);
  });

  it('모든 영상이 완료되면 대상 없음', () => {
    const videos = [mk('a', 'completed')];
    const q = reconcileQueue(undefined, videos, seeded());
    expect(viewQueue(q, videos).allDone).toBe(true);
    expect(viewQueue({ ...q, includeCompleted: true }, videos).allDone).toBe(false);
  });

  it('건너뛰기는 맨 뒤로 보낸다', () => {
    const q = { version: 1 as const, cycle: 1, order: ['a', 'b', 'c'], visited: [], includeCompleted: false, shuffledAt: '' };
    expect(skipVideo(q, 'a').order).toEqual(['b', 'c', 'a']);
  });

  it('실제 영상이 있으면 샘플 영상은 제외', () => {
    expect(eligibleVideos([mk('s', 'new', true), mk('r')], false).map((v) => v.id)).toEqual(['r']);
    expect(eligibleVideos([mk('s', 'new', true)], false).map((v) => v.id)).toEqual(['s']);
  });
});
