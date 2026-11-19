import { contentStore, extractionStore } from '@/repositories';
import { aiClient } from '@/services/integrations/aiClient';
import { createPrepController } from './prepController';

/** 앱 전역 학습 자료 자동 생성 대기열 (한 탭에서만 실제로 실행) */
export const prepController = createPrepController({ store: contentStore, extraction: extractionStore, client: aiClient });

/** 등록 전후 영상 id를 비교해 새로 생긴 영상만 대기열에 넣는다 */
export async function enqueueNewVideos(beforeIds: Set<string>, afterIds: string[]) {
  await prepController.enqueue(afterIds.filter((id) => !beforeIds.has(id)));
}
