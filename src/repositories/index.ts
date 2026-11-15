import { db } from '@/db/database';
import { createIndexedDbRepositories } from './indexeddb';
import { createBackupStore, createSnapshotStore } from './backupStore';
import { createExtractionStore } from './extractionStore';
import type { Repositories } from './types';

/**
 * 앱 전역 저장소 인스턴스.
 * Supabase로 이전할 때는 같은 Repositories 인터페이스의 구현을 만들어 여기서 교체한다.
 */
export const repos: Repositories = createIndexedDbRepositories(db);

export type { Repositories } from './types';

/** B0 — 백업·복원 (추가 전용 쓰기) / 임시 안전 복사본 (별도 저장소) */
export const backupStore = createBackupStore(db);
export const snapshotStore = createSnapshotStore();

/** B1-b — 자동 자막 추출 (새 테이블과 appMeta 'extractionRun'에만 쓰기) */
export const extractionStore = createExtractionStore(db);
