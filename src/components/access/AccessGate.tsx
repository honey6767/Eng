import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { youtubeClient } from '@/services/integrations/youtubeClient';
import { accessCodeStore } from '@/services/integrations/accessCode';
import { Loading } from '@/components/ui/Loading';
import { Button } from '@/components/ui/Button';
import { AccessCodeForm } from './AccessCodeForm';

type GateState = 'checking' | 'open' | 'gate';

/**
 * 처음 사용할 때(이 브라우저에 코드가 없을 때) 접근 코드 입력 화면을 보여 준다.
 * - 서버가 코드를 요구하지 않으면(로컬 모드) 바로 앱을 연다.
 * - 서버에 연결하지 못하면 학습은 계속할 수 있도록 앱을 연다 (영상 정보 가져오기만 안 됨).
 * - '지금은 건너뛰기'를 고르면 학습·백업은 그대로 쓰고, 설정에서 나중에 입력할 수 있다.
 *   (접근 코드는 YouTube 프록시 사용 권한일 뿐, 이 기기의 학습 데이터를 잠그는 장치가 아니다)
 */
export function AccessGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>('checking');

  const evaluate = useCallback(async () => {
    if (accessCodeStore.isRejected()) return setState('gate');
    if (accessCodeStore.get() || accessCodeStore.isSkipped()) return setState('open');
    setState('checking');
    const r = await youtubeClient.checkAccess(null);
    // 다른 곳에서 그사이 코드가 저장됐으면 그 상태를 따른다
    if (accessCodeStore.get() || accessCodeStore.isSkipped()) return setState('open');
    setState(r.result === 'required' || r.result === 'invalid' ? 'gate' : 'open');
  }, []);

  useEffect(() => {
    void evaluate();
    return accessCodeStore.subscribe(() => void evaluate());
  }, [evaluate]);

  if (state === 'checking') return <Loading label="확인하는 중…" />;
  if (state === 'gate') return <AccessCodeScreen rejected={accessCodeStore.isRejected()} />;
  return <>{children}</>;
}

function AccessCodeScreen({ rejected }: { rejected: boolean }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10" data-testid="access-gate">
      <div className="w-full max-w-md rounded-3xl border border-line bg-surface p-6 sm:p-8">
        <p className="text-sm font-bold text-brand">My English Study</p>
        <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">접근 코드를 입력해 주세요</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">
          영상 정보(YouTube)를 가져오는 서버를 쓰려면 이 기기·이 브라우저에서 한 번 입력해요. 코드는 이 브라우저에만 저장되고, 서버·학습 데이터·백업
          파일에는 들어가지 않아요.
        </p>
        {rejected && (
          <p role="alert" className="mt-4 rounded-2xl bg-warn-soft p-3 text-sm font-semibold text-warn" data-testid="access-rejected">
            저장된 접근 코드가 더 이상 맞지 않아요. 다시 입력해 주세요.
          </p>
        )}
        <div className="mt-5">
          <AccessCodeForm />
        </div>
        <div className="mt-6 border-t border-line pt-4">
          <Button variant="ghost" className="w-full" onClick={() => accessCodeStore.skip()} data-testid="access-skip">
            지금은 건너뛰기
          </Button>
          <p className="mt-2 text-center text-xs leading-relaxed text-subtle">
            건너뛰어도 학습과 백업은 그대로 쓸 수 있어요. 영상 정보 가져오기만 막히고, 나중에 설정에서 입력할 수 있어요.
          </p>
        </div>
      </div>
    </main>
  );
}
