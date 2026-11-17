import type { AiAskRequest, AiContentRequest, AiDayPackRequest, AiDialogueRequest, AiPackRequest } from '../../src/types/aiApi.ts';
import type { GeminiClient, GeminiGetResult } from './gemini.ts';

const MOCK_CHUNKS = ['could use', 'a little break', 'right now', 'sounds like', 'a good idea', 'figure out', 'get back to', 'running late', 'catch up', 'no big deal', 'make it'];

/** 가짜 문장·Chunk: 자막에서 "1. …" 처럼 번호 붙은 영어 문장(Day) 또는 영어 문장 몇 개(일반)를 고르고, 아는 표현을 Chunk로 */
export function mockContentResult(r: AiContentRequest) {
  const lines = r.transcript.split('\n').map((l) => {
    const m = /^(\d+):(\d{2})\s+(.*)$/.exec(l.trim());
    return m ? { t: Number(m[1]) * 60 + Number(m[2]), text: m[3] } : { t: -1, text: l.trim() };
  });
  const picked: { number: number; t: number; text: string }[] = [];
  for (const l of lines) {
    const n = /^(\d+)[.)]\s+(.+)$/.exec(l.text);
    if (r.seriesKind === 'day' && n) picked.push({ number: Number(n[1]), t: l.t, text: n[2] });
    if (r.seriesKind === 'general' && /[A-Za-z]{3,}.*[A-Za-z]{3,}/.test(l.text) && MOCK_CHUNKS.some((c) => l.text.toLowerCase().includes(c))) picked.push({ number: picked.length + 1, t: l.t, text: l.text });
  }
  // Day 영상인데 번호 붙은 줄이 없으면(가짜 자막 등) 아는 표현이 든 줄을 순서대로
  if (r.seriesKind === 'day' && picked.length === 0)
    for (const l of lines) if (MOCK_CHUNKS.some((c) => l.text.toLowerCase().includes(c))) picked.push({ number: picked.length + 1, t: l.t, text: l.text });
  return {
    sentences: picked.map((p) => ({
      number: p.number,
      text: p.text,
      meaningKo: `(뜻) ${p.text}`,
      timestampSec: p.t,
      chunks: MOCK_CHUNKS.filter((c) => p.text.toLowerCase().includes(c)).map((c) => ({
        text: c, meaningKo: `${c}의 뜻`, meaningInSentence: `이 문장에서 ${c}`, nuance: '부드럽고 자연스러운 말투', usage: '친구·동료와 일상 대화', comparison: '비슷한 표현보다 가볍게 들림',
        examples: [{ en: `I really ${c} today.`, ko: `오늘은 정말 ${c}.` }, { en: `Do you ${c}?`, ko: `${c} 할래?` }],
      })),
    })),
    notes: '',
  };
}

/** 가짜 기본형 규칙: 'look super tired' → 기본 Chunk 'look tired' (정도만 강조하는 말 제거) + 바꿔 쓰기 틀 */
function mockBaseExtras(sentence: string) {
  const m = /\b(look|looks|feel|feels|seem|seems|sound|sounds)\s+(super|really|so|very)\s+([a-z]+)/i.exec(sentence);
  if (!m) return [];
    const base = `${m[1]} ${m[3]}`;
  return [{
    text: base, parts: [m[1], m[3]], surface: m[0], pattern: `${m[1]} + 형용사`, slotNote: '형용사 자리: 겉으로 보이는 상태',
    swapExamples: [
      { en: `${m[1]} happy`, ko: '행복해 보이다', note: '' },
      { en: `${m[1]} busy`, ko: '바빠 보이다', note: '' },
      { en: `${m[1]}s sad`, ko: '(고정 부분이 달라 패턴에 안 맞는 예 — 앱이 빼야 함)', note: '' },
      { en: `${m[1]} familiar`, ko: '', note: '' },
    ],
    meaningKo: `${base}의 뜻`, meaningInSentence: `이 문장에서 ${base}`, nuance: '상태를 보고 느낀 그대로 말함', usage: '상대 모습을 보고 말할 때', comparison: '강조 말을 넣으면 정도가 커짐',
    examples: [{ en: `You ${base} today.`, ko: '오늘 그래 보여.' }],
  }];
}

/** parts가 순서대로(사이 단어 2개까지) 문장에 있으면 그 실제 형태 */
function findForm(sentence: string, parts: string[]): string | null {
  const words = sentence.split(/\s+/);
  const clean = (w: string) => w.toLowerCase().replace(/[^a-z']/g, '');
  for (let i = 0; i < words.length; i++) {
    if (clean(words[i]) !== parts[0]) continue;
    let j = i;
    let ok = true;
    for (const p of parts.slice(1)) {
      let k = j + 1;
      while (k < words.length && k - j <= 3 && clean(words[k]) !== p) k++;
      if (k >= words.length || k - j > 3) {
        ok = false;
        break;
      }
      j = k;
    }
    if (ok) return words.slice(i, j + 1).join(' ').replace(/[.,!?]+$/, '');
  }
  return null;
}

/** 가짜 공통 Chunk + Day 대화문: 문장들에 가장 많이 나오는 아는 표현(사이 부사 허용)을 공통 Chunk로, 원문 문장을 그대로 쓴 줄 + 연결 문장 */
function mockDayPack(sentences: { number: number; text: string }[], dayLabel: string, transcript = '') {
  const counts = MOCK_CHUNKS.map((c) => ({ c, parts: c.split(' '), hits: sentences.filter((s) => findForm(s.text, c.split(' '))) }));
  const best = counts.filter((x) => x.hits.length > 0).sort((a, b) => b.hits.length - a.hits.length)[0];
  const core = best
    ? [{ text: best.c, parts: best.parts, meaningKo: `${best.c}의 뜻`, nuance: '부드럽게 바람을 말하는 느낌', usage: '지칠 때·도움이 필요할 때', comparison: 'need보다 덜 직접적', examples: [{ en: `I ${best.c} a hand.`, ko: '도움이 좀 필요해.' }, { en: `You ${best.c} some sleep.`, ko: '너 좀 자야겠다.' }], sentenceNumbers: best.hits.map((s) => s.number), taughtEvidence: transcript.split('\n').find((l) => /expression is|오늘 배울 표현/i.test(l))?.replace(/^\d+:\d{2}\s*/, '') ?? '' }]
    : [];
  // 추가 덩어리 표현: 핵심 Chunk가 아닌 아는 표현 (활용형 제외)
  const extraChunks = sentences.flatMap((s) =>
    [
      ...MOCK_CHUNKS.filter((c) => c !== best?.c && s.text.toLowerCase().includes(c) && !(best && findForm(c, best.parts))).map((c) => ({
        sentenceNumber: s.number, text: c, parts: [c], surface: c, pattern: '', slotNote: '', swapExamples: [] as { en: string; ko: string; note: string }[], meaningKo: `${c}의 뜻`, meaningInSentence: `이 문장에서 ${c}`, nuance: '자연스러운 구어', usage: '일상 대화', comparison: '비슷한 표현보다 가벼움',
        examples: [{ en: `Let's ${c}.`, ko: `${c} 하자.` }],
      })),
      ...mockBaseExtras(s.text).map((x) => ({ sentenceNumber: s.number, ...x })),
    ],
  );
  const lines: { speaker: 'A' | 'B'; en: string; ko: string; sourceSentenceNumber: number; chunkTexts: string[] }[] = [];
  sentences.forEach((s, i) => {
    lines.push({ speaker: i % 2 === 0 ? 'A' : 'B', en: s.text, ko: `(번역) ${s.text}`, sourceSentenceNumber: s.number, chunkTexts: core.length && findForm(s.text, core[0].parts) ? [core[0].text] : [] });
    if (i === 0) lines.push({ speaker: 'B', en: 'Same here, honestly.', ko: '나도 그래, 솔직히.', sourceSentenceNumber: 0, chunkTexts: [] });
  });
  const usedAs = core.length ? [...new Set(sentences.map((s) => findForm(s.text, core[0].parts)).filter((x): x is string => !!x))] : [];
  return {
    coreChunks: core,
    extraChunks,
    dialogue: {
      title: `${dayLabel} 카페에서`,
      situation: '퇴근 후 지친 두 동료가 카페에서 이야기합니다.',
      lines,
      chunkNotes: core.map((c) => ({ text: c.text, kind: 'core', usedAs, meaningInContext: `여기서는 ${c.meaningKo}`, nuance: '편한 사이의 말투', whyUsed: '피곤함을 부드럽게 말하려고', example: { en: `I ${c.text} a break.`, ko: '좀 쉬고 싶다.' } })),
    },
    notes: '',
  };
}

export function mockPackResult(r: AiPackRequest) {
  const c = mockContentResult({ ...r, task: 'content' });
  const day = mockDayPack(c.sentences, r.dayNumber ? `Day ${r.dayNumber}` : '영상', r.transcript);
  // 문장별 chunks = 추가 덩어리 표현 (핵심 Chunk·활용형 제외) — 실제 Gemini처럼 가끔 활용형을 섞어 앱의 걸러내기도 확인
  const sentences = c.sentences.map((s) => ({ ...s, chunks: [...s.chunks.map((k) => ({ ...k, parts: [k.text], surface: k.text, pattern: '', slotNote: '', swapExamples: [] as { en: string; ko: string; note: string }[] })), ...mockBaseExtras(s.text)] }));
  const { extraChunks: _e, ...rest } = day;
  void _e;
  return { sentences, ...rest, notes: '' };
}

export function mockDayPackResult(r: AiDayPackRequest) {
  return mockDayPack(r.sentences, r.dayNumber ? `Day ${r.dayNumber}` : '영상', r.transcript ?? '');
}

/** 가짜 AI 질문 답변: 받은 문맥(Chunk·이전 대화)을 답에 드러내 테스트에서 확인할 수 있게 */
export function mockAskResult(r: AiAskRequest) {
  const c = r.context;
  const prev = r.history.length ? ` (이전 질문 ${r.history.length}개에 이어서: "${r.history[r.history.length - 1].question}")` : '';
  return {
    answer: `'${c.base}'에 대한 질문 "${r.question}"에 답해요${prev}. 구분: ${c.role === 'core' ? '핵심 Chunk' : '추가 덩어리 표현'}.`,
    grammar: { verdict: '가능', explain: `${c.base} 형태는 문법적으로 맞아요.` },
    natural: { verdict: '상황에 따라 다름', explain: '친구 사이 대화에서는 자연스럽게 써요.' },
    nuance: `${c.base}는 ${c.meaningKo || '이 문맥'}의 느낌이에요.`,
    examples: [{ en: `I think you ${c.base.split(' ')[0]} it.`, ko: '(예문 뜻)' }, { en: `Do you ${c.base}?`, ko: '(예문 뜻 2)' }],
    fromLecture: c.taught ? `강의에서는 "${c.taught}"라고 소개했어요.` : '',
    uncertain: '지역에 따라 다르게 들릴 수 있어요.',
    summary: `${c.base} 질문(${r.turn}번째)에 대한 답 요약.`,
  };
}

/** 가짜 통합 대화문: Chunk마다 한 줄씩, 마지막 하나는 쓰지 않음(unusedRefs 확인용) */
export function mockDialogueResult(r: AiDialogueRequest) {
  const used = r.chunks.slice(0, Math.max(2, r.chunks.length - 1));
  const lines = used.map((c, i) => ({ speaker: i % 2 === 0 ? 'A' : 'B', en: `Well, ${c.text} is exactly what I mean.`, ko: `음, 그게 바로 '${c.meaningKo}'라는 뜻이야.`, chunkRefs: [c.ref] }));
  lines.push({ speaker: lines.length % 2 === 0 ? 'A' : 'B', en: 'Sounds good to me.', ko: '나도 좋아.', chunkRefs: [] });
  return {
    title: '퇴근 후 카페에서',
    situation: '퇴근한 두 친구가 카페에서 오늘 있었던 일을 이야기합니다.',
    lines,
    chunkNotes: used.map((c) => ({ ref: c.ref, usedAs: c.text, meaningInContext: `여기서는 ${c.meaningKo}`, nuance: '편한 사이의 말투', whyUsed: '상대의 말에 자연스럽게 이어 가려고', example: { en: `${c.text} again.`, ko: `다시 ${c.meaningKo}.` } })),
    unusedRefs: r.chunks.slice(used.length).map((c) => c.ref),
    notes: '',
  };
}

/**
 * 테스트·개발용 가짜 Gemini (실제 Google 호출 없음). AI_GEMINI_MOCK=1일 때 개발 서버가 쓴다.
 * 영상 ID로 결과를 고른다:
 * - 'mockQuota…' → 생성 시 429 (무료 한도)
 * - 'mockBad…'   → 생성 시 400 (거부)
 * - 'mockFail…'  → 처리 후 failed
 * - 'mockOver…'  → 영상 길이를 넘는 타임스탬프가 섞인 결과 (경고, 자동 적용)
 * - 'mockLow…'   → 앞부분만 전사된 결과 (전사 비율 낮음 → 확인 필요)
 * - 'mockSlow…'  → 조회 3번까지 진행 중
 * - 그 밖       → 조회 1번 진행 중, 다음 조회에 완료
 */
export function createMockGemini(): GeminiClient & { createCalls: string[]; getCalls: string[] } {
  const jobs = new Map<string, { videoId: string; durationSec: number; polls: number; text?: string }>();
  const createCalls: string[] = [];
  const getCalls: string[] = [];
  let seq = 0;
  return {
    createCalls,
    getCalls,
    async create(input) {
      if (input.task === 'ask') {
        // 가짜 질문 답변: 질문에 '[실패]'가 있으면 처리 후 실패, '[한도]'면 무료 한도 거절 (실패 처리 확인용)
        createCalls.push(`ask:${input.sessionId}:${input.turn}`);
        if (input.question.includes('[한도]')) return { kind: 'rejected', httpStatus: 429, reason: 'quota', message: 'Gemini 무료 사용 한도에 도달했어요.' };
        const id = `mock-interaction-${++seq}-ask`;
        jobs.set(id, input.question.includes('[실패]') ? { videoId: 'mockFail', durationSec: 0, polls: 0 } : { videoId: 'ask', durationSec: 0, polls: 0, text: JSON.stringify(mockAskResult(input)) });
        return { kind: 'created', interactionId: id, status: 'in_progress' };
      }
      if (input.task === 'content' || input.task === 'dialogue' || input.task === 'pack' || input.task === 'daypack') {
        const tag = input.task === 'dialogue' ? 'dialogue' : `${input.task}:${input.videoId}`;
        createCalls.push(tag);
        if (input.task !== 'dialogue' && input.videoId.startsWith('mockBad')) return { kind: 'rejected', httpStatus: 400, reason: 'invalid', message: '가짜 거부' };
        if (input.task !== 'dialogue' && input.videoId.startsWith('mockFail')) {
          const id = `mock-interaction-${++seq}-${tag}`;
          jobs.set(id, { videoId: 'mockFail', durationSec: 0, polls: 0 });
          return { kind: 'created', interactionId: id, status: 'in_progress' };
        }
        const text =
          input.task === 'content' ? mockContentResult(input) : input.task === 'dialogue' ? mockDialogueResult(input) : input.task === 'pack' ? mockPackResult(input) : mockDayPackResult(input);
        const id = `mock-interaction-${++seq}-${tag}`;
        jobs.set(id, { videoId: tag, durationSec: 0, polls: 0, text: JSON.stringify(text) });
        return { kind: 'created', interactionId: id, status: 'in_progress' };
      }
      const { videoId, durationSec } = input;
      createCalls.push(videoId);
      if (videoId.startsWith('mockQuota')) return { kind: 'rejected', httpStatus: 429, reason: 'quota', message: 'Gemini 무료 사용 한도에 도달했어요.' };
      if (videoId.startsWith('mockBad')) return { kind: 'rejected', httpStatus: 400, reason: 'invalid', message: '영상을 처리할 수 없어요(비공개 등).' };
      const id = `mock-interaction-${++seq}-${videoId}`;
      jobs.set(id, { videoId, durationSec, polls: 0 });
      return { kind: 'created', interactionId: id, status: 'in_progress' };
    },
    async get(id): Promise<GeminiGetResult> {
      getCalls.push(id);
      const job = jobs.get(id);
      if (!job) return { kind: 'gone' };
      job.polls++;
      const wait = job.videoId.startsWith('mockSlow') ? 3 : 1;
      if (job.polls <= wait) return { kind: 'running', status: 'in_progress' };
      if (job.text) return { kind: 'completed', text: job.text, model: 'gemini-3.6-flash', usage: { inputTokens: 900, outputTokens: 700, videoTokens: null } };
      if (job.videoId.startsWith('mockFail')) return { kind: 'failed', status: 'failed', message: '가짜 실패' };
      const d = job.durationSec;
      const over = job.videoId.startsWith('mockOver');
      const low = job.videoId.startsWith('mockLow');
      // 보통: 영상 전체를 10초 단위로 덮는 전사. mockLow: 앞부분만(전사 비율 낮음 → 확인 필요). mockOver: 길이를 넘는 구간 하나 섞임
      const transcript: { start: number; end: number; text: string }[] = [];
      const until = low ? Math.min(60, d) : d;
      for (let t = 0; t < until; t += 10) transcript.push({ start: t, end: Math.min(t + 10, d), text: t === 40 ? "Today's expression is could use." : `line at ${t}s` });
      if (!transcript.some((x) => x.text.includes('could use'))) transcript.push({ start: Math.min(41, d - 1), end: Math.min(43, d), text: "Today's expression is could use." });
      transcript.sort((a, b) => a.start - b.start);
      if (over) transcript.push({ start: d + 100, end: d + 110, text: '영상 길이를 넘는 구간' });
      const result = {
        language: 'mixed',
        dayNumber: 0,
        transcript,
        keyExpressions: [{ text: 'could use', meaningKo: '~가 필요하다', sourceSentence: "Today's expression is could use.", timestampSec: 41, onScreen: false, confidence: 1 }],
        introChunks: [{ text: 'a cup of coffee', meaningKo: '커피 한 잔', timestampSec: 30 }],
        notes: '',
      };
      return { kind: 'completed', text: JSON.stringify(result), model: 'gemini-3.6-flash', usage: { inputTokens: d * 91 + 300, outputTokens: 1500, videoTokens: d * 91 } };
    },
  };
}
