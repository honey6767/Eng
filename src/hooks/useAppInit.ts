import { useEffect, useState } from 'react';
import { repos } from '@/repositories';
import { initializeApp } from '@/services/seedService';
import { CURRENT_SCHEMA_VERSION } from '@/db/migrations';

// StrictMode의 이중 실행에도 초기화가 한 번만 일어나도록 모듈 단위로 공유
let initPromise: Promise<void> | null = null;

export function useAppInit() {
  const [state, setState] = useState<{ ready: boolean; error: string | null }>({ ready: false, error: null });

  useEffect(() => {
    let cancelled = false;
    initPromise ??= initializeApp(repos, CURRENT_SCHEMA_VERSION);
    initPromise
      .then(() => !cancelled && setState({ ready: true, error: null }))
      .catch((e: unknown) => {
        console.error(e);
        initPromise = null;
        if (!cancelled) {
          setState({
            ready: false,
            error: e instanceof Error ? e.message : '알 수 없는 오류',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
