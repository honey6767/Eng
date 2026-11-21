import type { Repositories } from '@/repositories/types';
import type { Expression, ExpressionSpan, KeySentence, KeySentenceOrigin } from '@/types/models';
import { createId } from '@/utils/id';
import { nowISO } from '@/utils/date';
import { normalizeExpressionKey } from '@/utils/text';
import { findExpressionSpan, type TextSpan } from '@/utils/expressionSpan';
import { DAY_EXCLUSIONS_META_KEY, DAY_SENTENCE_CHARS, DAY_SENTENCE_MAX, excludedSetOf, includedDaySentences, parseDayExclusions, userSentencesOf } from '@/services/days/daySeries';

/**
 * 3단계 — 핵심 문장 5개 관리
 *
 * 원칙
 * - 영상에서 선정한 영어 문장은 원문 그대로 저장하고, 저장 후에는 바꾸지 않는다.
 * - 영상당 정확히 5개까지만 선정한다.
 * - 학습 이력이 있거나 대화문에서 쓰인 문장은 선정 취소(삭제)할 수 없다.
 * - 표현 레코드는 지우지 않는다 (즐겨찾기·어려움 표시·복습 기록 보존).
 */
export const KEY_SENTENCE_COUNT = 5;

export type KeySentenceErrorCode = 'video_not_found' | 'empty' | 'limit' | 'duplicate' | 'not_found' | 'locked' | 'bad_span';

export class KeySentenceError extends Error {
  constructor(
    public code: KeySentenceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface AddKeySentenceInput {
  english: string;
  korean?: string;
  situation?: string;
  timestampSec?: number | null;
  origin: KeySentenceOrigin;
}

/** 공백(줄바꿈·연속 공백)만 정리하고 글자는 그대로 둔다 */
export const cleanOriginal = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * opts.day: Day 1~100 영상 — Day 자료 재료 문장으로 최대 20개.
 * 개수·중복·번호는 사용자가 넣은 문장(직접 입력·자막에서 고름)끼리만 본다 (예전 AI 추출 문장은 Day 재료가 아니므로 세지 않음).
 * 영어 원문은 자르지 않는다 — 500자가 넘으면 저장하지 않는다.
 */
export async function addKeySentence(repos: Repositories, videoId: string, input: AddKeySentenceInput, opts: { day?: boolean } = {}): Promise<KeySentence> {
  const video = await repos.videos.get(videoId);
  if (!video) throw new KeySentenceError('video_not_found', '영상을 찾을 수 없습니다.');
  const english = cleanOriginal(input.english);
  if (!english) throw new KeySentenceError('empty', '영어 문장을 입력해 주세요.');
  if (opts.day && english.length > DAY_SENTENCE_CHARS) throw new KeySentenceError('limit', `Day 자료 문장은 ${DAY_SENTENCE_CHARS}자까지예요 (지금 ${english.length}자). 원문을 자르지 않으려고 저장하지 않았어요.`);

  const all = await repos.keySentences.listByVideo(videoId);
  const key = normalizeExpressionKey(english);
  let order: number;
  if (opts.day) {
    // Day: 개수는 Day 자료에 실제로 쓰는 문장(뺀 문장 제외)만 20개까지. 뺀 문장은 개수 제한 없이 그대로 둔다
    const mine = userSentencesOf(all);
    const excluded = excludedSetOf(parseDayExclusions(await repos.meta.get(DAY_EXCLUSIONS_META_KEY)), videoId);
    const dup = mine.find((s) => normalizeExpressionKey(s.english) === key);
    if (dup) throw new KeySentenceError('duplicate', excluded.has(dup.id) ? '이미 있는 문장이에요 (Day 자료에서 뺀 상태). 그 문장의 ‘Day 자료에 다시 넣기’를 눌러 주세요.' : '이미 핵심 문장으로 선정한 문장입니다.');
    // 개수: Day 자료에 실제로 쓰는 문장(영상 원문 후보 포함, 뺀 문장·중복 제외)
    if (includedDaySentences(all, excluded).length >= DAY_SENTENCE_MAX) {
      throw new KeySentenceError('limit', `Day 자료에 쓰는 핵심 문장은 ${DAY_SENTENCE_MAX}개까지예요 (영상 원문 후보 포함). 문장을 ‘Day 자료에서 빼기’ 하면 더 넣을 수 있어요.`);
    }
    const used = new Set(mine.map((s) => s.order));
    order = 1;
    while (used.has(order)) order++;
  } else {
    if (all.length >= KEY_SENTENCE_COUNT) {
      throw new KeySentenceError('limit', `핵심 문장은 영상당 ${KEY_SENTENCE_COUNT}개까지 선정할 수 있습니다.`);
    }
    if (all.some((s) => normalizeExpressionKey(s.english) === key)) {
      throw new KeySentenceError('duplicate', '이미 핵심 문장으로 선정한 문장입니다.');
    }
    const used = new Set(all.map((s) => s.order));
    order = [1, 2, 3, 4, 5].find((n) => !used.has(n)) ?? all.length + 1;
  }

  const now = nowISO();
  const sentence: KeySentence = {
    id: createId(),
    createdAt: now,
    updatedAt: now,
    videoId,
    order,
    english,
    korean: (input.korean ?? '').trim(),
    expressionIds: [],
    expressionSpans: [],
    situation: (input.situation ?? '').trim(),
    timestampSec: input.timestampSec ?? null,
    status: 'not_started',
    correctCount: 0,
    wrongCount: 0,
    origin: input.origin,
    // 샘플 영상에 추가한 문장은 샘플 삭제 시 함께 정리
    ...(video.isSample ? { isSample: true } : {}),
  };
  await repos.keySentences.add(sentence);
  return sentence;
}

/** 번역·상황·시간만 수정 (영어 원문은 수정 불가) */
export async function updateKeySentenceDetails(
  repos: Repositories,
  id: string,
  patch: { korean?: string; situation?: string; timestampSec?: number | null },
): Promise<void> {
  const s = await repos.keySentences.get(id);
  if (!s) throw new KeySentenceError('not_found', '핵심 문장을 찾을 수 없습니다.');
  await repos.keySentences.update(id, {
    ...(patch.korean !== undefined ? { korean: patch.korean.trim() } : {}),
    ...(patch.situation !== undefined ? { situation: patch.situation.trim() } : {}),
    ...(patch.timestampSec !== undefined ? { timestampSec: patch.timestampSec } : {}),
  });
}

/**
 * Day 영상의 선정 취소 보호 — Day 자료가 실제로 참조하는 문장만 (참조가 끊기면 Chunk 활용 사례·대화 원문 출처가 사라진 문장을 가리키게 됨)
 * - day: Day 1~100 영상 화면에서 부를 때만 true (일반 영상은 예전 규칙 그대로)
 * - linkedIds: 이 영상의 학습 대상(Chunk)이 연결한 문장 id (sentenceId·활용 사례) — 화면이 넘겨준다
 */
export interface RemovalOptions {
  day?: boolean;
  linkedIds?: ReadonlySet<string>;
}

/** 선정 취소가 불가능한 이유 (가능하면 null) */
export async function getRemovalBlocker(repos: Repositories, sentence: KeySentence, opts: RemovalOptions = {}): Promise<string | null> {
  const dialogues = await repos.dialogues.listByVideo(sentence.videoId);
  if (dialogues.some((d) => d.lines.some((l) => l.segments.some((seg) => seg.keySentenceId === sentence.id)))) {
    return '대화문에서 사용 중인 문장이라 선정을 취소할 수 없습니다.';
  }
  if (opts.day && dialogues.some((d) => d.lines.some((l) => l.sourceSentenceId === sentence.id))) {
    return 'Day 대화문의 원문 출처로 연결된 문장이라 선정을 취소할 수 없습니다.';
  }
  if (opts.day && opts.linkedIds?.has(sentence.id)) {
    return 'Day 자료의 Chunk(활용 사례)와 연결된 문장이라 선정을 취소할 수 없습니다.';
  }
  if (sentence.correctCount > 0 || sentence.wrongCount > 0 || sentence.status !== 'not_started') {
    return '학습 기록이 있는 문장이라 선정을 취소할 수 없습니다.';
  }
  if (await repos.reviewStates.get('sentence', sentence.id)) {
    return '복습 기록이 있는 문장이라 선정을 취소할 수 없습니다.';
  }
  return null;
}

/**
 * 잘못 고른 문장의 선정 취소. 학습·복습 기록이나 대화문 사용이 있으면 거부한다.
 * 연결된 표현 레코드는 지우지 않고 이 문장 출처만 뺀다.
 */
export async function removeKeySentence(repos: Repositories, id: string, opts: RemovalOptions = {}): Promise<void> {
  const s = await repos.keySentences.get(id);
  if (!s) throw new KeySentenceError('not_found', '핵심 문장을 찾을 수 없습니다.');
  const blocker = await getRemovalBlocker(repos, s, opts);
  if (blocker) throw new KeySentenceError('locked', blocker);
  for (const exprId of s.expressionIds) {
    await repos.expressions.removeSourceRef(exprId, { videoId: s.videoId, sentenceId: s.id });
  }
  await repos.keySentences.remove(id);
}

function validSpan(english: string, span: TextSpan): boolean {
  return Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0 && span.end <= english.length && span.start < span.end;
}

/**
 * 핵심 문장에 핵심 표현을 연결한다.
 * 같은 표현이 이미 있으면 새로 만들지 않고 출처만 누적한다 (기존 즐겨찾기·어려움 표시 유지).
 * span을 주지 않으면 문장에서 자동으로 위치를 찾는다. 못 찾으면 spanFound=false.
 */
export async function linkExpression(
  repos: Repositories,
  sentenceId: string,
  input: { text: string; meaningKo: string; span?: TextSpan },
): Promise<{ expression: Expression; spanFound: boolean }> {
  const s = await repos.keySentences.get(sentenceId);
  if (!s) throw new KeySentenceError('not_found', '핵심 문장을 찾을 수 없습니다.');
  const text = input.text.trim();
  if (!text) throw new KeySentenceError('empty', '표현을 입력해 주세요.');
  if (input.span && !validSpan(s.english, input.span)) throw new KeySentenceError('bad_span', '표현 위치가 문장 범위를 벗어났습니다.');

  const expression = await repos.expressions.upsert({
    text,
    meaningKo: input.meaningKo.trim(),
    sourceRef: { videoId: s.videoId, sentenceId: s.id },
    isSample: s.isSample === true,
  });
  const span = input.span ?? findExpressionSpan(s.english, text);
  const expressionIds = s.expressionIds.includes(expression.id) ? s.expressionIds : [...s.expressionIds, expression.id];
  const others = (s.expressionSpans ?? []).filter((x) => x.expressionId !== expression.id);
  const expressionSpans: ExpressionSpan[] = span ? [...others, { expressionId: expression.id, ...span }] : others;
  await repos.keySentences.update(s.id, { expressionIds, expressionSpans });
  return { expression, spanFound: span != null };
}

/** 표현 위치를 직접 지정 */
export async function setExpressionSpan(repos: Repositories, sentenceId: string, expressionId: string, span: TextSpan): Promise<void> {
  const s = await repos.keySentences.get(sentenceId);
  if (!s) throw new KeySentenceError('not_found', '핵심 문장을 찾을 수 없습니다.');
  if (!s.expressionIds.includes(expressionId)) throw new KeySentenceError('not_found', '이 문장에 연결된 표현이 아닙니다.');
  if (!validSpan(s.english, span)) throw new KeySentenceError('bad_span', '표현 위치가 문장 범위를 벗어났습니다.');
  const others = (s.expressionSpans ?? []).filter((x) => x.expressionId !== expressionId);
  await repos.keySentences.update(s.id, { expressionSpans: [...others, { expressionId, start: span.start, end: span.end }] });
}

/** 문장에서 표현 연결만 해제 (표현 레코드·학습 기록은 그대로) */
export async function unlinkExpression(repos: Repositories, sentenceId: string, expressionId: string): Promise<void> {
  const s = await repos.keySentences.get(sentenceId);
  if (!s) throw new KeySentenceError('not_found', '핵심 문장을 찾을 수 없습니다.');
  await repos.keySentences.update(s.id, {
    expressionIds: s.expressionIds.filter((x) => x !== expressionId),
    expressionSpans: (s.expressionSpans ?? []).filter((x) => x.expressionId !== expressionId),
  });
  await repos.expressions.removeSourceRef(expressionId, { videoId: s.videoId, sentenceId: s.id });
}

export interface ResolvedSpan extends ExpressionSpan {
  /** stored: 저장된 위치 / auto: 표현 텍스트로 자동 탐색 */
  source: 'stored' | 'auto';
}

/** 화면·빈칸용 표현 위치 — 저장된 위치를 우선하고, 없으면 자동 탐색 (순수 함수) */
export function resolveSpans(sentence: KeySentence, expressions: Pick<Expression, 'id' | 'text'>[]): ResolvedSpan[] {
  const stored = new Map((sentence.expressionSpans ?? []).map((s) => [s.expressionId, s]));
  const result: ResolvedSpan[] = [];
  for (const id of sentence.expressionIds) {
    const st = stored.get(id);
    if (st && validSpan(sentence.english, st)) {
      result.push({ ...st, source: 'stored' });
      continue;
    }
    const expr = expressions.find((e) => e.id === id);
    const found = expr ? findExpressionSpan(sentence.english, expr.text) : null;
    if (found) result.push({ expressionId: id, ...found, source: 'auto' });
  }
  return result;
}
