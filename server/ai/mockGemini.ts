import type { GeminiClient, GeminiGetResult } from './gemini.ts';

/**
 * 테스트·개발용 가짜 Gemini (실제 Google 호출 없음). AI_GEMINI_MOCK=1일 때 개발 서버가 쓴다.
 * 영상 ID로 결과를 고른다:
 * - 'mockQuota…' → 생성 시 429 (무료 한도)
 * - 'mockBad…'   → 생성 시 400 (거부)
 * - 'mockFail…'  → 처리 후 failed
 * - 'mockOver…'  → 영상 길이를 넘는 타임스탬프가 섞인 결과
 * - 'mockSlow…'  → 조회 3번까지 진행 중
 * - 그 밖       → 조회 1번 진행 중, 다음 조회에 완료
 */
export function createMockGemini(): GeminiClient & { createCalls: string[]; getCalls: string[] } {
  const jobs = new Map<string, { videoId: string; durationSec: number; polls: number }>();
  const createCalls: string[] = [];
  const getCalls: string[] = [];
  let seq = 0;
  return {
    createCalls,
    getCalls,
    async create({ videoId, durationSec }) {
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
      if (job.videoId.startsWith('mockFail')) return { kind: 'failed', status: 'failed', message: '가짜 실패' };
      const d = job.durationSec;
      const over = job.videoId.startsWith('mockOver');
      const transcript = [
        { start: 0, end: 4.5, text: 'Hi guys. Welcome to Day 11.' },
        { start: 41, end: 43.5, text: "Today's expression is could use." },
        { start: 44, end: 54, text: '요거는 한 덩어리로 기억하시면 돼요.' },
        { start: 60, end: 64, text: 'I could seriously use a cup of coffee right now.' },
        ...(over ? [{ start: d + 100, end: d + 110, text: '영상 길이를 넘는 구간' }] : [{ start: Math.max(0, d - 10), end: d, text: 'See you tomorrow. Bye!' }]),
      ];
      const result = {
        language: 'mixed',
        dayNumber: 11,
        transcript,
        keyExpressions: [{ text: 'could use', meaningKo: '~가 필요하다', sourceSentence: "Today's expression is could use.", timestampSec: 41, onScreen: false, confidence: 1 }],
        introChunks: [],
        notes: '',
      };
      return { kind: 'completed', text: JSON.stringify(result), model: 'gemini-3.6-flash', usage: { inputTokens: d * 91 + 300, outputTokens: 1500, videoTokens: d * 91 } };
    },
  };
}
