import { describe, expect, it } from 'vitest';
import { bodyHashSource, buildContentPrompt, buildDialoguePrompt, validateTaskRequest } from './tasks.ts';
import { createBodyFor } from './gemini.ts';
import { handleAiExtract, DEFAULT_AI_CAPS } from './extractHandler.ts';
import { memoryLedgerStore } from './ledger.ts';
import { createMockGemini } from './mockGemini.ts';

const content = { task: 'content', videoId: 'eNODHkrNuDA', title: '[Day 11] 필요해', seriesKind: 'day', dayNumber: 11, transcript: '00:10 1. I could use a little break right now.\n00:20 2. That sounds like a good idea.', promptVersion: 'c1' };
const dialogue = {
  task: 'dialogue',
  chunks: [
    { ref: 'li-1', text: 'could use', meaningKo: '~가 필요하다', day: 11, source: 'Day 11' },
    { ref: 'li-2', text: 'sounds like', meaningKo: '~인 것 같다', day: 12, source: 'Day 12' },
    { ref: 'li-3', text: 'figure out', meaningKo: '알아내다', day: 13, source: 'Day 13' },
  ],
  lineCount: 8,
  promptVersion: 'd1',
};

describe('AI 작업 요청 검사', () => {
  it('기존 자막 추출 요청은 그대로 통과하고 해시 형식도 예전과 같다', () => {
    const r = validateTaskRequest({ videoId: 'eNODHkrNuDA', durationSec: 295, promptVersion: 'v1' })!;
    expect(r).toEqual({ videoId: 'eNODHkrNuDA', durationSec: 295, promptVersion: 'v1' });
    expect(bodyHashSource(r)).toBe('eNODHkrNuDA|295|v1');
  });
  it('content·dialogue 요청 검사', () => {
    expect(validateTaskRequest(content)).toMatchObject({ task: 'content', seriesKind: 'day', dayNumber: 11 });
    expect(validateTaskRequest({ ...content, seriesKind: 'x' })).toBeNull();
    expect(validateTaskRequest({ ...content, transcript: 'short' })).toBeNull();
    expect(validateTaskRequest({ ...content, transcript: 'a'.repeat(60_001) })).toBeNull();
    expect(validateTaskRequest(dialogue)).toMatchObject({ task: 'dialogue', lineCount: 8 });
    expect(validateTaskRequest({ ...dialogue, chunks: dialogue.chunks.slice(0, 1) })).toBeNull();
    expect(validateTaskRequest({ ...dialogue, chunks: [dialogue.chunks[0], dialogue.chunks[0]] })).toBeNull();
    expect(validateTaskRequest({ ...dialogue, chunks: [{ ...dialogue.chunks[0], ref: 'bad ref!' }, dialogue.chunks[1]] })).toBeNull();
    expect(validateTaskRequest({ ...dialogue, task: 'other' })).toBeNull();
  });
  it('프롬프트: Day는 번호·원문 보존, 일반은 맥락 선별, 대화문은 학습 Chunk만 표시', () => {
    const day = buildContentPrompt(validateTaskRequest(content) as never);
    expect(day).toContain('번호와 순서 그대로');
    expect(day).toContain('개수를 채우려고 만들지 않습니다');
    expect(day).toContain('1. I could use a little break right now.');
    const gen = buildContentPrompt({ ...(validateTaskRequest(content) as object), seriesKind: 'general', dayNumber: null } as never);
    expect(gen).toContain('무조건 고르지 않습니다');
    const dl = buildDialoguePrompt(validateTaskRequest(dialogue) as never);
    expect(dl).toContain('ref=li-2 | sounds like');
    expect(dl).toContain('목록에 없는 표현을 배운 표현으로 표시하지 않습니다');
  });
  it('텍스트 작업은 영상 주소를 보내지 않는다', () => {
    const b = createBodyFor('gemini-3.6-flash', validateTaskRequest(content)!);
    expect(JSON.stringify(b.input)).not.toContain('youtube.com');
    expect(b.input).toHaveLength(1);
  });
});

describe('장부: content·dialogue도 식별자당 생성 1회, 요청 수만 센다', () => {
  it('생성 1회 → 같은 식별자로 조회 → 결과', async () => {
    const store = memoryLedgerStore();
    const g = createMockGemini();
    const deps = { store, gemini: g, caps: DEFAULT_AI_CAPS, now: () => Date.parse('2026-11-16T10:00:00Z') };
    const key = '11111111-1111-4111-8111-111111111111';
    const a = await handleAiExtract({ idempotencyKey: key, body: dialogue }, deps);
    expect(a.status).toBe(202);
    const b = await handleAiExtract({ idempotencyKey: key, body: dialogue }, deps);
    const c = b.body.state === 'succeeded' ? b : await handleAiExtract({ idempotencyKey: key, body: dialogue }, deps);
    expect(c.body.state).toBe('succeeded');
    expect(g.createCalls).toEqual(['dialogue']);
    const usage = store.getUsage('2026-11-16');
    expect(usage).toEqual({ pacificDate: '2026-11-16', videoSec: 0, requests: 1 });
    const conflict = await handleAiExtract({ idempotencyKey: key, body: { ...dialogue, lineCount: 10 } }, deps);
    expect(conflict.status).toBe(409);
  });
});
