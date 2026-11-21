import { describe, expect, it } from 'vitest';
import type { KeySentence } from '@/types/models';
import { daySentenceProblem, daySeriesOf, userSentencesOf } from './daySeries';
import { seriesOf } from '@/services/content/contentService';

const T = '2026-11-16T12:00:00.000Z';
const ks = (id: string, order: number, english: string, origin?: KeySentence['origin'], createdAt = T): KeySentence => ({
  id, createdAt, updatedAt: createdAt, videoId: 'v', order, english, korean: '', expressionIds: [], situation: '', timestampSec: null, status: 'not_started', correctCount: 0, wrongCount: 0, ...(origin ? { origin } : {}),
});

describe('Day 1~100 판별', () => {
  it.each([
    ['[Day 1] 시작', true, 1],
    ['[Day 100] 끝', true, 100],
    ['[Day 007] 앞자리 0', true, 7],
    ['[ day 42 ] 공백·소문자', true, 42],
    ['[Day 101] 범위 밖', false, null],
    ['[Day 0] 0번', false, null],
    ['[Day 1000] 네 자리', false, null],
    ['Day 5 괄호 없음', false, null],
    ['[Day 3.5] 소수', false, null],
    ['Birthday 5', false, null],
    ['[Day] 번호 없음', false, null],
    ['How to small talk', false, null],
  ])('제목 %s → Day=%s', (title, isDay, n) => {
    expect(daySeriesOf({ title }, undefined)).toEqual({ isDay, dayNumber: n });
  });

  it('확정 번호가 제목보다 우선, 제안 번호는 무시', () => {
    expect(daySeriesOf({ title: '[Day 12] x' }, { dayNumber: 30, status: 'confirmed' })).toEqual({ isDay: true, dayNumber: 30 });
    // 확정 번호가 범위 밖이면 일반 (제목이 Day 12여도 확정이 우선)
    expect(daySeriesOf({ title: '[Day 12] x' }, { dayNumber: 150, status: 'confirmed' })).toEqual({ isDay: false, dayNumber: null });
    // 제목 없이 확정만
    expect(daySeriesOf({ title: '그냥 영상' }, { dayNumber: 9, status: 'confirmed' })).toEqual({ isDay: true, dayNumber: 9 });
    // 제안만 된 번호는 쓰지 않는다
    expect(daySeriesOf({ title: '그냥 영상' }, { dayNumber: 9, status: 'suggested' })).toEqual({ isDay: false, dayNumber: null });
    expect(daySeriesOf({ title: '[Day 12] x' }, { dayNumber: 30, status: 'suggested' })).toEqual({ isDay: true, dayNumber: 12 });
  });

  it('seriesOf(요청에 들어가는 구분)도 같은 기준', () => {
    const v = (title: string) => ({ title }) as never;
    expect(seriesOf(v('[Day 11] a'), undefined)).toEqual({ seriesKind: 'day', dayNumber: 11 });
    expect(seriesOf(v('[Day 111] a'), undefined)).toEqual({ seriesKind: 'general', dayNumber: null });
    expect(seriesOf(v('x'), { dayNumber: 5, status: 'confirmed' } as never)).toEqual({ seriesKind: 'day', dayNumber: 5 });
  });
});

describe('Day 자료 재료 문장', () => {
  it('직접 입력·자막에서 고른 문장만, 사용자가 정한 순서대로 (AI 추출 문장 제외)', () => {
    const list = [ks('ai1', 1, 'AI one', 'ai_extracted'), ks('m2', 2, 'Manual two', 'manual'), ks('t1', 1, 'Picked one', 'transcript'), ks('old', 3, 'Old without origin')];
    expect(userSentencesOf(list).map((s) => s.id)).toEqual(['t1', 'm2', 'old']);
  });

  it('1~20개, 빈 문장·500자 초과는 보내지 않음 (자르지 않음)', () => {
    expect(daySentenceProblem([])).toContain('1개 이상');
    expect(daySentenceProblem([ks('a', 1, 'Hello there.')])).toBeNull();
    expect(daySentenceProblem(Array.from({ length: 20 }, (_, i) => ks(`s${i}`, i + 1, `Sentence ${i}.`)))).toBeNull();
    expect(daySentenceProblem(Array.from({ length: 21 }, (_, i) => ks(`s${i}`, i + 1, `Sentence ${i}.`)))).toContain('20개');
    expect(daySentenceProblem([ks('a', 1, '   ')])).toContain('비어');
    expect(daySentenceProblem([ks('a', 1, 'a'.repeat(500))])).toBeNull();
    expect(daySentenceProblem([ks('a', 1, 'a'.repeat(501))])).toContain('500자');
    // 조용히 빼지 않는다: 어느 문장인지(번호·앞부분·길이) 알려 주고 요청 전체를 막는다
    const long = daySentenceProblem([ks('a', 1, 'Short one.'), ks('b', 2, `Long ${'x'.repeat(600)}`)])!;
    expect(long).toContain('2번');
    expect(long).toContain('“Long x');
    expect(long).toContain('605자');
    expect(long).not.toContain('1번');
    expect(daySentenceProblem([ks('a', 1, 'Ok.'), ks('b', 2, ' ')])).toContain('2번');
  });
});
