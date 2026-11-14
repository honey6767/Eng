import { db } from '@/db/database';
import { createIndexedDbRepositories } from './indexeddb';
import type { Repositories } from './types';

/**
 * 앱 전역 저장소 인스턴스.
 * Supabase로 이전할 때는 같은 Repositories 인터페이스의 구현을 만들어 여기서 교체한다.
 */
export const repos: Repositories = createIndexedDbRepositories(db);

export type { Repositories } from './types';
