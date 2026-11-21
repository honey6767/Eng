import type { Dialogue, KeySentence, LearningItem } from '@/types/models';
import { daySourceSentences, excludedDaySentences, includedDaySentences, originalCandidatesOf, userSentencesOf } from './daySeries';

/** 'dayuser:<영상>' 요청 기록에서 읽은 것 (appMeta 'aiTasks' — 기존 형식 그대로, 읽기만) */
export interface DayUserRequestRecord {
  requestId: string;
  sentences: { number: number; text: string }[];
}

export type DayViewMode = 'old_ai' | 'user' | 'none';

const linksOf = (i: LearningItem) => [i.sentenceId, ...(i.occurrences ?? []).map((o) => o.sentenceId)].filter((x): x is string => !!x);

/**
 * Day 영상 화면 구성 (저장 데이터는 읽기만)
 * - none: 아직 Day 자료 없음 → 영상 원문 후보(기본 포함)·직접 넣은 문장으로 만들기, 예전 AI 자료는 접어서 참고로
 * - user: 'Day 자료 만들기'로 만든 자료(영상 원문 후보 + 직접 넣은 문장) → 그 자료만 위에(요청 때 번호), 예전 AI 자료는 접어서 참고로
 * - old_ai: 그 밖의 기존 Day 자료(예전 pack·daypack 방식) → 예전 화면 그대로 (접거나 번호를 바꾸지 않음)
 *
 * user 판단: 'dayuser' 요청 기록의 요청 식별자가 Day 대화문(dlg-day-<요청 식별자>)과 같거나,
 *            기록이 없을 때는 자료가 사용자 문장에만 연결돼 있을 때. 애매하면 old_ai(아무것도 접지 않음).
 */
export function dayViewOf(sentences: KeySentence[], items: LearningItem[], dialogues: Dialogue[], record: DayUserRequestRecord | null, excluded: ReadonlySet<string> = new Set()) {
  const aiSentences = sentences.filter((s) => s.origin === 'ai_extracted');
  const mine = userSentencesOf(sentences);
  const mineIds = new Set(mine.map((s) => s.id));
  const aiIds = new Set(aiSentences.map((s) => s.id));
  const dlg = dialogues.find((d) => d.kind === 'original' && d.generatedBy === 'ai');
  const reqId = dlg?.id.startsWith('dlg-day-') ? dlg.id.slice('dlg-day-'.length) : null;
  const reqItems = reqId ? items.filter((i) => i.contentRequestId === reqId) : [];
  const refs = [...(dlg ? dlg.lines.map((l) => l.sourceSentenceId).filter((x): x is string => !!x) : []), ...reqItems.flatMap(linksOf)];
  const usesMine = refs.some((id) => mineIds.has(id));
  const usesAi = refs.some((id) => aiIds.has(id)) || (!!reqId && aiSentences.some((s) => s.contentRequestId === reqId));
  const fromRecord = !!record && !!reqId && record.requestId === reqId;
  const mode: DayViewMode = !dlg ? 'none' : fromRecord || (usesMine && !usesAi) ? 'user' : 'old_ai';
  const userItems = mode === 'user' ? reqItems : [];
  const userItemIds = new Set(userItems.map((i) => i.id));
  // 자료의 문장 번호: 이 자료를 만든 요청의 번호 그대로 (자료를 만든 뒤 문장을 더하거나 빼도 밀리지 않게).
  // 기록이 없거나 다른 요청의 기록이면 지금 사용자 문장 순서
  let numbering = new Map<string, number>();
  if (fromRecord) {
    const used = new Set<string>();
    // 요청 문장은 영상 원문 후보 + 사용자 문장 중 빼지 않은 것에서 왔다 (뺀 문장은 건너뜀 —
    // 원문 후보를 빼고 같은 문장을 사용자가 넣었다면 사용자 문장에 연결). Day 자료가 생긴 뒤에는 빼기 상태를 바꿀 수 없어 요청 때와 같다
    const pool = daySourceSentences(sentences).filter((s) => !excluded.has(s.id));
    for (const x of record!.sentences) {
      const s = pool.find((m) => !used.has(m.id) && m.english === x.text);
      if (s) {
        used.add(s.id);
        numbering.set(s.id, x.number);
      }
    }
  }
  // 기록이 없으면 Day 자료에 쓰는 문장(뺀 문장 제외)의 지금 순서
  if (!numbering.size) numbering = new Map(includedDaySentences(sentences, excluded).map((s, i) => [s.id, i + 1]));
  // 선정 취소 보호: 이 영상의 Chunk가 연결한 사용자 문장 (대화 원문 출처는 서비스가 직접 확인)
  const linkedIds = new Set(items.flatMap(linksOf).filter((id) => mineIds.has(id)));
  return { mode, hasMaterial: !!dlg, aiSentences, userItems, oldItems: items.filter((i) => !userItemIds.has(i.id)), numbering, linkedIds, excludedSentences: excludedDaySentences(sentences, excluded), candidates: originalCandidatesOf(sentences) };
}

/** appMeta 'aiTasks'의 'dayuser:<영상>' 기록 → DayUserRequestRecord (형식이 다르면 null) */
export function dayUserRecordOf(task: { requestId?: unknown; body?: unknown } | null | undefined): DayUserRequestRecord | null {
  const body = task?.body as { task?: unknown; sentences?: unknown } | undefined;
  if (!task || typeof task.requestId !== 'string' || !body || body.task !== 'daypack' || !Array.isArray(body.sentences)) return null;
  const sentences = (body.sentences as { number?: unknown; text?: unknown }[]).filter((x) => typeof x?.number === 'number' && typeof x?.text === 'string').map((x) => ({ number: x.number as number, text: x.text as string }));
  return { requestId: task.requestId, sentences };
}
