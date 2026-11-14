import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  /** 이 문구를 정확히 입력해야 확인 버튼이 활성화됨 (전체 초기화 등) */
  requireText?: string;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = '확인',
  danger = false,
  requireText,
  onCancel,
  onConfirm,
}: ConfirmOptions & { onCancel: () => void; onConfirm: () => void }) {
  const [typed, setTyped] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const enabled = !requireText || typed.trim() === requireText;

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="w-full max-w-md rounded-2xl bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-title" className="text-lg font-bold">
          {title}
        </h2>
        <p className="mt-2 text-[15px] whitespace-pre-line text-muted">{message}</p>
        {requireText && (
          <label className="mt-4 block text-sm">
            <span className="text-muted">
              계속하려면 <b className="text-ink">{requireText}</b> 를 입력하세요.
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1.5 h-11 w-full rounded-xl border border-line-strong px-3 text-base outline-none focus:border-brand"
              aria-label="확인 문구 입력"
            />
          </label>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
            취소
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={!enabled} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
