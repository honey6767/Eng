import { useCallback, useEffect, useState } from 'react';
import { youtubeClient, type ProxyStatus } from '@/services/integrations/youtubeClient';

/** 서버 프록시 연결 상태와 오늘 사용량 */
export function useYouTubeStatus() {
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const refresh = useCallback(async () => {
    setStatus(await youtubeClient.status());
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { status, refresh };
}
