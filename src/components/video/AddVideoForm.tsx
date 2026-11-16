import { useState } from 'react';
import { Link } from 'react-router-dom';
import { repos } from '@/repositories';
import { youtubeClient, YouTubeApiError, type ProxyStatus } from '@/services/integrations/youtubeClient';
import { importPlaylist, importVideo, importVideoWithoutProxy, type ImportOutcome } from '@/services/videoImportService';
import { parseYouTubeUrl } from '@/utils/youtubeUrl';
import { enqueueNewVideos } from '@/services/prep';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { YouTubeStatusBar } from './YouTubeStatusBar';

type Pending = { kind: 'choose'; videoId: string; playlistId: string } | { kind: 'manual_title'; videoId: string } | null;

export function AddVideoForm({ status, onImported }: { status: ProxyStatus | null; onImported: () => void }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportOutcome | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [manualTitle, setManualTitle] = useState('');

  const proxyAvailable = status?.available === true;

  const run = async (fn: () => Promise<ImportOutcome>) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const before = new Set((await repos.videos.list()).map((v) => v.id));
      const r = await fn();
      // 새로 등록된 영상은 학습 자료 자동 생성 대기열에 넣는다 (기존 영상은 그대로)
      void enqueueNewVideos(before, (await repos.videos.list()).map((v) => v.id));
      setResult(r);
      setInput('');
      setPending(null);
      setManualTitle('');
      onImported();
    } catch (e) {
      setError(e instanceof YouTubeApiError || e instanceof Error ? e.message : '등록 중 오류가 발생했습니다.');
      onImported(); // 사용량 갱신
    } finally {
      setBusy(false);
    }
  };

  const registerVideo = (videoId: string) => {
    if (!proxyAvailable) {
      setPending({ kind: 'manual_title', videoId });
      return;
    }
    void run(() => importVideo(repos, youtubeClient, videoId));
  };
  const registerPlaylist = (playlistId: string) => {
    if (!proxyAvailable) {
      setError('재생목록을 불러오려면 영상 정보 서버(프록시)가 필요합니다. npm run dev 또는 npm run preview로 실행해 주세요.');
      return;
    }
    void run(() => importPlaylist(repos, youtubeClient, playlistId));
  };

  const submit = () => {
    setError(null);
    setResult(null);
    setPending(null);
    const parsed = parseYouTubeUrl(input);
    if (parsed.kind === 'invalid') return setError(parsed.reason);
    if (parsed.kind === 'video_in_playlist') return setPending({ kind: 'choose', videoId: parsed.videoId, playlistId: parsed.playlistId });
    if (parsed.kind === 'video') return registerVideo(parsed.videoId);
    registerPlaylist(parsed.playlistId);
  };

  return (
    <Card className="p-4 sm:p-5">
      <h2 className="font-bold">영상 등록</h2>
      <p className="mt-0.5 text-sm text-muted">YouTube 재생목록 URL 또는 영상 URL을 붙여넣으세요. 이미 등록된 영상은 중복 등록되지 않습니다.</p>
      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="https://youtube.com/playlist?list=…  또는  https://youtu.be/…"
          aria-label="YouTube URL"
          inputMode="url"
          autoComplete="off"
          className="h-11 min-w-0 flex-1 rounded-xl border border-line-strong bg-surface px-3 text-[15px] outline-none focus:border-brand"
        />
        <Button type="submit" disabled={busy || !input.trim()} className="shrink-0">
          {busy ? (
            <>
              <span className="size-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              불러오는 중…
            </>
          ) : (
            '등록'
          )}
        </Button>
      </form>
      <div className="mt-2.5">
        <YouTubeStatusBar status={status} />
      </div>

      {pending?.kind === 'choose' && (
        <div className="mt-3 rounded-xl border border-line bg-canvas p-3 text-sm">
          <p className="font-semibold">재생목록 안의 영상 주소입니다. 무엇을 등록할까요?</p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => registerPlaylist(pending.playlistId)}>
              재생목록 전체 등록
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => registerVideo(pending.videoId)}>
              이 영상만 등록
            </Button>
          </div>
        </div>
      )}

      {pending?.kind === 'manual_title' && (
        <div className="mt-3 rounded-xl border border-line bg-canvas p-3 text-sm">
          <p className="font-semibold">서버 연결 없이 등록</p>
          <p className="mt-0.5 text-muted">
            영상 정보 서버가 없어 제목과 길이를 가져올 수 없습니다. 영상 ID({pending.videoId})와 썸네일만 저장하고, 제목은 직접 입력해 주세요.
            나중에 서버를 연결해 같은 URL을 다시 등록하면 정보가 보강됩니다.
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              value={manualTitle}
              onChange={(e) => setManualTitle(e.target.value)}
              placeholder="영상 제목 (선택)"
              aria-label="영상 제목"
              className="h-10 min-w-0 flex-1 rounded-xl border border-line-strong bg-surface px-3 outline-none focus:border-brand"
            />
            <Button size="sm" disabled={busy} onClick={() => run(() => importVideoWithoutProxy(repos, pending.videoId, manualTitle))}>
              ID만으로 등록
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 flex gap-2 rounded-xl bg-danger-soft px-3 py-2.5 text-sm text-danger">
          <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}

      {result && <ImportResult result={result} />}
    </Card>
  );
}

function ImportResult({ result }: { result: ImportOutcome }) {
  const r = result;
  const priv = r.unavailable.filter((u) => u.reason === '비공개 영상').length;
  const del = r.unavailable.filter((u) => u.reason === '삭제된 영상').length;
  const other = r.unavailable.length - priv - del;
  return (
    <div role="status" className="mt-3 rounded-xl bg-ok-soft px-3.5 py-3 text-sm text-ink" data-testid="import-result">
      {r.kind === 'playlist' ? (
        <>
          <p className="font-semibold text-ok">
            {r.playlistCreated ? '재생목록을 등록했어요' : '이미 등록된 재생목록이라 새로 만들지 않고 다시 불러왔어요'} — {r.playlist?.title}
          </p>
          <ul className="mt-1 space-y-0.5 text-muted">
            <li>
              새 영상 <b className="text-ink">{r.added}</b>개 추가 · 기존 영상에 출처 연결 <b className="text-ink">{r.linked}</b>개 · 변경 없음{' '}
              <b className="text-ink">{r.unchanged}</b>개
            </li>
            {r.unavailable.length > 0 && (
              <li>
                불러올 수 없는 영상 {r.unavailable.length}개 (비공개 {priv} · 삭제 {del}
                {other ? ` · 기타 ${other}` : ''}) — 등록하지 않았습니다.
              </li>
            )}
            {r.unitsUsed > 0 && <li>YouTube API 사용량: {r.unitsUsed} 단위</li>}
          </ul>
        </>
      ) : (
        <>
          <p className="font-semibold text-ok">
            {r.added
              ? '새 영상을 등록했어요'
              : r.linked
                ? '이미 등록된 영상이에요 — 기존 학습 기록은 그대로 두고 ‘개별 등록’ 출처만 연결했어요'
                : '이미 개별 등록된 영상이에요 — 영상 정보만 최신으로 갱신했어요'}
          </p>
          <Link to={`/videos/${r.videos[0].id}`} className="mt-1 inline-block font-semibold text-brand underline-offset-2 hover:underline">
            {r.videos[0].title} 보기
          </Link>
        </>
      )}
      {(!r.complete || r.note) && (
        <p className="mt-2 rounded-lg bg-warn-soft px-2.5 py-2 text-xs text-warn">{r.note ?? '전체 목록을 가져오지 못했습니다.'}</p>
      )}
      {r.source === 'oembed' && (
        <p className="mt-2 rounded-lg bg-warn-soft px-2.5 py-2 text-xs text-warn">
          API 키가 없어 제목·썸네일만 가져왔고 영상 길이는 확인하지 못했습니다.
        </p>
      )}
    </div>
  );
}
