import { describe, expect, it } from 'vitest';
import type { AiClient, AiTransportResult } from '@/services/integrations/aiClient';
import type { Dialogue, DialogueLine } from '@/types/models';
import { handleAiExtract, readUsage, type AiCaps } from '../../../server/ai/extractHandler';
import { memoryLedgerStore } from '../../../server/ai/ledger';
import { createMockGemini } from '../../../server/ai/mockGemini';
import { buildPhrasesPrompt, validateTaskRequest } from '../../../server/ai/tasks';
import { QaDatabase } from '@/services/qa/qaDb';
import { createQaStore, type QaDeps } from '@/services/qa/qaService';
import { buildBlankPlan } from '@/services/prep/packService';
import { analyzeDialogue, buildPhrasesRequest } from './phraseService';
import { usefulModelOf, validateUsefulPhrases } from './usefulPhrases';

const T = '2026-11-18T12:00:00.000Z';
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

const line = (i: number, speaker: 'A' | 'B', parts: (string | [string, string])[], korean = '뜻'): DialogueLine =>
  ({ id: `l${i}`, order: i, speaker, korean, segments: parts.map((p) => (typeof p === 'string' ? { kind: 'connector', text: p } : { kind: 'key', text: p[0], learningItemId: p[1] })) }) as DialogueLine;

/** 기존 Day 대화문 (핵심 Chunk could use, 원문 출처 ✨ a cup of coffee) */
function dayDialogue(extraLines: DialogueLine[] = []): Dialogue {
  const lines = [
    line(1, 'A', ['I', ['could really use', 'core1'], ['a cup of coffee', 'ext1'], 'right now.']),
    line(2, 'B', ['I know what you mean. I could use a nap too.']),
    line(3, 'A', ["Let's figure it out after lunch."]),
    line(4, 'B', ["I'll take you up on that. No big deal."]),
    line(5, 'A', ["I'm so ready for the weekend."]),
    ...extraLines,
  ];
  return {
    id: 'dlg-day-1', createdAt: T, updatedAt: T, kind: 'original', videoId: 'v11', sourceVideoIds: ['v11'], orderInVideo: 1, title: 'Day 11 카페', situation: '', lines, expressionIds: [], generatedBy: 'ai', isFavorite: false, sourceDays: [11],
    chunkUsages: [
      { learningItemId: 'core1', kind: 'core', expressionId: 'e1', text: 'could use', usedAs: 'could really use', dayNumber: 11, videoId: 'v11', meaningInContext: '', nuance: '', whyUsed: '', example: { en: '', ko: '' } },
      { learningItemId: 'ext1', kind: 'extra', expressionId: 'e2', text: 'a cup of coffee', usedAs: 'a cup of coffee', dayNumber: 11, videoId: 'v11', meaningInContext: '커피 한 잔', nuance: '', whyUsed: '', example: { en: '', ko: '' } },
    ],
    blankPlan: { version: 2, lines: {} },
  } as Dialogue;
}

const P = (base: string, usedAs: string[], extra: Record<string, unknown> = {}) => ({ base, usedAs, category: 'reaction', meaningKo: `${base} 뜻`, nuance: 'n', usage: 'u', pattern: '', slotNote: '', swapExamples: [], ...extra });

describe('✨ 유용한 회화 표현 선별', () => {
  it('대화문에 실제로 있는 것만, 떨어진 구동사도 찾고, 핵심 Chunk·한 단어·중복은 제외', () => {
    const d = dayDialogue(Array.from({ length: 10 }, (_, i) => line(20 + i, i % 2 ? 'B' : 'A', [`Filler ${i}.`])));
    const out = validateUsefulPhrases(
      [
        P('I know what you mean', ['I know what you mean']),
        P('figure out', ['figure out'], { category: 'phrasal' }), // 대화문에는 figure it out
        P('take someone up on something', ['take you up on'], { category: 'phrasal' }),
        P('hit the road', ['hit the road']), // 대화문에 없음
        P('could use', ['could use']), // 핵심 Chunk
        P('honestly', ['honestly']), // 한 단어
        P('I know what you mean', ['I know what you mean']), // 중복
      ],
      d.lines, { coreTexts: ['could use'], extraIds: new Set(['ext1']), newId: uuid },
    );
    expect(out.map((p) => [p.base, p.occurrences.map((o) => o.usedAs)])).toEqual([
      ['I know what you mean', ['I know what you mean']],
      ['figure out', ['figure it out']],
      ['take someone up on something', ['take you up on']],
    ]);
    // take you up on은 같은 줄(4번째)이 아니라서 들어갈 수 있지만, 15줄 → 상한 min(6, 6) - 원문 출처 1 = 5 안에서 3번째
    expect(validateUsefulPhrases([P('take someone up on something', ['take you up on'])], d.lines, { coreTexts: [], extraIds: new Set(['ext1']), newId: uuid })[0].occurrences[0].usedAs).toBe('take you up on');
    // 짧은 대화문(5줄): 40% 상한 2개 - 원문 출처 1개 = 대화문 출처 1개만
    expect(validateUsefulPhrases([P('I know what you mean', ['I know what you mean']), P('figure out', ['figure it out'])], dayDialogue().lines, { coreTexts: [], extraIds: new Set(['ext1']), newId: uuid }).length).toBe(1);
  });

  it('상한: 대화문당 최대 6개(원문 출처 포함) · 줄 수의 40% · 한 줄에 1개', () => {
    const many = Array.from({ length: 15 }, (_, i) => line(10 + i, i % 2 ? 'B' : 'A', [`Filler line number ${i}.`]));
    const d = dayDialogue(many);
    const raw = [
      P('I know what you mean', ['I know what you mean']),
      P('a nap too', ['a nap too']), // 같은 2번째 줄 → 한 줄에 1개라 제외
      P('figure out', ['figure it out']),
      P('take someone up on something', ['take you up on']),
      P("I'm so ready for", ["I'm so ready for"], { category: 'pattern', pattern: "I'm so ready for + 명사", slotNote: '명사 자리: 기다리던 것', swapExamples: [{ en: "I'm so ready for vacation", ko: '휴가가 너무 기다려져', note: '' }] }),
      P('Filler line number', ['Filler line number 1']),
      P('line number 2', ['line number 2']),
      P('number 3', ['number 3']),
    ];
    const out = validateUsefulPhrases(raw, d.lines, { coreTexts: ['could use'], extraIds: new Set(['ext1']), newId: uuid });
    expect(out.length).toBe(5); // 6 - 원문 출처 1
    expect(out.some((p) => p.base === 'a nap too')).toBe(false);
    expect(out.find((p) => p.base === "I'm so ready for")?.swapExamples?.[0].en).toBe("I'm so ready for vacation");
    const lines = out.flatMap((p) => p.occurrences.map((o) => o.lineId));
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('화면 모델: 원문 출처와 대화문 출처를 한 분류로, 출처는 구분 · 핵심 Chunk와 겹치지 않음', () => {
    const d = dayDialogue();
    const phrases = validateUsefulPhrases([P('I know what you mean', ['I know what you mean'])], d.lines, { coreTexts: ['could use'], extraIds: new Set(['ext1']), newId: uuid });
    const m = usefulModelOf(d, phrases);
    expect(m.items.map((x) => [x.base, x.source])).toEqual([['a cup of coffee', 'sentence'], ['I know what you mean', 'dialogue']]);
    expect(m.items[0].pattern?.pattern).toBe('a cup of + 명사'); // 원문 출처도 검토된 교체 패턴
    expect(usefulModelOf(d, null).items.map((x) => x.base)).toEqual(['a cup of coffee']); // 분석 전
  });

  it('새 대화문 빈칸: ✨는 2순위(2단계 핵심 Chunk만 빈칸은 그대로), 기존 빈칸 자료는 바꾸지 않음', () => {
    const d = dayDialogue();
    const phrases = validateUsefulPhrases([P('I know what you mean', ['I know what you mean'])], d.lines, { coreTexts: ['could use'], extraIds: new Set(['ext1']), newId: uuid });
    const spans = Object.fromEntries(phrases.flatMap((p) => p.occurrences.map((o) => [o.lineId, [{ s: o.start, e: o.end }]])));
    const plan = buildBlankPlan(d.lines, new Set(['core1']), spans);
    expect(plan.lines.l2.slice(0, 5)).toEqual([2, 2, 2, 2, 2]); // I know what you mean
    expect(plan.lines.l1.filter((r) => r === 1).length).toBe(3); // could really use (핵심)
    expect(plan.lines.l1.filter((r) => r === 2).length).toBe(4); // a cup of coffee (원문 출처 ✨)
    const before = JSON.stringify(d.blankPlan);
    usefulModelOf(d, phrases);
    expect(JSON.stringify(d.blankPlan)).toBe(before);
  });
});

function server(caps: AiCaps = { dailyVideoSec: 6 * 3600, dailyRequests: 20, maxVideoSec: 1800 }) {
  const gemini = createMockGemini();
  const ledger = memoryLedgerStore();
  const sent: { key: string; body: Record<string, unknown> }[] = [];
  const client: AiClient = {
    async extract(key, body): Promise<AiTransportResult> {
      sent.push({ key, body: body as never });
      const r = await handleAiExtract({ idempotencyKey: key, body }, { store: ledger, gemini, caps, now: () => Date.parse(T) });
      return { kind: 'response', httpStatus: r.status, body: r.body };
    },
  };
  return { client, gemini, sent, ledger, caps };
}
const deps = (client: AiClient, db = new QaDatabase(`ph-test-${++seq}`)): QaDeps => ({ store: createQaStore(db), client, now: () => new Date(T), newId: uuid, sleep: async () => {}, pollMs: 1 });

describe('기존 대화문 ✨ 분석 (버튼을 눌렀을 때만)', () => {
  it('요청: 대화문 줄과 핵심 Chunk만 보내고, 결과는 별도 DB에 · 대화문 기록은 그대로 · 이미 분석했으면 다시 요청 안 함', async () => {
    const s = server();
    const d = deps(s.client);
    const dlg = dayDialogue();
    const req = buildPhrasesRequest(dlg);
    expect(req).toMatchObject({ task: 'phrases', exclude: ['could use'] });
    expect(validateTaskRequest(req)).not.toBeNull();
    expect(buildPhrasesPrompt(req)).toContain('제외할 핵심 Chunk');
    const before = JSON.stringify(dlg);
    const out = await analyzeDialogue(d, dlg);
    expect(out).toMatchObject({ ok: true, already: false });
    const set = await d.store.getPhraseSet(dlg.id);
    expect(set!.phrases.map((p) => p.base)).toContain('I know what you mean');
    expect(set!.phrases.some((p) => p.base === 'hit the road' || p.base === 'could use' || p.base === 'honestly')).toBe(false);
    expect(JSON.stringify(dlg)).toBe(before);
    const calls = s.gemini.createCalls.length;
    expect(await analyzeDialogue(d, dlg)).toMatchObject({ ok: true, already: true });
    expect(s.gemini.createCalls.length).toBe(calls);
    // 다른 기기: 같은 대화문은 서버 보관 결과 (Gemini 호출 없음, 하루 상한도 안 씀)
    const used = readUsage(s.ledger, s.caps, Date.parse(T)).requests;
    const other = deps(s.client);
    expect(await analyzeDialogue(other, dlg)).toMatchObject({ ok: true, already: false });
    expect(s.gemini.createCalls.length).toBe(calls);
    expect(readUsage(s.ledger, s.caps, Date.parse(T)).requests).toBe(used);
  });

  it('실패: 자동 재시도 없음, 시도 기록 보존 · 다시 누르면 그때만 새 요청(첫 요청에만 다시 생성 표시)', async () => {
    const s = server();
    const d = deps(s.client);
    const dlg = dayDialogue([line(9, 'B', ['[실패] 이 줄이 있으면 가짜 AI가 실패해요.'])]);
    const r1 = await analyzeDialogue(d, dlg);
    expect(r1).toMatchObject({ ok: false, code: 'gemini_failed' });
    const calls = s.gemini.createCalls.length;
    expect((await d.store.attemptsOf(dlg.id)).map((a) => a.status)).toEqual(['failed']);
    expect(await d.store.getPhraseSet(dlg.id)).toBeUndefined();
    expect(s.gemini.createCalls.length).toBe(calls); // 기다려도 다시 보내지 않음
    const n = s.sent.length;
    await analyzeDialogue(d, dlg); // 사용자가 다시 누름
    expect(s.sent[n].body.retryFailed).toBe(true);
    expect(s.sent.slice(n + 1).every((x) => !x.body.retryFailed)).toBe(true);
    expect((await d.store.attemptsOf(dlg.id)).map((a) => a.status)).toEqual(['failed', 'failed']); // 기록은 쌓임
  });

  it('새 대화문(이미 ✨가 저장됨)은 분석 대상이 아님 · 사용량 조회는 Gemini를 부르지 않음', async () => {
    const s = server();
    const d = deps(s.client);
    const dlg = { ...dayDialogue(), phrases: [] };
    expect(await analyzeDialogue(d, dlg)).toMatchObject({ ok: true, already: true });
    expect(s.gemini.createCalls.length).toBe(0);
    expect(readUsage(s.ledger, s.caps, Date.parse(T))).toMatchObject({ ok: true, requests: 0, dailyRequests: 20, phrases: { used: 0 } });
  });
});
