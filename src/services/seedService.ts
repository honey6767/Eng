import type { Repositories } from '@/repositories/types';
import type {
  Dialogue,
  DialogueComposition,
  DialogueLine,
  DialogueProgress,
  ExpressionNote,
  KeySentence,
  Playlist,
  ReviewState,
  StudyLog,
  Transcript,
  Video,
} from '@/types/models';
import {
  SAMPLE_EXPRESSIONS,
  SAMPLE_PROGRESS,
  SAMPLE_REVIEWS,
  SAMPLE_STUDY_DAYS,
  SAMPLE_VIDEOS,
} from '@/data/sampleContent';
import { createId } from '@/utils/id';
import { addDays, toDateKey } from '@/utils/date';
import { reviewStateId } from './scheduler';
import { parseTranscript } from './transcriptParser';

export const META_INITIALIZED = 'initializedAt';
export const META_SAMPLE_SEEDED = 'sampleSeededAt';
export const META_SCHEMA_VERSION = 'schemaVersion';

/**
 * 샘플 데이터를 저장한다. 이미 샘플이 있으면 아무것도 하지 않는다.
 * 사용자의 기존 표현과 같은 표현이 있으면 중복 생성하지 않고 출처만 누적한다.
 */
export async function seedSampleData(repos: Repositories, now = new Date()): Promise<boolean> {
  if (await repos.maintenance.hasSampleData()) return false;

  const iso = now.toISOString();
  const base = { createdAt: iso, updatedAt: iso, isSample: true as const };

  const playlist: Playlist = {
    id: createId(),
    ...base,
    url: '',
    youtubePlaylistId: null,
    title: '[샘플] 테스트용 재생목록',
    lastSyncedAt: null,
    syncStatus: 'never',
  };

  const videos: Video[] = [];
  const transcripts: Transcript[] = [];
  const notes: ExpressionNote[] = [];
  const sentences: KeySentence[] = [];
  const dialogues: Dialogue[] = [];
  const compositions: DialogueComposition[] = [];

  const videoIdByKey = new Map<string, string>();
  const sentenceIdByKey = new Map<string, string>();
  const dialogueIdByKey = new Map<string, string>();
  const expressionIdByKey = new Map<string, string>();

  // 1) 영상 id 먼저 할당 (표현 출처 연결용)
  SAMPLE_VIDEOS.forEach((sv) => videoIdByKey.set(sv.key, createId()));
  SAMPLE_VIDEOS.forEach((sv) => sv.sentences.forEach((s) => sentenceIdByKey.set(s.key, createId())));

  // 2) 표현 — 중복 없이 upsert (출처 영상/문장 누적)
  for (const se of SAMPLE_EXPRESSIONS) {
    const ownerVideo = SAMPLE_VIDEOS.find((v) => v.sentences.some((s) => s.expressionKeys.includes(se.key)));
    const ownerSentence = ownerVideo?.sentences.find((s) => s.expressionKeys.includes(se.key));
    const expr = await repos.expressions.upsert({
      text: se.text,
      meaningKo: se.meaningKo,
      sourceRef: ownerVideo
        ? { videoId: videoIdByKey.get(ownerVideo.key)!, sentenceId: ownerSentence ? sentenceIdByKey.get(ownerSentence.key)! : null }
        : undefined,
      isSample: true,
    });
    expressionIdByKey.set(se.key, expr.id);
  }

  SAMPLE_VIDEOS.forEach((sv, index) => {
    const videoId = videoIdByKey.get(sv.key)!;
    const completed = sv.status === 'completed';
    videos.push({
      id: videoId,
      ...base,
      playlistId: playlist.id,
      youtubeVideoId: null,
      title: sv.title,
      url: null,
      thumbnailUrl: null,
      durationSec: sv.durationSec,
      orderIndex: index,
      randomOrderKey: Math.random(),
      status: sv.status,
      completedAt: completed ? addDays(now, -3).toISOString() : null,
    });

    if (sv.transcript) {
      transcripts.push({
        id: createId(),
        ...base,
        videoId,
        source: 'manual_paste',
        status: sv.transcript.status,
        rawText: sv.transcript.rawText,
        segments: sv.transcript.rawText ? parseTranscript(sv.transcript.rawText) : [],
        errorMessage: sv.transcript.errorMessage,
      });
    }

    sv.notes.forEach((n, i) => {
      const expr = SAMPLE_EXPRESSIONS.find((e) => e.key === n.expressionKey)!;
      notes.push({
        id: createId(),
        ...base,
        videoId,
        expressionId: expressionIdByKey.get(n.expressionKey) ?? null,
        expression: expr.text,
        meaningKo: n.meaningKo,
        usageContext: n.usageContext,
        nuance: n.nuance,
        examples: n.examples,
        similar: n.similar,
        sourceTimestampSec: n.sourceTimestampSec,
        origin: n.origin,
        verification: 'confirmed',
        order: i,
      });
    });

    sv.sentences.forEach((s, i) => {
      sentences.push({
        id: sentenceIdByKey.get(s.key)!,
        ...base,
        videoId,
        order: i + 1,
        english: s.english,
        korean: s.korean,
        expressionIds: s.expressionKeys.map((k) => expressionIdByKey.get(k)!),
        situation: s.situation,
        timestampSec: s.timestampSec,
        status: completed ? 'reviewing' : sv.status === 'in_progress' ? 'learning' : 'not_started',
        correctCount: completed ? 3 : sv.status === 'in_progress' ? 1 : 0,
        wrongCount: completed ? 1 : 0,
      });
    });

    sv.dialogues.forEach((sd, i) => {
      const dialogueId = createId();
      dialogueIdByKey.set(sd.key, dialogueId);
      const exprIds = new Set<string>();
      const lines: DialogueLine[] = sd.lines.map((l, li) => ({
        id: createId(),
        order: li,
        speaker: l.speaker,
        korean: l.korean,
        segments: l.segments.map((seg) => {
          if ('k' in seg) {
            const sentence = sv.sentences.find((s) => s.key === seg.k)!;
            sentence.expressionKeys.forEach((k) => exprIds.add(expressionIdByKey.get(k)!));
            return { kind: 'key' as const, text: sentence.english, keySentenceId: sentenceIdByKey.get(seg.k)! };
          }
          return { kind: 'connector' as const, text: seg.c };
        }),
      }));
      dialogues.push({
        id: dialogueId,
        ...base,
        // 대화문 정렬을 위해 생성 시각을 조금씩 다르게
        createdAt: new Date(now.getTime() + index * 1000 + i).toISOString(),
        kind: 'original',
        videoId,
        sourceVideoIds: [videoId],
        orderInVideo: i + 1,
        title: sd.title,
        situation: sd.situation,
        lines,
        expressionIds: [...exprIds],
        generatedBy: 'sample',
        compositionNote: sd.compositionNote,
        isFavorite: false,
      });
    });

    if (sv.dialogues.length > 0) {
      compositions.push({
        id: createId(),
        ...base,
        videoId,
        dialogueIds: sv.dialogues.map((d) => dialogueIdByKey.get(d.key)!),
        leftoverSentenceIds: sv.leftoverSentenceKeys.map((k) => sentenceIdByKey.get(k)!),
      });
    }
  });

  const reviewStates: ReviewState[] = SAMPLE_REVIEWS.map((r) => {
    const itemId = r.type === 'expression' ? expressionIdByKey.get(r.key)! : dialogueIdByKey.get(r.key)!;
    return {
      id: reviewStateId(r.type, itemId),
      itemType: r.type,
      itemId,
      correctCount: r.correct,
      wrongCount: r.wrong,
      lastResult: r.last,
      lastStudiedAt: addDays(now, -r.lastStudiedDaysAgo).toISOString(),
      nextReviewAt: addDays(now, r.dueInDays).toISOString(),
      weakness: r.weakness,
      streak: r.streak,
      intervalIndex: r.intervalIndex,
      reviewCount: r.correct + r.wrong,
      lastQuizzedAt: null,
      isSample: true,
    };
  });
  // 오늘 복습 대상은 '지금 이전' 시각으로 맞춘다
  reviewStates.forEach((s) => {
    if (s.nextReviewAt && toDateKey(s.nextReviewAt) <= toDateKey(now)) {
      s.nextReviewAt = new Date(Math.min(new Date(s.nextReviewAt).getTime(), now.getTime() - 60_000)).toISOString();
    }
  });

  const progress: DialogueProgress[] = SAMPLE_PROGRESS.map((p) => {
    const dialogueId = dialogueIdByKey.get(p.dialogueKey)!;
    const stepResults = Array.from({ length: p.highest }, (_, i) => ({
      step: (i + 1) as 1 | 2 | 3 | 4 | 5,
      accuracy: Math.min(1, 0.7 + i * 0.06),
      rating: i === p.highest - 1 ? ('easy' as const) : null,
      completedAt: addDays(now, -(p.highest - i)).toISOString(),
    }));
    return {
      id: dialogueId,
      dialogueId,
      currentStep: (Math.min(5, p.highest + 1) || 1) as 1 | 2 | 3 | 4 | 5,
      highestCompletedStep: p.highest,
      stepResults,
      memorized: p.memorized,
      memorizedAt: p.memorized ? addDays(now, -3).toISOString() : null,
      blankMastery: {},
      updatedAt: iso,
      isSample: true,
    };
  });

  const studyItemIds = [...expressionIdByKey.values()];
  const studyLogs: StudyLog[] = [];
  for (const [daysAgo, count] of SAMPLE_STUDY_DAYS) {
    for (let i = 0; i < count; i++) {
      const t = addDays(now, -daysAgo);
      t.setMinutes(t.getMinutes() - i * 3);
      studyLogs.push({
        id: createId(),
        timestamp: t.toISOString(),
        date: toDateKey(t),
        activity: 'expression_review',
        itemType: 'expression',
        itemId: studyItemIds[i % studyItemIds.length],
        rating: i % 4 === 0 ? 'wrong' : i % 3 === 0 ? 'hard' : 'easy',
        isReview: daysAgo > 0 || i % 2 === 0,
        isSample: true,
      });
    }
  }

  await repos.maintenance.bulkInsert({
    playlists: [playlist],
    videos,
    transcripts,
    expressionNotes: notes,
    keySentences: sentences,
    dialogues,
    dialogueCompositions: compositions,
    reviewStates,
    dialogueProgress: progress,
    studyLogs,
  });
  await repos.meta.set(META_SAMPLE_SEEDED, iso);
  return true;
}

/**
 * 앱 최초 실행 시 초기화: 처음 한 번만 샘플 데이터를 넣는다.
 * 사용자가 샘플을 삭제한 뒤에는 다시 자동으로 넣지 않는다.
 */
export async function initializeApp(repos: Repositories, schemaVersion: number): Promise<void> {
  const initialized = await repos.meta.get<string>(META_INITIALIZED);
  if (!initialized) {
    await seedSampleData(repos);
    await repos.meta.set(META_INITIALIZED, new Date().toISOString());
  }
  await repos.meta.set(META_SCHEMA_VERSION, schemaVersion);
}
