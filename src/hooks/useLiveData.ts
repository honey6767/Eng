import { useLiveQuery } from 'dexie-react-hooks';

/**
 * 저장소 데이터를 구독하는 훅.
 * 데이터가 바뀌면(다른 탭 포함) 자동으로 다시 계산한다.
 * 반환값이 undefined이면 아직 불러오는 중이다.
 *
 * 저장소를 Supabase로 바꾸면 이 훅 내부만 교체하면 된다(예: 실시간 구독/폴링).
 */
export function useLiveData<T>(query: () => Promise<T>, deps: unknown[] = []): T | undefined {
  return useLiveQuery(query, deps);
}
