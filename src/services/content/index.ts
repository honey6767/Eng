import { contentStore } from '@/repositories';
import { aiClient } from '@/services/integrations/aiClient';
import type { ContentDeps } from './controller';

/** 앱 전역 기본 의존성 */
export const contentDeps: ContentDeps = { store: contentStore, client: aiClient };
export { contentProgress, generateContent, listPendingContent, generatePendingContent, type ContentProgress, type PendingVideo } from './controller';
