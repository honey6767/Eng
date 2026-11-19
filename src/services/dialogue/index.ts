import { contentStore } from '@/repositories';
import { aiClient } from '@/services/integrations/aiClient';
import type { DialogueDeps } from './controller';

export const dialogueDeps: DialogueDeps = { store: contentStore, client: aiClient };
export * from './controller';
export * from './combinedDialogue';
