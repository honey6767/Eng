import { describe, expect, it } from 'vitest';
import { createTestRepos } from '@/test/helpers';
import type { Repositories } from '@/repositories/types';
import { addKeySentence, linkExpression } from './keySentenceService';
import {
  applyAiNotesResult,
  buildNotesPrompt,
  NoteError,
  parseAiNotesResponse,
  saveExpressionNote,
  type NoteInput,
} from './expressionNoteService';

async function setup(repos: Repositories) {
  const [r] = await repos.videos.upsertFromYouTube(
    [{ youtubeVideoId: 'abcdefghijk', title: '약속 표현', channelTitle: null, thumbnailUrl: null, durationSec: 300, metadataSource: 'youtube_api' }],
    { kind: 'manual' },
  );
  const v = r.video;
  const s1 = await addKeySentence(repos, v.id, { english: 'It completely slipped my mind.', origin: 'manual' });
  const s2 = await addKeySentence(repos, v.id, { english: "I'll take your word for it.", korean: '네 말 믿을게.', origin: 'manual' });
  await linkExpression(repos, s1.id, { text: 'slip my mind', meaningKo: '깜빡 잊다' });
  return { v, s1, s2 };
}

const note = (over: Partial<NoteInput> = {}): NoteInput => ({
  expression: 'slip my mind',
  meaningKo: '깜빡 잊다',
  usageContext: '약속을 잊었을 때',
  nuance: "'forget'보다 부드러움",
  examples: [{ en: 'Sorry, it slipped my mind.', ko: '미안, 깜빡했어.' }, { en: '  ', ko: '' }],
  similar: [{ expression: 'forget', difference: '더 직접적' }],
  sourceTimestampSec: 95,
  origin: 'video',
  verification: 'confirmed',
  ...over,
});

describe('3단계 핵심 표현 노트', () => {
  it('노트를 저장하고 같은 표현 레코드에 연결한다 (빈 예문 제거)', async () => {
    const { repos } = createTestRepos();
    const { v } = await setup(repos);
    const n = await saveExpressionNote(repos, v.id, note());
    expect(n.examples).toHaveLength(1);
    expect(n.order).toBe(0);
    const exprs = (await repos.expressions.list()).filter((e) => e.normalizedKey === 'slip my mind');
    expect(exprs).toHaveLength(1);
    expect(n.expressionId).toBe(exprs[0].id);

    const edited = await saveExpressionNote(repos, v.id, note({ nuance: '수정됨' }), n.id);
    expect(edited.nuance).toBe('수정됨');
    expect(await repos.expressionNotes.listByVideo(v.id)).toHaveLength(1);
  });

  it('AI 보충은 항상 확인 필요로 저장되고, 필수 칸이 없으면 거부한다', async () => {
    const { repos } = createTestRepos();
    const { v } = await setup(repos);
    const n = await saveExpressionNote(repos, v.id, note({ origin: 'ai_supplement', verification: 'confirmed' }));
    expect(n.verification).toBe('needs_check');
    await expect(saveExpressionNote(repos, v.id, note({ meaningKo: ' ' }))).rejects.toBeInstanceOf(NoteError);
  });

  it('요청문에 핵심 문장이 원문 그대로 들어간다', async () => {
    const { repos } = createTestRepos();
    const { v } = await setup(repos);
    const sentences = await repos.keySentences.listByVideo(v.id);
    const exprs = await repos.expressions.list();
    const prompt = buildNotesPrompt(v, sentences, (id) => exprs.find((e) => e.id === id)?.text);
    expect(prompt).toContain('1. "It completely slipped my mind."  — 핵심 표현: "slip my mind"');
    expect(prompt).toContain(`2. "I'll take your word for it."`);
    expect(prompt).toContain('절대 바꾸거나 다시 쓰지 마세요');
  });

  it('AI 답변 해석: 코드 블록·앞뒤 설명 허용, 잘못된 항목은 문제로 보고', () => {
    const text = `물론이죠! 아래는 결과입니다.
\`\`\`json
{ "sentences": [{ "order": 1, "korean": "완전히 깜빡했어.", "situation": "잊었을 때" }, { "order": 9 }],
  "notes": [
    { "expression": "slip my mind", "meaningKo": "깜빡 잊다", "examples": [{ "en": "It slipped my mind.", "ko": "깜빡했어." }] },
    { "expression": "", "meaningKo": "x" }
  ] }
\`\`\`
도움이 되었길 바랍니다.`;
    const r = parseAiNotesResponse(text);
    expect(r.sentences).toEqual([{ order: 1, korean: '완전히 깜빡했어.', situation: '잊었을 때' }]);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatchObject({ origin: 'ai_supplement', verification: 'needs_check' });
    expect(r.problems).toHaveLength(2);
    expect(() => parseAiNotesResponse('JSON 없음')).toThrow(NoteError);
    expect(() => parseAiNotesResponse('{ "notes": [ { ')).toThrow(NoteError);
  });

  it('AI 결과 반영: 빈 칸만 채우고, 같은 표현의 AI 노트는 중복 저장하지 않으며, 영어 원문은 그대로', async () => {
    const { repos } = createTestRepos();
    const { v, s1, s2 } = await setup(repos);
    const result = parseAiNotesResponse(
      JSON.stringify({
        sentences: [
          { order: 1, korean: '완전히 깜빡했어.', situation: '잊었을 때' },
          { order: 2, korean: 'AI 번역', situation: '믿을 때' },
        ],
        notes: [{ expression: 'slip my mind', meaningKo: '깜빡 잊다' }],
      }),
    );
    const first = await applyAiNotesResult(repos, v.id, result);
    expect(first).toMatchObject({ filledKorean: 1, filledSituation: 2, keptExisting: 1, notesAdded: 1 });
    const again = await applyAiNotesResult(repos, v.id, result);
    expect(again.notesAdded).toBe(0);
    expect(again.notesSkipped).toBe(1);
    const a = (await repos.keySentences.get(s1.id))!;
    const b = (await repos.keySentences.get(s2.id))!;
    expect(a.english).toBe('It completely slipped my mind.');
    expect(a.korean).toBe('완전히 깜빡했어.');
    expect(b.korean).toBe('네 말 믿을게.'); // 사용자가 입력한 번역 유지
  });
});
