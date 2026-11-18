import { aiClient } from '@/services/integrations/aiClient';
import { QaDatabase } from './qaDb';
import { createQaStore, type QaDeps } from './qaService';

export * from './qaDb';
export * from './qaService';

/** AI 부가 기록 DB (학습 DB와 별도) — 처음 쓸 때 연다 */
export const qaDb = new QaDatabase();
export const qaStore = createQaStore(qaDb);
export const qaDeps: QaDeps = { store: qaStore, client: aiClient };
