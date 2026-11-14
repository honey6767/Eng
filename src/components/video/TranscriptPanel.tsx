import { useMemo, useState } from 'react';
import { repos } from '@/repositories';
import { useConfirm } from '@/hooks/useConfirm';
import { useToast } from '@/hooks/useToast';
import { youtubeClient, type ProxyStatus } from '@/services/integrations/youtubeClient';
import { checkCaptions } from '@/services/videoImportService';
import { parseTranscriptDetailed } from '@/services/transcriptParser';
import type { Transcript, TranscriptFormat, Video } from '@/types/models';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { formatDateKo, formatTimestamp } from '@/utils/date';

const FORMAT_LABEL: Record<TranscriptFormat, string> = {
  srt: 'SRT',
  vtt: 'WebVTT',
  timestamped: '타임스탬프 텍스트',
  plain: '일반 텍스트(타임스탬프 없음)',
};

const TRACK_KIND: Record<string, string> = { asr: '자동 생성', standard: '직접 등록', forced: '강제 자막' };

export function TranscriptPanel({
  video,
  transcript,
  proxy,
  onSeek,
  onUsageChanged,
}: {
  video: Video;
  transcript: Transcript | undefined;
  proxy: ProxyStatus | null;
  onSeek: (sec: number) => void;
  onUsageChanged: () => void;
}) {
  const hasContent = transcript?.status === 'success' && transcript.segments.length > 0;
  const [editing, setEditing] = useState(false);

  return (
    <div className="space-y-4">
      <AutoFetchSection video={video} proxy={proxy} onUsageChanged={onUsageChanged} />
      {hasContent && !editing ? (
        <TranscriptView video={video} transcript={transcript!} onSeek={onSeek} onReplace={() => setEditing(true)} />
      ) : (
        <TranscriptEditor
          video={video}
          existing={hasContent ? transcript : undefined}
          failedMessage={transcript?.status === 'failed' ? transcript.errorMessage : undefined}
          onDone={() => setEditing(false)}
          onCancel={hasContent ? () => setEditing(false) : undefined}
        />
      )}
    </div>
  );
}

function AutoFetchSection({ video, proxy, onUsageChanged }: { video: Video; proxy: ProxyStatus | null; onUsageChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const check = video.captionCheck;
  const apiMode = proxy?.available && proxy.status.mode === 'api';

  const resultBadge = () => {
    if (!check) return <Badge>아직 시도하지 않음</Badge>;
    switch (check.result) {
      case 'tracks_found_no_permission':
        return <Badge tone="warn">자동 가져오기 불가 · 권한 없음</Badge>;
      case 'no_tracks':
        return <Badge tone="neutral">자막 트랙 없음</Badge>;
      case 'quota_exceeded':
        return <Badge tone="danger">사용량 제한</Badge>;
      case 'not_configured':
        return <Badge tone="warn">확인 불가 · 설정 필요</Badge>;
      default:
        return <Badge tone="danger">확인 실패</Badge>;
    }
  };

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-bold">자막 자동 가져오기</h3>
        <span data-testid="caption-check-result">{resultBadge()}</span>
      </div>
      <p className="mt-1.5 text-sm text-muted">
        YouTube 공식 API는 <b className="text-ink">영상 소유자(또는 편집 권한자)</b>만 자막 내용을 내려받을 수 있습니다. 이 앱은 자막 트랙이
        있는지만 확인하고, 내용을 가져오지 못하면 성공으로 표시하지 않습니다. 비공식 우회 방식은 사용하지 않습니다.
      </p>
      {check && (
        <div className="mt-3 rounded-xl bg-canvas px-3 py-2.5 text-sm">
          <p className="text-muted">{check.message}</p>
          {check.tracks.length > 0 && (
            <p className="mt-1 text-xs text-subtle">
              확인된 트랙: {check.tracks.map((t) => `${t.language || '언어 미상'}(${TRACK_KIND[t.kind] ?? t.kind})`).join(', ')}
            </p>
          )}
          <p className="mt-1 text-xs text-subtle">확인일 {formatDateKo(check.checkedAt)}</p>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || !apiMode || !video.youtubeVideoId}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await checkCaptions(repos, youtubeClient, video);
              toast(r.result === 'error' || r.result === 'quota_exceeded' ? '자막 확인에 실패했어요' : '자막 확인 결과를 저장했어요', r.result === 'error' ? 'error' : 'success');
            } finally {
              setBusy(false);
              onUsageChanged();
            }
          }}
        >
          {busy ? '확인 중…' : '자막 자동 가져오기 시도'}
        </Button>
        <span className="text-xs text-subtle">
          {!video.youtubeVideoId
            ? 'YouTube 영상 ID가 없는 샘플 영상입니다.'
            : apiMode
              ? 'YouTube API 50 단위 사용'
              : 'YouTube API 키가 설정된 경우에만 확인할 수 있어요.'}
        </span>
      </div>
    </Card>
  );
}

function TranscriptView({
  video,
  transcript,
  onSeek,
  onReplace,
}: {
  video: Video;
  transcript: Transcript;
  onSeek: (sec: number) => void;
  onReplace: () => void;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [showAll, setShowAll] = useState(false);
  const segs = showAll ? transcript.segments : transcript.segments.slice(0, 30);
  const canSeek = !!video.youtubeVideoId;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-bold">자막</h3>
        <Badge tone="ok">자막 있음</Badge>
        <span className="text-xs text-muted" data-testid="transcript-meta">
          {transcript.source === 'manual_paste' ? '직접 입력' : 'YouTube'}
          {transcript.format && ` · ${FORMAT_LABEL[transcript.format]}`} · {transcript.segments.length}개 구간
        </span>
        <div className="ml-auto flex gap-1.5">
          <Button variant="secondary" size="sm" onClick={onReplace}>
            자막 교체
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              const ok = await confirm({
                title: '자막을 삭제할까요?',
                message: '이 영상에 저장된 자막이 삭제됩니다. 영상 정보와 학습 기록은 그대로 남습니다.',
                confirmLabel: '자막 삭제',
                danger: true,
              });
              if (!ok) return;
              await repos.transcripts.deleteByVideo(video.id);
              toast('자막을 삭제했어요');
            }}
          >
            삭제
          </Button>
        </div>
      </div>
      {canSeek && transcript.segments.some((s) => s.startSec != null) && (
        <p className="mt-1 text-xs text-subtle">시간을 누르면 영상의 해당 위치부터 재생합니다.</p>
      )}
      <ol className="mt-3 space-y-1" data-testid="transcript-segments">
        {segs.map((s, i) => (
          <li key={i} className="flex gap-3 text-[15px]">
            {s.startSec != null && canSeek ? (
              <button
                type="button"
                onClick={() => onSeek(s.startSec!)}
                className="w-14 shrink-0 rounded px-1 pt-0.5 text-left text-xs font-semibold text-brand tabular-nums hover:bg-brand-soft"
                aria-label={`${formatTimestamp(s.startSec)}부터 재생`}
              >
                {formatTimestamp(s.startSec)}
              </button>
            ) : (
              <span className="w-14 shrink-0 pt-0.5 text-xs text-subtle tabular-nums">{formatTimestamp(s.startSec) ?? '—'}</span>
            )}
            <span className="en">{s.text}</span>
          </li>
        ))}
      </ol>
      {transcript.segments.length > 30 && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-3 text-sm font-semibold text-brand">
          {showAll ? '접기' : `전체 ${transcript.segments.length}개 구간 보기`}
        </button>
      )}
    </Card>
  );
}

const PLACEHOLDER = `예시) 아래 형식을 모두 붙여넣을 수 있어요.

0:15 Today we're going to look at five expressions.
0:42 First, "running behind."

또는 SRT / VTT 파일 내용, 타임스탬프 없는 일반 텍스트`;

function TranscriptEditor({
  video,
  existing,
  failedMessage,
  onDone,
  onCancel,
}: {
  video: Video;
  existing: Transcript | undefined;
  failedMessage?: string;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [text, setText] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const parsed = useMemo(() => (text.trim() ? parseTranscriptDetailed(text) : null), [text]);

  const save = async () => {
    if (!parsed || parsed.segments.length === 0) return;
    if (existing) {
      const ok = await confirm({
        title: '기존 자막을 교체할까요?',
        message: `저장된 자막(${existing.segments.length}개 구간)이 새 자막(${parsed.segments.length}개 구간)으로 바뀝니다.`,
        confirmLabel: '교체',
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      await repos.transcripts.save(video.id, {
        source: 'manual_paste',
        status: 'success',
        rawText: text,
        segments: parsed.segments,
        format: parsed.format,
      });
      toast('자막을 저장했어요');
      setText('');
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-bold">{existing ? '자막 교체' : '자막 직접 입력'}</h3>
        {failedMessage && (
          <Badge tone="danger">
            <Icon name="alert" className="size-3.5" />
            자막 가져오기 실패
          </Badge>
        )}
        {!existing && !failedMessage && <Badge>자막 없음</Badge>}
      </div>
      {failedMessage && <p className="mt-1.5 text-sm text-danger">{failedMessage}</p>}
      <details className="mt-2 text-sm text-muted">
        <summary className="cursor-pointer font-semibold text-brand">YouTube에서 자막 복사하는 방법</summary>
        <ol className="mt-1.5 list-decimal space-y-0.5 pl-5">
          <li>YouTube에서 영상을 열고 설명란의 ‘…더보기’를 누릅니다.</li>
          <li>‘스크립트 표시’를 누르면 오른쪽(모바일은 아래)에 시간별 자막이 나타납니다.</li>
          <li>자막 전체를 드래그해 복사한 뒤 아래 칸에 붙여넣으세요. 시간과 문장이 자동으로 구분됩니다.</li>
        </ol>
      </details>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={PLACEHOLDER}
        aria-label="자막 붙여넣기"
        rows={9}
        className="mt-3 w-full rounded-xl border border-line-strong bg-surface p-3 font-mono text-[13.5px] leading-relaxed outline-none focus:border-brand"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-xl border border-line-strong bg-surface px-3 text-sm font-semibold text-ink hover:bg-canvas">
          파일 불러오기 (.srt .vtt .txt)
          <input
            type="file"
            accept=".srt,.vtt,.txt,text/plain,text/vtt"
            className="sr-only"
            data-testid="transcript-file"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              setFileError(null);
              if (!file) return;
              if (file.size > 2 * 1024 * 1024) return setFileError('2MB 이하의 자막 파일만 불러올 수 있어요.');
              setText(await file.text());
            }}
          />
        </label>
        {fileError && <span className="text-sm text-danger">{fileError}</span>}
      </div>

      {parsed && (
        <div className="mt-3 rounded-xl bg-canvas p-3 text-sm" data-testid="transcript-preview">
          {parsed.segments.length === 0 ? (
            <p className="text-danger">인식된 자막 문장이 없습니다.</p>
          ) : (
            <>
              <p className="font-semibold">
                미리보기 · {FORMAT_LABEL[parsed.format]} · {parsed.segments.length}개 구간
                {parsed.format !== 'plain' && ` · 타임스탬프 ${parsed.timedCount}개`}
              </p>
              <ol className="mt-1.5 space-y-0.5">
                {parsed.segments.slice(0, 5).map((s, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="w-14 shrink-0 text-xs text-subtle tabular-nums">{formatTimestamp(s.startSec) ?? '—'}</span>
                    <span className="en truncate">{s.text}</span>
                  </li>
                ))}
              </ol>
              {parsed.segments.length > 5 && <p className="mt-1 text-xs text-subtle">… 외 {parsed.segments.length - 5}개</p>}
            </>
          )}
        </div>
      )}

      <div className="mt-3 flex justify-end gap-2">
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            취소
          </Button>
        )}
        <Button disabled={!parsed || parsed.segments.length === 0 || saving} onClick={save}>
          자막 저장
        </Button>
      </div>
    </Card>
  );
}
