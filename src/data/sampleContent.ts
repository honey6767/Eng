/**
 * 테스트용 샘플 학습 콘텐츠
 *
 * ⚠️ 실제 유튜브 재생목록의 영상 내용이 아니다.
 * 앱의 저장·표시·통계 기능을 확인하기 위해 직접 작성한 예시이며,
 * 모든 레코드는 isSample=true 로 저장되어 설정 화면에서 한 번에 삭제할 수 있다.
 */
import type { ContentOrigin, Speaker } from '@/types/models';

export interface SampleExpression {
  key: string;
  text: string;
  meaningKo: string;
}

export interface SampleNote {
  expressionKey: string;
  origin: ContentOrigin;
  meaningKo: string;
  usageContext: string;
  nuance: string;
  examples: { en: string; ko: string }[];
  similar: { expression: string; difference: string }[];
  sourceTimestampSec: number | null;
}

export interface SampleSentence {
  key: string;
  english: string;
  korean: string;
  situation: string;
  expressionKeys: string[];
  timestampSec: number | null;
}

export type SampleSegment = { k: string } | { c: string };

export interface SampleLine {
  speaker: Speaker;
  segments: SampleSegment[];
  korean: string;
}

export interface SampleDialogue {
  key: string;
  title: string;
  situation: string;
  lines: SampleLine[];
  compositionNote?: string;
}

export interface SampleVideo {
  key: string;
  title: string;
  durationSec: number | null;
  status: 'new' | 'in_progress' | 'completed';
  transcript: { status: 'not_attempted' | 'success' | 'failed'; rawText: string; errorMessage?: string } | null;
  notes: SampleNote[];
  sentences: SampleSentence[];
  dialogues: SampleDialogue[];
  leftoverSentenceKeys: string[];
}

export const SAMPLE_EXPRESSIONS: SampleExpression[] = [
  { key: 'running-behind', text: 'running behind', meaningKo: '(일정·시간이) 늦어지다, 밀리다' },
  { key: 'not-a-big-deal', text: 'not a big deal', meaningKo: '별일 아니다, 대수롭지 않다' },
  { key: 'been-meaning-to', text: "I've been meaning to", meaningKo: '(전부터) ~하려고 했었다' },
  { key: 'need-a-hand', text: 'need a hand', meaningKo: '도움이 필요하다' },
  { key: 'makes-two-of-us', text: 'That makes two of us', meaningKo: '나도 그래, 나도 마찬가지야' },
  { key: 'grab-a-bite', text: 'grab a bite', meaningKo: '간단히 뭘 먹다' },
  { key: 'down-for', text: "I'm down for", meaningKo: '~ 좋아, ~할 의향 있어' },
  { key: 'take-your-word', text: 'take your word for it', meaningKo: '네 말을 믿다' },
  { key: 'cant-go-wrong', text: "can't go wrong with", meaningKo: '~라면 실패할 일 없다, 무조건 괜찮다' },
  { key: 'slip-my-mind', text: 'slip my mind', meaningKo: '깜빡 잊다' },
];

export const SAMPLE_VIDEOS: SampleVideo[] = [
  {
    key: 'v1',
    title: '[샘플] 친구와 나누는 일상 안부 표현 5가지',
    durationSec: 14 * 60 + 32,
    status: 'completed',
    transcript: {
      status: 'success',
      rawText: [
        "00:15 Today we're going to look at five everyday expressions.",
        "00:42 First, \"running behind.\" You use it when you're late or your schedule is delayed.",
        "01:30 Next, \"not a big deal.\" It means something isn't important or serious.",
        "02:18 \"I've been meaning to\" — you planned to do something but haven't done it yet.",
        "03:05 \"Need a hand\" simply means need help.",
        "03:50 And \"That makes two of us\" means \"me too.\"",
      ].join('\n'),
    },
    notes: [
      {
        expressionKey: 'running-behind',
        origin: 'video',
        meaningKo: '(일정·시간이) 늦어지다, 밀리다',
        usageContext: '약속 시간에 늦거나 하루 일정이 예정보다 밀릴 때',
        nuance: "'late'보다 부드럽고, 일정 전체가 조금씩 밀리고 있다는 느낌",
        examples: [{ en: "Sorry, I'm running behind. I'll be there in ten.", ko: '미안, 좀 늦어지고 있어. 10분 뒤에 도착해.' }],
        similar: [],
        sourceTimestampSec: 42,
      },
      {
        expressionKey: 'running-behind',
        origin: 'ai_supplement',
        meaningKo: '(일정·시간이) 늦어지다, 밀리다',
        usageContext: '업무 마감, 프로젝트 일정이 늦어질 때도 사용',
        nuance: "'behind schedule'은 좀 더 공식적인 표현",
        examples: [{ en: "We're running a little behind schedule.", ko: '일정이 조금 밀리고 있어요.' }],
        similar: [{ expression: 'be late', difference: '정해진 시간을 이미 넘겼다는 사실에 초점' }],
        sourceTimestampSec: null,
      },
      {
        expressionKey: 'not-a-big-deal',
        origin: 'video',
        meaningKo: '별일 아니다, 대수롭지 않다',
        usageContext: '상대가 사과하거나 걱정할 때 안심시키며',
        nuance: '가볍고 친근한 말투. 상대의 부담을 덜어주는 느낌',
        examples: [{ en: "Don't worry, it's not a big deal.", ko: '걱정 마, 별일 아니야.' }],
        similar: [{ expression: 'No worries', difference: '사과·감사에 대한 짧은 대답으로 더 자주 쓰임' }],
        sourceTimestampSec: 90,
      },
      {
        expressionKey: 'been-meaning-to',
        origin: 'video',
        meaningKo: '(전부터) ~하려고 했었다',
        usageContext: '하려고 마음먹었지만 아직 못 한 일을 말할 때',
        nuance: '계속 마음에 두고 있었다는 느낌을 줌',
        examples: [{ en: "I've been meaning to call you.", ko: '안 그래도 너한테 전화하려고 했어.' }],
        similar: [],
        sourceTimestampSec: 138,
      },
      {
        expressionKey: 'need-a-hand',
        origin: 'video',
        meaningKo: '도움이 필요하다',
        usageContext: '짐 옮기기, 이사, 작업 등 손이 필요한 일',
        nuance: "'help'보다 일상적이고 친근함",
        examples: [{ en: 'Do you need a hand with those bags?', ko: '그 가방들 드는 거 도와줄까?' }],
        similar: [],
        sourceTimestampSec: 185,
      },
      {
        expressionKey: 'makes-two-of-us',
        origin: 'video',
        meaningKo: '나도 그래, 나도 마찬가지야',
        usageContext: '상대의 감정·상황에 공감할 때',
        nuance: "'Me too'보다 맞장구치는 느낌이 강함",
        examples: [{ en: "I'm exhausted. — That makes two of us.", ko: '나 너무 피곤해. — 나도 그래.' }],
        similar: [{ expression: 'Same here', difference: '더 짧고 캐주얼함' }],
        sourceTimestampSec: 230,
      },
    ],
    sentences: [
      { key: 'v1s1', english: "I'm running a bit behind today.", korean: '오늘 일정이 좀 밀렸어.', situation: '약속에 조금 늦었을 때', expressionKeys: ['running-behind'], timestampSec: 300 },
      { key: 'v1s2', english: "It's not a big deal.", korean: '별일 아니야.', situation: '상대의 사과에 괜찮다고 할 때', expressionKeys: ['not-a-big-deal'], timestampSec: 342 },
      { key: 'v1s3', english: "I've been meaning to ask you about that.", korean: '안 그래도 그거 물어보려고 했어.', situation: '궁금했던 일을 꺼낼 때', expressionKeys: ['been-meaning-to'], timestampSec: 381 },
      { key: 'v1s4', english: 'Let me know if you need a hand.', korean: '도움 필요하면 말해.', situation: '친구에게 도움을 제안할 때', expressionKeys: ['need-a-hand'], timestampSec: 420 },
      { key: 'v1s5', english: 'That makes two of us.', korean: '나도 마찬가지야.', situation: '상대 말에 공감할 때', expressionKeys: ['makes-two-of-us'], timestampSec: 455 },
    ],
    dialogues: [
      {
        key: 'v1d1',
        title: '늦게 온 친구와 이사 이야기',
        situation: '카페에서 만난 두 친구. A가 조금 늦게 도착하고, 최근 이사한 B의 근황을 묻는다.',
        lines: [
          { speaker: 'A', segments: [{ c: 'Hey, sorry!' }, { k: 'v1s1' }], korean: '미안! 오늘 일정이 좀 밀렸어.' },
          { speaker: 'B', segments: [{ k: 'v1s2' }, { c: 'I just got here, too.' }], korean: '별일 아니야. 나도 방금 왔어.' },
          { speaker: 'A', segments: [{ c: "Oh, by the way, how's the new place?" }, { k: 'v1s3' }], korean: '아, 그런데 새 집은 어때? 안 그래도 그거 물어보려고 했어.' },
          { speaker: 'B', segments: [{ c: "It's nice, but I still have boxes everywhere. Unpacking is taking forever." }], korean: '좋긴 한데, 아직 여기저기 상자가 그대로야. 짐 푸는 게 끝이 안 나.' },
          { speaker: 'A', segments: [{ c: 'Ugh, I can imagine.' }, { k: 'v1s4' }], korean: '으, 어떤지 알 것 같아. 도움 필요하면 말해.' },
          { speaker: 'B', segments: [{ c: "Thanks, I might take you up on that. Honestly, I'm so ready for this week to be over." }], korean: '고마워, 진짜 부탁할지도 몰라. 솔직히 이번 주가 빨리 끝났으면 좋겠어.' },
          { speaker: 'A', segments: [{ k: 'v1s5' }], korean: '나도 마찬가지야.' },
        ],
        compositionNote: '핵심 문장 5개를 모두 하나의 대화문에 원문 그대로 사용했습니다.',
      },
    ],
    leftoverSentenceKeys: [],
  },
  {
    key: 'v2',
    title: '[샘플] 약속 잡을 때 쓰는 표현 5가지',
    durationSec: 12 * 60 + 8,
    status: 'in_progress',
    transcript: {
      status: 'failed',
      rawText: '',
      errorMessage: '샘플: 자막을 가져오지 못한 상태 예시입니다. (2단계에서 자막 붙여넣기 기능 제공 예정)',
    },
    notes: [],
    sentences: [
      { key: 'v2s1', english: 'Do you want to grab a bite later?', korean: '이따 간단히 뭐 좀 먹을래?', situation: '친구에게 식사를 제안할 때', expressionKeys: ['grab-a-bite'], timestampSec: null },
      { key: 'v2s2', english: "I'm down for whatever.", korean: '난 뭐든 좋아.', situation: '상대의 제안에 무엇이든 괜찮다고 할 때', expressionKeys: ['down-for'], timestampSec: null },
      { key: 'v2s3', english: "I'll take your word for it.", korean: '네 말 믿어볼게.', situation: '직접 경험해보진 않았지만 상대 말을 믿을 때', expressionKeys: ['take-your-word'], timestampSec: null },
      { key: 'v2s4', english: "You can't go wrong with that.", korean: '그건 무조건 괜찮아.', situation: '확실한 선택을 추천할 때', expressionKeys: ['cant-go-wrong'], timestampSec: null },
      { key: 'v2s5', english: 'It completely slipped my mind.', korean: '완전히 깜빡했어.', situation: '해야 할 일을 잊었을 때', expressionKeys: ['slip-my-mind'], timestampSec: null },
    ],
    dialogues: [
      {
        key: 'v2d1',
        title: '저녁 메뉴 정하기',
        situation: '퇴근 무렵 메신저로 대화하는 두 친구. 저녁을 같이 먹기로 하고 식당을 고른다.',
        lines: [
          { speaker: 'A', segments: [{ k: 'v2s1' }], korean: '이따 간단히 뭐 좀 먹을래?' },
          { speaker: 'B', segments: [{ c: 'Sure!' }, { k: 'v2s2' }, { c: 'Where do you want to go?' }], korean: '좋아! 난 뭐든 좋아. 어디 가고 싶어?' },
          { speaker: 'A', segments: [{ c: "There's a new taco place near my office. Everyone says it's amazing." }], korean: '회사 근처에 타코집이 새로 생겼어. 다들 엄청 맛있대.' },
          { speaker: 'B', segments: [{ c: "I've never been there, but" }, { k: 'v2s3' }], korean: '가본 적은 없지만, 네 말 믿어볼게.' },
          { speaker: 'A', segments: [{ c: 'Get the fish tacos.' }, { k: 'v2s4' }], korean: '피시 타코 시켜. 그건 무조건 맛있어.' },
        ],
        compositionNote: '핵심 문장 1~4를 원문 그대로 사용했습니다.',
      },
      {
        key: 'v2d2',
        title: '깜빡한 부탁',
        situation: '함께 사는 룸메이트. B가 집주인에게 연락하기로 한 일을 잊어버렸다.',
        lines: [
          { speaker: 'A', segments: [{ c: 'Hey, did you call the landlord about the heater?' }], korean: '야, 집주인한테 히터 얘기 전화했어?' },
          { speaker: 'B', segments: [{ c: 'Oh no.' }, { k: 'v2s5' }, { c: "I'm so sorry." }], korean: '아 이런, 완전히 깜빡했어. 진짜 미안.' },
          { speaker: 'A', segments: [{ c: "It's okay. Can you call first thing tomorrow? It's getting really cold in here." }], korean: '괜찮아. 내일 아침에 제일 먼저 전화해 줄래? 집이 점점 너무 추워져.' },
          { speaker: 'B', segments: [{ c: "Definitely. I'll set a reminder right now." }], korean: '당연하지. 지금 바로 알림 맞춰 둘게.' },
        ],
        compositionNote:
          "‘It completely slipped my mind.’는 저녁 약속 대화에 넣으면 흐름이 어색해져 별도 상황(룸메이트 대화)으로 분리했습니다. (우선순위 2: 대화문 2개)",
      },
    ],
    leftoverSentenceKeys: [],
  },
  {
    key: 'v3',
    title: '[샘플] 아직 학습하지 않은 신규 영상',
    durationSec: null,
    status: 'new',
    transcript: null,
    notes: [],
    sentences: [],
    dialogues: [],
    leftoverSentenceKeys: [],
  },
];

/**
 * 샘플 복습 상태 — 우선순위 표시와 대시보드 통계를 확인하기 위한 예시 이력.
 * dueInDays: 음수/0이면 오늘 복습 대상
 */
export interface SampleReview {
  type: 'expression' | 'dialogue';
  key: string;
  correct: number;
  wrong: number;
  last: 'wrong' | 'hard' | 'easy';
  weakness: number;
  streak: number;
  intervalIndex: number;
  lastStudiedDaysAgo: number;
  dueInDays: number;
}

export const SAMPLE_REVIEWS: SampleReview[] = [
  { type: 'expression', key: 'makes-two-of-us', correct: 1, wrong: 3, last: 'wrong', weakness: 85, streak: 0, intervalIndex: 0, lastStudiedDaysAgo: 1, dueInDays: 0 },
  { type: 'expression', key: 'been-meaning-to', correct: 2, wrong: 1, last: 'wrong', weakness: 65, streak: 0, intervalIndex: 0, lastStudiedDaysAgo: 2, dueInDays: -1 },
  { type: 'expression', key: 'take-your-word', correct: 2, wrong: 0, last: 'hard', weakness: 55, streak: 0, intervalIndex: 1, lastStudiedDaysAgo: 1, dueInDays: 0 },
  { type: 'expression', key: 'need-a-hand', correct: 3, wrong: 0, last: 'easy', weakness: 20, streak: 3, intervalIndex: 3, lastStudiedDaysAgo: 1, dueInDays: 6 },
  { type: 'expression', key: 'running-behind', correct: 2, wrong: 1, last: 'easy', weakness: 35, streak: 1, intervalIndex: 2, lastStudiedDaysAgo: 2, dueInDays: 1 },
  { type: 'expression', key: 'not-a-big-deal', correct: 4, wrong: 0, last: 'easy', weakness: 10, streak: 4, intervalIndex: 4, lastStudiedDaysAgo: 3, dueInDays: 11 },
  { type: 'expression', key: 'cant-go-wrong', correct: 1, wrong: 1, last: 'hard', weakness: 50, streak: 0, intervalIndex: 1, lastStudiedDaysAgo: 0, dueInDays: 1 },
  { type: 'dialogue', key: 'v1d1', correct: 3, wrong: 1, last: 'easy', weakness: 30, streak: 2, intervalIndex: 2, lastStudiedDaysAgo: 3, dueInDays: 0 },
  { type: 'dialogue', key: 'v2d1', correct: 1, wrong: 0, last: 'hard', weakness: 45, streak: 0, intervalIndex: 1, lastStudiedDaysAgo: 0, dueInDays: 1 },
];

/** 샘플 5단계 진행도 */
export const SAMPLE_PROGRESS: { dialogueKey: string; highest: 0 | 1 | 2 | 3 | 4 | 5; memorized: boolean }[] = [
  { dialogueKey: 'v1d1', highest: 5, memorized: true },
  { dialogueKey: 'v2d1', highest: 2, memorized: false },
];

/** 샘플 학습 기록: [며칠 전, 기록 수] — 주간 학습량 그래프 확인용 */
export const SAMPLE_STUDY_DAYS: [number, number][] = [
  [6, 4],
  [5, 7],
  [3, 5],
  [2, 9],
  [1, 6],
  [0, 3],
];
