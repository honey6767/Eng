import { extractionStore } from '@/repositories';
import { aiClient } from '@/services/integrations/aiClient';
import { createExtractionController } from './controller';

/** 앱 전역 자동 추출 실행기 (한 탭에서만 실제로 실행) */
export const extractionController = createExtractionController({ store: extractionStore, client: aiClient });
