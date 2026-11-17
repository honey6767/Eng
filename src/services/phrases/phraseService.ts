import { AI_PHRASES_PROMPT_VERSION, PHRASES_LIMITS, type AiPhrasesRequest } from '@/types/aiApi';
import type { Dialogue } from '@/types/models';
import { markApplied, runAiTask, type TaskProgress } from '@/services/ai/taskRunner';
import type { QaDeps } from '@/services/qa/qaService';
import { lineText, validateUsefulPhrases } from './usefulPhrases';

/**
 * 기존 대화문의 ✨ 유용한 회화 표현 분석
 *
 * - 사용자가 고른 대화문에서 버튼을 눌러 확인했을 때만 Gemini 1회 (화면 진입·새로고침으로는 요청 없음)
 * - 이미 분석한 대화문은 다시 요청하지 않는다 (같은 대화문은 서버에 보관된 결과도 다시 씀)
 * - 실패해도 자동으로 다시 보내지 않는다. 시도 기록은 성공·실패 모두 쌓아 두고, 결과·기록을 덮어쓰지 않는다
 * - 대화문 기록(학습 DB)은 바꾸지 않고 결과는 AI 부가 기록 DB에만 저장한다
 */

export const phraseTaskKey = (dialogueId: string) => `phrases:${dialogueId}`;

/** 새 대화문(이미 phrases가 있음)이나 이미 분석한 대화문은 분석 대상이 아니다 */
export function canAnalyze(d: Dialogue): boolean {
  return !d.phrases && d.lines.length >= PHRASES_LIMITS.minLines;
}

export function buildPhrasesRequest(d: Dialogue): AiPhrasesRequest {
  const L = PHRASES_LIMITS;
  const exclude = [...new Set((d.chunkUsages ?? []).filter((u) => u.kind !== 'extra').map((u) => u.text))].filter(Boolean).slice(0, L.maxExclude).map((t) => t.slice(0, L.excludeChars));
  return {
    task: 'phrases', dialogueId: d.id.slice(0, 160),
    lines: d.lines.slice(0, L.maxLines).map((l) => ({ speaker: l.speaker === 'B' ? 'B' : 'A', en: lineText(l).slice(0, L.lineChars) })),
    exclude, promptVersion: AI_PHRASES_PROMPT_VERSION,
  };
}

export type AnalyzeOutcome = { ok: true; count: number; already: boolean } | { ok: false; code: string; message: string; httpStatus: number | null };

const inFlight = new Set<string>();

export async function analyzeDialogue(deps: QaDeps, d: Dialogue, onProgress?: (p: TaskProgress) => void): Promise<AnalyzeOutcome> {
  if (!canAnalyze(d)) return { ok: true, count: d.phrases?.length ?? 0, already: true };
  if (await deps.store.getPhraseSet(d.id)) return { ok: true, count: (await deps.store.getPhraseSet(d.id))!.phrases.length, already: true };
  if (inFlight.has(d.id)) return { ok: false, code: 'in_flight', message: '이미 분석 중이에요.', httpStatus: null };
  inFlight.add(d.id);
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const newId = deps.newId ?? (() => crypto.randomUUID());
  try {
    const attempts = await deps.store.attemptsOf(d.id);
    const key = phraseTaskKey(d.id);
    // 앞 시도가 실패했다면, 이번 누름은 사용자가 고른 '다시 시도' (첫 요청에만 다시 생성 표시)
    const retry = attempts.some((a) => a.status === 'failed') && !attempts.some((a) => a.status === 'succeeded');
    const out = await runAiTask(key, () => buildPhrasesRequest(d), { store: deps.store, client: deps.client, now: deps.now, newId: deps.newId, sleep: deps.sleep, pollMs: deps.pollMs }, (p) => onProgress?.(p), undefined, { retryFailed: retry });
    const requestId = (await deps.store.getTask(key))?.requestId ?? null;
    if (!out.ok) {
      await deps.store.addAttempt({ id: newId(), dialogueId: d.id, status: 'failed', requestId, at: now(), error: { code: out.code, message: out.message, httpStatus: out.httpStatus }, count: 0 });
      return { ok: false, code: out.code, message: out.message, httpStatus: out.httpStatus };
    }
    let raw: Record<string, unknown> | null = null;
    try {
      raw = JSON.parse(out.text);
    } catch {
      raw = null;
    }
    if (!raw) {
      await deps.store.addAttempt({ id: newId(), dialogueId: d.id, status: 'failed', requestId, at: now(), error: { code: 'invalid_result', message: 'AI 결과를 읽지 못했어요.', httpStatus: null }, count: 0 });
      const st = await deps.store.getTask(key);
      if (st) await deps.store.putTask(key, { ...st, status: 'failed', resultText: null });
      return { ok: false, code: 'invalid_result', message: 'AI 결과를 읽지 못했어요.', httpStatus: null };
    }
    const extraIds = new Set((d.chunkUsages ?? []).filter((u) => u.kind === 'extra').map((u) => u.learningItemId));
    const coreTexts = (d.chunkUsages ?? []).filter((u) => u.kind !== 'extra').map((u) => u.text);
    const phrases = validateUsefulPhrases(raw.usefulPhrases, d.lines, { coreTexts, extraIds, newId: () => `ph-${out.requestId}-${newId()}` });
    // 찾은 표현이 없어도 '분석함'으로 기록 → 다시 요청하지 않음
    await deps.store.addPhraseSet({ dialogueId: d.id, phrases, requestId: out.requestId, promptVersion: AI_PHRASES_PROMPT_VERSION, createdAt: now() });
    await deps.store.addAttempt({ id: newId(), dialogueId: d.id, status: 'succeeded', requestId: out.requestId, at: now(), error: null, count: phrases.length });
    await markApplied(deps.store, key);
    return { ok: true, count: phrases.length, already: false };
  } finally {
    inFlight.delete(d.id);
  }
}
