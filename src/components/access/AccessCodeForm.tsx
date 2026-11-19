import { useId, useState } from 'react';
import { youtubeClient } from '@/services/integrations/youtubeClient';
import { accessCodeStore } from '@/services/integrations/accessCode';
import { Button } from '@/components/ui/Button';

/**
 * 접근 코드 입력 — 서버에서 맞는지 확인한 뒤에만 이 브라우저에 저장한다.
 * 입력값은 화면에 다시 출력하지 않고(기본 가림), 콘솔·로그에도 남기지 않는다.
 */
export function AccessCodeForm({ onDone, submitLabel = '확인' }: { onDone?: () => void; submitLabel?: string }) {
  const id = useId();
  const [code, setCode] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = code.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    const r = await youtubeClient.checkAccess(value);
    setBusy(false);
    if (r.result === 'ok') {
      if (r.required) accessCodeStore.save(value);
      setCode('');
      onDone?.();
      return;
    }
    setError(
      r.result === 'invalid'
        ? '접근 코드가 맞지 않아요. 다시 입력해 주세요.'
        : r.result === 'locked' || r.result === 'not_configured'
          ? r.message
          : r.result === 'required'
            ? '접근 코드를 입력해 주세요.'
            : '영상 정보 서버에 연결하지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.',
    );
  };

  return (
    <form onSubmit={submit} className="space-y-3" data-testid="access-form">
      <label htmlFor={id} className="block text-sm font-semibold text-ink">
        접근 코드
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setError(null);
          }}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          maxLength={256}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="h-12 min-w-0 flex-1 rounded-2xl border-[1.5px] border-line-strong bg-surface px-4 text-[16px] text-ink outline-none focus:border-brand"
          data-testid="access-input"
        />
        <Button variant="secondary" onClick={() => setShow((s) => !s)} aria-pressed={show} className="shrink-0" disabled={busy}>
          {show ? '가리기' : '보기'}
        </Button>
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm font-semibold text-danger" data-testid="access-error">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" className="w-full" disabled={busy || code.trim().length === 0} data-testid="access-submit">
        {busy ? '확인하는 중…' : submitLabel}
      </Button>
    </form>
  );
}
