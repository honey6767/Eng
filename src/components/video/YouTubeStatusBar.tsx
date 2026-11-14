import { Link } from 'react-router-dom';
import type { ProxyStatus } from '@/services/integrations/youtubeClient';
import { Badge } from '@/components/ui/Badge';

export function YouTubeStatusBar({ status }: { status: ProxyStatus | null }) {
  if (!status) return <p className="text-xs text-subtle">연결 상태 확인 중…</p>;
  if (!status.available) {
    return (
      <div className="text-xs text-muted">
        <Badge tone="danger">영상 정보 서버 없음</Badge>{' '}
        영상 URL은 ID만 저장해 등록할 수 있어요(제목 직접 입력). 재생목록 불러오기는 서버가 필요합니다.{' '}
        <Link to="/settings#youtube" className="font-semibold text-brand underline-offset-2 hover:underline">
          설정 방법
        </Link>
      </div>
    );
  }
  const { mode, quota, mock } = status.status;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      {mock && <Badge tone="danger">테스트용 가짜 응답(MOCK) 모드</Badge>}
      {mode === 'api' ? (
        <>
          <Badge tone="ok">YouTube API 연결됨</Badge>
          <span>
            오늘 사용량 {quota.used.toLocaleString()} / {quota.cap.toLocaleString()} 단위
            {quota.exhausted && <b className="ml-1 text-danger">· 오늘 할당량 소진 (추가 비용 없이 내일 초기화)</b>}
          </span>
        </>
      ) : (
        <>
          <Badge tone="warn">API 키 미설정 · 제한 모드</Badge>
          <span>영상은 제목·썸네일만(길이 미확인), 재생목록은 최근 15개만 가져옵니다.</span>
          <Link to="/settings#youtube" className="font-semibold text-brand underline-offset-2 hover:underline">
            무료 API 키 설정 방법
          </Link>
        </>
      )}
    </div>
  );
}
