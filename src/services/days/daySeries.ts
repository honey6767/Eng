import { parseDayNumber } from '@/db/upgradeV2toV3';
import type { DayAssignment, KeySentence, Video } from '@/types/models';

/**
 * Day 1~100 시리즈 판별 — 한 곳에서만 정한다 (저장하지 않고 매번 계산, DB 변경 없음)
 *
 * 1. Day 정리에서 확정(confirmed)한 번호가 있으면 그 번호 (제목과 달라도 확정 번호가 우선, 제안만 된 번호는 쓰지 않음)
 * 2. 없으면 제목의 [Day N]
 * 3. 1~100이면 Day 영상, 그 밖(0, 101 이상, 형식 불일치)은 일반 영상
 *
 * Day 영상은 자동 AI 처리(자막 추출·AI 자막·자료 생성)를 하지 않는다.
 * 사용자가 직접 입력하거나 자막에서 고른 핵심 문장으로 'Day 자료 만들기'를 눌렀을 때만 요청한다.
 */

export const DAY_SERIES_MIN = 1;
export const DAY_SERIES_MAX = 100;
/** Day 자료 재료 문장 개수 (서버 한도와 같음) */
export const DAY_SENTENCE_MIN = 1;
export const DAY_SENTENCE_MAX = 20;
/** 문장 1개 최대 길이 (서버 한도) — 넘으면 자르지 않고 거절 (원문 보존) */
export const DAY_SENTENCE_CHARS = 500;

export interface DaySeries {
  isDay: boolean;
  dayNumber: number | null;
}

export function daySeriesOf(video: Pick<Video, 'title'>, day: Pick<DayAssignment, 'dayNumber' | 'status'> | undefined | null): DaySeries {
  const n = day && day.status === 'confirmed' ? day.dayNumber : parseDayNumber(video.title);
  return typeof n === 'number' && Number.isInteger(n) && n >= DAY_SERIES_MIN && n <= DAY_SERIES_MAX ? { isDay: true, dayNumber: n } : { isDay: false, dayNumber: null };
}

/** Day 자료 재료: 사용자가 직접 입력하거나 자막에서 고른 문장 (AI가 뽑은 문장은 제외), 사용자가 정한 순서대로 */
export function userSentencesOf(sentences: KeySentence[]): KeySentence[] {
  return sentences.filter((s) => s.origin !== 'ai_extracted').sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}

/**
 * Day 자료를 만들 수 있는지 (문장 개수·길이) — 안 되면 이유.
 * 문제가 있으면 문장 일부만 빼고 보내지 않는다: 요청 전체를 보내지 않고, 어느 문장(사용자 순서 번호)이 문제인지 알려 준다.
 * sentences는 userSentencesOf 순서(= 화면·요청의 번호 순서)로 넘긴다.
 */
export function daySentenceProblem(sentences: KeySentence[]): string | null {
  if (sentences.length < DAY_SENTENCE_MIN) return '핵심 문장을 1개 이상 입력해 주세요.';
  if (sentences.length > DAY_SENTENCE_MAX) return `핵심 문장은 ${DAY_SENTENCE_MAX}개까지 쓸 수 있어요 (지금 ${sentences.length}개). 문장을 줄인 뒤 다시 만들어 주세요.`;
  const preview = (t: string) => `“${t.trim().slice(0, 30)}${t.trim().length > 30 ? '…' : ''}”`;
  // 번호는 핵심 문장 카드에 보이는 번호(order)
  const empty = sentences.flatMap((s) => (s.english.trim() ? [] : [`${s.order}번`]));
  if (empty.length) return `영어 문장이 비어 있는 핵심 문장이 있어요 (${empty.join(', ')}). 이 문장을 ‘Day 자료에서 빼기’ 하면 나머지 문장으로 만들 수 있어요.`;
  const long = sentences.flatMap((s) => (s.english.length > DAY_SENTENCE_CHARS ? [`${s.order}번 ${preview(s.english)} ${s.english.length}자`] : []));
  if (long.length)
    return `${DAY_SENTENCE_CHARS}자가 넘는 핵심 문장이 있어 Day 자료를 만들지 않았어요: ${long.join(' · ')}. 원문은 자르지 않아요 — 이 문장을 ‘Day 자료에서 빼기’ 하면 나머지 문장으로 만들 수 있어요 (문장·학습 기록은 그대로).`;
  return null;
}

// ─────────────────────────────────────────────
// Day 자료에서 뺀 문장 (appMeta 'dayExclusions' — 문장·학습 기록은 건드리지 않고 이 기록만 바꾼다)
// ─────────────────────────────────────────────

/** appMeta 키. 값: { [영상 id]: [뺀 문장 id, …] } — 없으면 뺀 문장 없음 */
export const DAY_EXCLUSIONS_META_KEY = 'dayExclusions';
export type DayExclusions = Record<string, string[]>;

/** 저장된 값을 읽기 (형식이 다르거나 없으면 빈 값 — 기존 데이터는 '뺀 문장 없음') */
export function parseDayExclusions(value: unknown): DayExclusions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: DayExclusions = {};
  for (const [videoId, ids] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(ids)) out[videoId] = [...new Set(ids.filter((x): x is string => typeof x === 'string'))];
  }
  return out;
}

export const excludedSetOf = (all: DayExclusions, videoId: string): Set<string> => new Set(all[videoId] ?? []);

/** Day 자료에 실제로 쓰는 문장: 사용자 문장(직접 입력·자막에서 고름) 중 빼지 않은 것, 사용자 순서대로 */
export function includedDaySentences(sentences: KeySentence[], excluded: ReadonlySet<string>): KeySentence[] {
  return userSentencesOf(sentences).filter((s) => !excluded.has(s.id));
}

/** Day 자료에서 뺀 사용자 문장 (사용자 순서). 지워진 문장의 id는 무시 */
export function excludedDaySentences(sentences: KeySentence[], excluded: ReadonlySet<string>): KeySentence[] {
  return userSentencesOf(sentences).filter((s) => excluded.has(s.id));
}
