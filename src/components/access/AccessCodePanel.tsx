import { useEffect, useState } from 'react';
import { youtubeClient, type AccessCheck } from '@/services/integrations/youtubeClient';
import { accessCodeStore } from '@/services/integrations/accessCode';
import { useConfirm } from '@/hooks/useConfirm';
import { useToast } from '@/hooks/useToast';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { AccessCodeForm } from './AccessCodeForm';

/** 설정 화면 — 이 브라우저의 접근 코드 상태 · 입력/변경 · 지우기(로그아웃) */
export function AccessCodePanel() {
  const confirm = useConfirm();
  const toast = useToast();
  const [stored, setStored] = useState(() => accessCodeStore.get() != null);
  const [check, setCheck] = useState<AccessCheck | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const sync = () => setStored(accessCodeStore.get() != null);
    const off = accessCodeStore.subscribe(sync);
    void youtubeClient.checkAccess(accessCodeStore.get()).then(setCheck);
    return off;
  }, [stored]);

  const notRequired = check?.result === 'ok' && !check.required;
  const badge = notRequired
    ? { tone: 'neutral' as const, label: '필요 없음 (로컬)' }
    : stored
      ? check?.result === 'ok'
        ? { tone: 'ok' as const, label: '이 브라우저에 저장됨 · 확인됨' }
        : check?.result === 'invalid'
          ? { tone: 'danger' as const, label: '저장됨 · 맞지 않음' }
          : { tone: 'brand' as const, label: '이 브라우저에 저장됨' }
      : { tone: 'warn' as const, label: '저장 안 됨' };

  return (
    <Card className="space-y-3 p-4" data-testid="access-panel">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold">접근 코드 (이 기기·이 브라우저)</p>
        <Badge tone={badge.tone}>
          <span data-testid="access-status">{badge.label}</span>
        </Badge>
      </div>
      <p className="text-sm text-muted">
        영상 정보(YouTube) 서버를 쓸 때만 필요해요. 코드는 이 브라우저의 로컬 저장소에만 있고, 학습 데이터(IndexedDB)·백업 파일·서버에는 저장하지
        않아요. 다른 기기나 다른 브라우저, iPad 홈 화면 앱에서는 따로 입력해요.
      </p>
      {check && check.result !== 'ok' && check.result !== 'required' && check.result !== 'invalid' && (
        <p className="text-sm text-warn">{check.message}</p>
      )}
      {editing ? (
        <div className="max-w-md space-y-2">
          <AccessCodeForm
            submitLabel={stored ? '새 코드로 바꾸기' : '저장하기'}
            onDone={() => {
              setEditing(false);
              setStored(accessCodeStore.get() != null);
              toast('접근 코드를 확인하고 이 브라우저에 저장했어요');
            }}
          />
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            취소
          </Button>
        </div>
      ) : (
        !notRequired && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)} data-testid="access-edit">
              {stored ? '접근 코드 바꾸기' : '접근 코드 입력'}
            </Button>
            {stored && (
              <Button
                variant="ghost"
                size="sm"
                data-testid="access-logout"
                onClick={async () => {
                  const ok = await confirm({
                    title: '이 브라우저에서 접근 코드를 지울까요?',
                    message: '지우면 영상 정보 가져오기를 쓰기 전에 다시 입력해야 해요.\n학습 데이터와 백업에는 영향이 없어요.',
                    confirmLabel: '지우기',
                  });
                  if (!ok) return;
                  accessCodeStore.clear();
                  toast('이 브라우저에서 접근 코드를 지웠어요');
                }}
              >
                이 브라우저에서 지우기 (로그아웃)
              </Button>
            )}
          </div>
        )
      )}
      <p className="text-xs leading-relaxed text-subtle">
        주의: 이 기기를 쓸 수 있는 사람은 저장된 코드를 볼 수 있어요. 공용 기기에서는 쓰고 난 뒤 지워 주세요. 접근 코드는 영상 정보 서버를 아무나 쓰지
        못하게 막는 장치이고, 코드를 아는 사람의 직접 호출까지 완전히 막지는 못해요.
      </p>
    </Card>
  );
}
