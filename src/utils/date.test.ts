import { describe, expect, it } from 'vitest';
import { formatDuration, formatTimestamp } from './date';

describe('formatDuration / formatTimestamp', () => {
  it('영상 길이를 읽기 쉽게 표시', () => {
    expect(formatDuration(755)).toBe('12분 35초');
    expect(formatDuration(3723)).toBe('1시간 2분 3초');
    expect(formatDuration(3600)).toBe('1시간');
    expect(formatDuration(45)).toBe('45초');
    expect(formatDuration(600)).toBe('10분');
    expect(formatDuration(null)).toBe('길이 미확인');
  });
  it('자막 위치 표시', () => {
    expect(formatTimestamp(42)).toBe('0:42');
    expect(formatTimestamp(725.6)).toBe('12:05');
    expect(formatTimestamp(3723)).toBe('1:02:03');
  });
});
