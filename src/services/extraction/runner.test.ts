import { describe, expect, it } from 'vitest';
import { handleAiExtract, type AiCaps } from '../../../server/ai/extractHandler.ts';
import { memoryLedgerStore } from '../../../server/ai/ledger.ts';
import { createMockGemini } from '../../../server/ai/mockGemini.ts';
import { TABLE_NAMES, V2_TABLE_NAMES, type StudyDatabase } from '@/db/database';
import { createExtractionStore } from '@/repositories/extractionStore';
import type { AiClient, AiTransportResult } from '@/services/integrations/aiClient';
import { createTestRepos } from '@/test/helpers';
import { createExtractionController } from './controller';
import { pickNext, stepJob, syncJobs } from './runner';
import { validateExtraction } from './validateResult';

const T0 = new Date('2026-11-15T12:00:00Z');
const base = { createdAt: T0.toISOString(), updatedAt: T0.toISOString() };
let uuidSeq = 0;
const newId = () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`;

/** 서버(장부 + 가짜 Gemini)를 같은 프로세스에서 — 앱 → 서버 흐름을 그대로 시험 (실제 Google 호출 없음) */
function fakeServer(caps: AiCaps = { dailyVideoSec: 6 * 3600, dailyRequests: 50, maxVideoSec: 1800 }) {
  const ledger = memoryLedgerStore();
  const gemini = createMockGemini();
  const sent: string[] = [];
  let offline = false;
  const client: AiClient = {
    async extract(requestId, req): Promise<AiTransportResult> {
      sent.push(requestId);
      if (offline) return { kind: 'transport_error', message: 'offline' };
      const r = await handleAiExtract({ idempotencyKey: requestId, body: req }, { store: ledger, gemini, caps, now: () => T0.getTime() });
      return { kind: 'response', httpStatus: r.status, body: r.body };
    },
  };
  return { client, gemini, ledger, sent, setOffline: (v: boolean) => (offline = v) };
}

async function seed(db: StudyDatabase, ids: { id: string; yt: string; dur: number | null; transcript?: boolean; sample?: boolean }[]) {
  await db.videos.bulkAdd(
    ids.map((v, i) => ({
      id: v.id, ...base, playlistId: null, youtubeVideoId: v.yt, title: `[Day ${i + 1}] ${v.id}`, url: null, thumbnailUrl: null, durationSec: v.dur, orderIndex: i,
      randomOrderKey: 0.1, status: 'new' as const, completedAt: null, sources: [{ kind: 'manual' as const, addedAt: base.createdAt }], channelTitle: null, captionCheck: null,
      metadataSource: 'manual' as const, ...(v.sample ? { isSample: true } : {}),
    })),
  );
  for (const v of ids.filter((x) => x.transcript)) {
    await db.transcripts.add({ id: `tr-${v.id}`, ...base, videoId: v.id, source: 'manual_paste', status: 'success', rawText: 'x', segments: [], format: 'plain' } as never);
  }
}

async function dumpExisting(db: StudyDatabase) {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const t of V2_TABLE_NAMES) out[t] = (await db.table(t).toArray()).filter((r: Record<string, unknown>) => r.key !== 'extractionRun');
  return out;
}
/** 전에 있던 레코드는 하나도 바뀌거나 사라지지 않았는지 (새로 추가된 것은 따로 돌려줌) */
function assertOnlyAdded(before: Record<string, Record<string, unknown>[]>, after: Record<string, Record<string, unknown>[]>) {
  const added: Record<string, number> = {};
  for (const t of Object.keys(before)) {
    const pk = (r: Record<string, unknown>) => String(t === 'appMeta' ? r.key : r.id);
    const a = new Map(after[t].map((r) => [pk(r), JSON.stringify(r)]));
    for (const r of before[t]) expect(a.get(pk(r)), `${t} ${pk(r)}`).toBe(JSON.stringify(r));
    added[t] = after[t].length - before[t].length;
  }
  return added;
}

const noSleep = async () => {};

describe('자동 자막 추출 실행기 (격리된 테스트 DB + 같은 프로세스의 서버·가짜 Gemini)', () => {
  it('자막 없는 영상만 대상: 자막 있는 영상·샘플은 제외, 긴 영상·길이 모르는 영상은 건너뜀으로 표시', async () => {
    const { db } = createTestRepos();
    await seed(db, [
      { id: 'a', yt: 'aaaaaaaaaaa', dur: 300 },
      { id: 'b', yt: 'bbbbbbbbbbb', dur: 300, transcript: true },
      { id: 'c', yt: 'ccccccccccc', dur: 300, sample: true },
      { id: 'd', yt: 'ddddddddddd', dur: 9 * 3600 },
      { id: 'e', yt: 'eeeeeeeeeee', dur: null },
    ]);
    const store = createExtractionStore(db);
    await syncJobs({ store, client: fakeServer().client });
    await syncJobs({ store, client: fakeServer().client }); // 다시 해도 중복 없음
    const jobs = await db.extractionJobs.toArray();
    expect(jobs.map((j) => [j.videoId, j.status, j.lastError?.code ?? null]).sort()).toEqual([
      ['a', 'queued', null],
      ['d', 'skipped', 'too_long'],
      ['e', 'skipped', 'no_duration'],
    ]);
  });

  it('학습 시작 → 모두 완료: 영상당 생성 1회, 결과는 초안으로 저장, 기존 테이블 쓰기 0건, 다시 시작해도 재호출 없음', async () => {
    const { db } = createTestRepos();
    await seed(db, [
      { id: 'a', yt: 'aaaaaaaaaaa', dur: 295 },
      { id: 'b', yt: 'bbbbbbbbbbb', dur: 240 },
      { id: 'c', yt: 'mockSlow001', dur: 200 },
    ]);
    const before = await dumpExisting(db);
    const srv = fakeServer();
    const store = createExtractionStore(db);
    const ctl = createExtractionController({ store, client: srv.client, newId, now: () => T0, sleep: noSleep, withLock: async (fn) => (await fn(), true) });
    await ctl.start();
    expect(ctl.getSnapshot().status.kind).toBe('done');
    expect(srv.gemini.createCalls.sort()).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'mockSlow001']);
    const drafts = await db.extractionDrafts.toArray();
    expect(drafts).toHaveLength(3);
    // 품질이 괜찮은 결과는 자동으로 학습 자료에 연결 (B1-d)
    expect(drafts.every((d) => d.status === 'approved' && typeof d.rawText === 'string')).toBe(true);
    const reqs = await db.aiRequests.toArray();
    expect(reqs.every((r) => r.status === 'succeeded')).toBe(true);
    expect(new Set(reqs.map((r) => r.videoId)).size).toBe(3);
    // 기존 레코드는 그대로, 자막 3개·표현 2개(같은 표현은 하나로 합침)만 새로 추가
    const added = assertOnlyAdded(before, await dumpExisting(db));
    expect(added).toMatchObject({ transcripts: 3, expressions: 2, videos: 0, keySentences: 0, reviewStates: 0, studyLogs: 0 });
    expect(await db.learningItems.count()).toBe(6);
    expect((await db.appMeta.get('extractionRun'))?.value).toMatchObject({ active: false });
    // 다시 시작해도 Gemini를 부르지 않는다 (저장된 결과 재사용)
    await ctl.start();
    expect(srv.gemini.createCalls).toHaveLength(3);
  });

  it('앱을 닫았다 열기·네트워크 끊김: 같은 요청 식별자로 이어서 조회, 생성은 늘지 않음', async () => {
    const { db } = createTestRepos();
    await seed(db, [{ id: 'a', yt: 'mockSlow001', dur: 300 }]);
    const srv = fakeServer();
    const store = createExtractionStore(db);
    await syncJobs({ store, client: srv.client });
    // 첫 걸음: 생성 → 진행 중. 여기서 '앱이 닫혔다'고 본다
    const first = (await pickNext(store, T0))!;
    expect((await stepJob(first.job, first.video, { store, client: srv.client, newId, now: () => T0 })).kind).toBe('pending');
    const reqId = (await db.extractionJobs.get(first.job.id))!.currentRequestId!;
    // 네트워크 끊김 → 같은 식별자로 나중에 다시
    srv.setOffline(true);
    const again = (await pickNext(store, T0))!;
    expect((await stepJob(again.job, again.video, { store, client: srv.client, newId, now: () => T0 })).kind).toBe('retry');
    srv.setOffline(false);
    await db.appMeta.put({ key: 'extractionRun', value: { active: true, startedAt: T0.toISOString(), pausedUntil: null, pauseReason: null, pauseMessage: null, updatedAt: T0.toISOString() } });
    // 새로 연 앱: 새 실행기가 이어 간다
    const ctl = createExtractionController({ store, client: srv.client, newId, now: () => T0, sleep: noSleep, withLock: async (fn) => (await fn(), true) });
    await ctl.resumeIfActive();
    expect(srv.gemini.createCalls).toHaveLength(1);
    expect(new Set(srv.sent)).toEqual(new Set([reqId]));
    expect(await db.extractionDrafts.count()).toBe(1);
  });

  it('하루 상한·무료 한도: 유료 전환 없이 멈춤, 처리 안 된 영상은 대기열로 (다음엔 새 식별자)', async () => {
    const { db } = createTestRepos();
    await seed(db, [
      { id: 'a', yt: 'aaaaaaaaaaa', dur: 300 },
      { id: 'q', yt: 'mockQuota01', dur: 300 },
      { id: 'b', yt: 'bbbbbbbbbbb', dur: 300 },
    ]);
    const srv = fakeServer();
    const store = createExtractionStore(db);
    const ctl = createExtractionController({ store, client: srv.client, newId, now: () => T0, sleep: noSleep, withLock: async (fn) => (await fn(), true) });
    await ctl.start();
    const st = ctl.getSnapshot().status;
    expect(st).toMatchObject({ kind: 'paused', reason: 'gemini_quota' });
    const q = (await db.extractionJobs.get('job-q'))!;
    expect(q).toMatchObject({ status: 'queued', currentRequestId: null });
    expect((await db.aiRequests.where('jobId').equals('job-q').toArray())[0].status).toBe('failed_definite');
    expect((await db.extractionJobs.get('job-b'))!.status).toBe('queued'); // 멈춘 뒤에는 더 보내지 않음
    expect(srv.gemini.createCalls).toEqual(['aaaaaaaaaaa', 'mockQuota01']);
    // 서버 하루 상한
    const { db: db2 } = createTestRepos();
    await seed(db2, [{ id: 'x', yt: 'xxxxxxxxxxx', dur: 300 }, { id: 'y', yt: 'yyyyyyyyyyy', dur: 300 }]);
    const srv2 = fakeServer({ dailyVideoSec: 3600, dailyRequests: 1, maxVideoSec: 1800 });
    const ctl2 = createExtractionController({ store: createExtractionStore(db2), client: srv2.client, newId, now: () => T0, sleep: noSleep, withLock: async (fn) => (await fn(), true) });
    await ctl2.start();
    expect(ctl2.getSnapshot().status).toMatchObject({ kind: 'paused', reason: 'daily_cap' });
    expect((await db2.appMeta.get('extractionRun'))?.value).toMatchObject({ active: true, pauseReason: 'daily_cap' });
    expect(srv2.gemini.createCalls).toHaveLength(1);
  });

  it('Gemini 실패(사용했을 수 있음)는 그 영상만 확인 필요로 두고 나머지는 계속, 자동 재요청 없음', async () => {
    const { db } = createTestRepos();
    await seed(db, [
      { id: 'f', yt: 'mockFail001', dur: 300 },
      { id: 'a', yt: 'aaaaaaaaaaa', dur: 300 },
    ]);
    const srv = fakeServer();
    const store = createExtractionStore(db);
    const ctl = createExtractionController({ store, client: srv.client, newId, now: () => T0, sleep: noSleep, withLock: async (fn) => (await fn(), true) });
    await ctl.start();
    expect((await db.extractionJobs.get('job-f'))).toMatchObject({ status: 'failed_permanent', lastError: { code: 'gemini_failed' } });
    expect((await db.extractionJobs.get('job-a'))!.status).toBe('succeeded');
    await ctl.start();
    expect(srv.gemini.createCalls.filter((v) => v === 'mockFail001')).toHaveLength(1);
    expect((await ctl.getSnapshot()).summary).toMatchObject({ succeeded: 1, needsAttention: 1 });
  });

  it('영상 길이를 넘는 타임스탬프는 거부하고 문제로 표시해 초안 저장', async () => {
    const { db } = createTestRepos();
    await seed(db, [{ id: 'o', yt: 'mockOver001', dur: 300 }]);
    const srv = fakeServer();
    const ctl = createExtractionController({ store: createExtractionStore(db), client: srv.client, newId, now: () => T0, sleep: noSleep, withLock: async (fn) => (await fn(), true) });
    await ctl.start();
    const d = (await db.extractionDrafts.toArray())[0];
    const result = d.result as { transcript: { start: number; end: number }[] };
    expect(result.transcript.every((s) => s.end <= 305)).toBe(true);
    expect((d.rejectedSegments ?? []).length).toBe(1);
    expect((d.validation as { code: string }[]).map((i) => i.code)).toContain('timestamp_out_of_range');
  });

  it('6일이 지난 요청은 서버에 다시 묻지 않고 결과 만료로 (같은 영상 두 번 생성 방지)', async () => {
    const { db } = createTestRepos();
    await seed(db, [{ id: 'a', yt: 'aaaaaaaaaaa', dur: 300 }]);
    const srv = fakeServer();
    const store = createExtractionStore(db);
    await syncJobs({ store, client: srv.client });
    const n = (await pickNext(store, T0))!;
    await stepJob(n.job, n.video, { store, client: srv.client, newId, now: () => T0 });
    const later = new Date(T0.getTime() + 7 * 24 * 3_600_000);
    const n2 = (await pickNext(store, later))!;
    const sentBefore = srv.sent.length;
    expect(await stepJob(n2.job, n2.video, { store, client: srv.client, newId, now: () => later })).toEqual({ kind: 'job_stopped', code: 'expired' });
    expect(srv.sent.length).toBe(sentBefore);
  });

  it('다른 탭이 실행 중이면 이 탭은 실행하지 않는다', async () => {
    const { db } = createTestRepos();
    await seed(db, [{ id: 'a', yt: 'aaaaaaaaaaa', dur: 300 }]);
    const srv = fakeServer();
    const ctl = createExtractionController({ store: createExtractionStore(db), client: srv.client, newId, now: () => T0, sleep: noSleep, withLock: async () => false });
    await ctl.start();
    expect(ctl.getSnapshot().status.kind).toBe('other_tab');
    expect(srv.gemini.createCalls).toHaveLength(0);
  });

  it('모든 테이블 목록에 새 테이블이 있다 (백업에 추출 기록 포함)', () => {
    expect(TABLE_NAMES).toEqual(expect.arrayContaining(['extractionJobs', 'aiRequests', 'extractionDrafts']));
  });
});

describe('결과 검사 (validateExtraction)', () => {
  it('깨진 JSON·형식 오류는 저장하지 않음', () => {
    expect(validateExtraction('{not json', 300).ok).toBe(false);
    expect(validateExtraction('{"transcript":1}', 300).ok).toBe(false);
  });
  it('공백·끝부분 누락·낮은 전사 비율·근거 문장 없음·표현 시각 초과를 표시', () => {
    const r = validateExtraction(
      JSON.stringify({
        transcript: [
          { start: 0, end: 5, text: 'a' },
          { start: 100, end: 110, text: 'b' },
        ],
        keyExpressions: [{ text: 'x', meaningKo: '', sourceSentence: '없는 문장', timestampSec: 999, onScreen: false, confidence: 1 }],
        introChunks: [],
        dayNumber: 0,
      }),
      300,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const codes = r.issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['gap', 'incomplete_end', 'low_coverage', 'source_not_found', 'expression_timestamp_out_of_range']));
    expect(r.result.keyExpressions[0].timestampSec).toBeNull();
    expect(r.result.dayNumber).toBeNull();
  });
});
