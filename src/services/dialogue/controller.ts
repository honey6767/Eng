import type { ContentStore } from '@/repositories/contentStore';
import type { AiClient } from '@/services/integrations/aiClient';
import { runAiTask, type TaskProgress } from '@/services/ai/taskRunner';
import type { AiDialogueRequest } from '@/types/aiApi';
import { buildCandidateGroups, buildDialogueRecord, type CandidateGroup } from './combinedDialogue';

export type DialogueProgress = TaskProgress | { phase: 'succeeded'; dialogueId: string; used: number; unused: number; sourceDays: number[]; issues: string[] };

export interface DialogueDeps {
  store: ContentStore;
  client: AiClient;
  now?: () => Date;
  newId?: () => string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollMs?: number;
}

/** 통합 대화문은 한 번에 하나만 만든다 (앱을 닫았다 열면 같은 식별자로 이어서 확인) */
export const DIALOGUE_TASK_KEY = 'dialogue:combined';

export async function loadGroups(store: ContentStore): Promise<CandidateGroup[]> {
  return buildCandidateGroups(await store.readCombine());
}

export async function pendingDialogueTask(store: ContentStore) {
  const st = await store.getTask(DIALOGUE_TASK_KEY);
  return st && (st.status === 'sent' || st.status === 'succeeded') ? st : null;
}

export async function generateCombinedDialogue(deps: DialogueDeps, req: AiDialogueRequest, onProgress: (p: DialogueProgress) => void, signal?: AbortSignal): Promise<DialogueProgress> {
  const report = (p: DialogueProgress) => {
    onProgress(p);
    return p;
  };
  const out = await runAiTask(DIALOGUE_TASK_KEY, () => req, deps, report, signal);
  if (!out.ok) return report({ phase: 'failed', httpStatus: out.httpStatus, code: out.code, message: out.message });
  // 이어서 확인한 요청이면 그때 보낸 내용으로 결과를 해석한다
  const st = await deps.store.getTask(DIALOGUE_TASK_KEY);
  const sent = (st?.body as AiDialogueRequest | undefined) ?? req;
  const groups = await loadGroups(deps.store);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const v = buildDialogueRecord(out.text, sent, groups, out.requestId, now);
  if (!v.ok) {
    if (st) await deps.store.putTask(DIALOGUE_TASK_KEY, { ...st, status: 'failed', resultText: null, error: { code: 'invalid_result', message: v.error, httpStatus: null } });
    return report({ phase: 'failed', httpStatus: null, code: 'invalid_result', message: `Gemini 결과를 쓸 수 없어요: ${v.error}` });
  }
  await deps.store.addDialogue(v.dialogue);
  await deps.store.putTask(DIALOGUE_TASK_KEY, null);
  return report({ phase: 'succeeded', dialogueId: v.dialogue.id, used: v.dialogue.chunkUsages?.length ?? 0, unused: v.dialogue.unusedLearningItemIds?.length ?? 0, sourceDays: v.dialogue.sourceDays ?? [], issues: v.issues });
}
