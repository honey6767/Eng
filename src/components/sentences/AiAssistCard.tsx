import { useState } from 'react';
import { repos } from '@/repositories';
import type { Expression, KeySentence, Video } from '@/types/models';
import {
  applyAiNotesResult,
  buildNotesPrompt,
  NoteError,
  parseAiNotesResponse,
  type AiNotesResult,
} from '@/services/expressionNoteService';
import { copyText } from '@/utils/clipboard';
import { useToast } from '@/hooks/useToast';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Icon } from '@/components/ui/Icon';
import { TextArea } from '@/components/ui/Field';

/**
 * 무료 AI 도움: 요청문 복사 → 사용자가 이미 쓰는 AI 채팅(Claude 등)에 붙여넣기 → 답변을 다시 붙여넣기.
 * 앱은 유료 AI API를 호출하지 않는다.
 */
export function AiAssistCard({ video, sentences, expressions }: { video: Video; sentences: KeySentence[]; expressions: Expression[] }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<AiNotesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  if (sentences.length === 0) return null;
  const prompt = buildNotesPrompt(video, sentences, (id) => expressions.find((e) => e.id === id)?.text);

  const check = () => {
    setError(null);
    setResult(null);
    try {
      setResult(parseAiNotesResponse(answer));
    } catch (e) {
      setError(e instanceof NoteError ? e.message : '내용을 해석하지 못했습니다.');
    }
  };

  const apply = async () => {
    if (!result) return;
    setBusy(true);
    try {
      const s = await applyAiNotesResult(repos, video.id, result);
      toast(`번역·상황 ${s.filledKorean + s.filledSituation}칸, 표현 노트 ${s.notesAdded}개를 저장했어요`);
      setAnswer('');
      setResult(null);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4" data-testid="ai-assist">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon name="sparkle" className="size-4.5 text-info" />
          <h3 className="font-bold">AI로 번역·표현 설명 받기</h3>
          <Badge tone="ok">추가 비용 없음</Badge>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? '닫기' : '열기'}
        </Button>
      </div>
      <p className="mt-1.5 text-sm text-muted">
        앱이 AI를 직접 부르지 않습니다. 요청문을 복사해 평소 쓰는 AI 채팅(Claude 등)에 붙여넣고, 받은 답변을 아래에 붙여넣으세요. 영어
        원문은 바뀌지 않고, 비어 있는 번역·상황 칸만 채우며, 설명은 <Badge tone="info">AI 보충 · 확인 필요</Badge>로 저장됩니다.
      </p>

      {open && (
        <div className="mt-3 space-y-3">
          <div className="rounded-xl bg-canvas p-3">
            <p className="text-sm font-semibold">1. 요청문 복사</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={async () => {
                  const ok = await copyText(prompt);
                  if (ok) toast('요청문을 복사했어요');
                  else {
                    setShowPrompt(true);
                    toast('자동 복사가 안 돼요. 아래 글을 길게 눌러 직접 복사해 주세요', 'info');
                  }
                }}
              >
                요청문 복사
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowPrompt((v) => !v)}>
                {showPrompt ? '요청문 숨기기' : '요청문 보기'}
              </Button>
            </div>
            {showPrompt && (
              <TextArea readOnly value={prompt} rows={8} className="mt-2 font-mono text-[13px]" aria-label="AI 요청문" onFocus={(e) => e.currentTarget.select()} />
            )}
          </div>

          <div className="rounded-xl bg-canvas p-3">
            <p className="text-sm font-semibold">2. AI 답변 붙여넣기</p>
            <TextArea
              value={answer}
              onChange={(e) => {
                setAnswer(e.target.value);
                setResult(null);
                setError(null);
              }}
              rows={6}
              className="mt-2 font-mono text-[13px]"
              placeholder="AI 답변 전체를 붙여넣으세요 (JSON 부분만 자동으로 찾아요)"
              aria-label="AI 답변"
            />
            <div className="mt-2 flex justify-end">
              <Button size="sm" variant="secondary" disabled={!answer.trim()} onClick={check}>
                내용 확인
              </Button>
            </div>
            {error && <p className="mt-2 text-sm text-danger">{error}</p>}
            {result && (
              <div className="mt-2 space-y-2 text-sm" data-testid="ai-preview">
                <p>
                  번역·상황 제안 <b>{result.sentences.length}</b>개 · 표현 노트 <b>{result.notes.length}</b>개
                </p>
                {result.notes.length > 0 && (
                  <ul className="space-y-1">
                    {result.notes.map((n, i) => (
                      <li key={i} className="rounded-lg bg-surface px-2.5 py-1.5">
                        <span className="en font-semibold">{n.expression}</span> <span className="text-muted">— {n.meaningKo}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {result.problems.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-5 text-warn">
                    {result.problems.map((p, i) => (
                      <li key={i}>{p} (이 항목은 저장하지 않아요)</li>
                    ))}
                  </ul>
                )}
                <div className="flex justify-end">
                  <Button size="sm" disabled={busy || (result.sentences.length === 0 && result.notes.length === 0)} onClick={apply}>
                    3. 저장
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
