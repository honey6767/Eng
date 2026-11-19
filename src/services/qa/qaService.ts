import type { AiClient } from '@/services/integrations/aiClient';
import type { AiTaskState } from '@/repositories/contentStore';
import type { PhraseAttempt, PhraseSet, QaDatabase } from './qaDb';

/**
 * AI 부가 기록 저장소 — ✨ 분석 결과·시도 기록과 진행 중 요청 상태
 * (AI 질문 기능은 최종 배포에서 빠졌다. 예전 질문 기록은 DB에 그대로 남아 백업·복원에만 쓰인다)
 */

export interface QaStore {
  getTask(key: string): Promise<AiTaskState | null>;
  putTask(key: string, state: AiTaskState | null): Promise<void>;
  getPhraseSet(dialogueId: string): Promise<PhraseSet | undefined>;
  /** 이미 있으면 그대로 두고 false (덮어쓰지 않음) */
  addPhraseSet(set: PhraseSet): Promise<boolean>;
  allPhraseSets(): Promise<PhraseSet[]>;
  attemptsOf(dialogueId: string): Promise<PhraseAttempt[]>;
  addAttempt(a: PhraseAttempt): Promise<void>;
  allAttempts(): Promise<PhraseAttempt[]>;
}

export function createQaStore(db: QaDatabase): QaStore {
  return {
    getTask: async (key) => (await db.tasks.get(key))?.state ?? null,
    putTask: async (key, state) => {
      if (state) await db.tasks.put({ key, state });
      else await db.tasks.delete(key);
    },
    getPhraseSet: (id) => db.phraseSets.get(id),
    addPhraseSet: (set) =>
      db.transaction('rw', db.phraseSets, async () => {
        if (await db.phraseSets.get(set.dialogueId)) return false;
        await db.phraseSets.add(set);
        return true;
      }),
    allPhraseSets: () => db.phraseSets.toArray(),
    attemptsOf: async (id) => (await db.phraseAttempts.where('dialogueId').equals(id).toArray()).sort((a, b) => a.at.localeCompare(b.at)),
    addAttempt: async (a) => void (await db.phraseAttempts.add(a)),
    allAttempts: () => db.phraseAttempts.toArray(),
  };
}

export interface QaDeps {
  store: QaStore;
  client: AiClient;
  now?: () => Date;
  newId?: () => string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollMs?: number;
}
