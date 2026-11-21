import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { repos } from '@/repositories';
import { useLiveData } from '@/hooks/useLiveData';
import { useConfirm } from '@/hooks/useConfirm';
import { useToast } from '@/hooks/useToast';
import type { Dialogue, Expression, KeySentence, Transcript, Video } from '@/types/models';
import {
  addKeySentence,
  cleanOriginal,
  getRemovalBlocker,
  KEY_SENTENCE_COUNT,
  KeySentenceError,
  linkExpression,
  removeKeySentence,
  resolveSpans,
  setExpressionSpan,
  unlinkExpression,
  updateKeySentenceDetails,
} from '@/services/keySentenceService';
import { normalizeExpressionKey } from '@/utils/text';
import { DAY_SENTENCE_CHARS, DAY_SENTENCE_MAX } from '@/services/days/daySeries';
import { DayExclusionToggle } from '@/components/prep/PrepStatus';
import { formatTimestamp, parseTimestamp } from '@/utils/date';
import type { TextSpan } from '@/utils/expressionSpan';
import { LEARNING_STATUS } from '@/utils/labels';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Field, TextArea, TextInput } from '@/components/ui/Field';
import { HighlightedSentence } from './HighlightedSentence';
import { TokenRangePicker } from './TokenRangePicker';
import { AiAssistCard } from './AiAssistCard';

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : '저장하지 못했습니다.');

/** 3단계 — 영상의 핵심 문장 5개 선정·관리 */
export function KeySentenceManager({
  video,
  transcript,
  sentences,
  dialogues,
  expressions,
  onSeek,
  day = false,
  linkedIds,
  excludedIds,
  hasMaterial = false,
  dayIncludedCount,
}: {
  video: Video;
  transcript: Transcript | undefined;
  sentences: KeySentence[];
  dialogues: Dialogue[];
  expressions: Expression[];
  onSeek?: (sec: number) => void;
  /** Day 1~100 영상: Day 자료 재료 문장 (1~20개) */
  day?: boolean;
  /** Day 영상: Day 자료의 Chunk가 연결한 문장 id (선정 취소 보호) */
  linkedIds?: ReadonlySet<string>;
  /** Day 영상: Day 자료에서 뺀 문장 id (appMeta 'dayExclusions') */
  excludedIds?: ReadonlySet<string>;
  /** Day 영상: Day 자료가 이미 있음 (빼기·다시 넣기 버튼 숨김) */
  hasMaterial?: boolean;
  /** Day 영상: Day 자료에 실제로 쓰는 문장 수 (영상 원문 후보 포함, 뺀 문장·중복 제외) — 20개 제한에 쓴다 */
  dayIncludedCount?: number;
}) {
  const sorted = [...sentences].sort((a, b) => a.order - b.order);
  const max = day ? DAY_SENTENCE_MAX : KEY_SENTENCE_COUNT;
  // Day: 개수 제한은 Day 자료에 실제로 쓰는 문장(뺀 문장 제외)만
  const counted = day && excludedIds ? sentences.filter((s) => !excludedIds.has(s.id)) : sentences;
  const excludedCount = sentences.length - counted.length;
  const total = day && dayIncludedCount !== undefined ? dayIncludedCount : counted.length;
  const remaining = max - total;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-bold">
            핵심 문장 <span data-testid="key-sentence-count">{total}</span> / {max}
            {excludedCount > 0 && <span className="ml-1.5 text-sm font-semibold text-muted" data-testid="day-excluded-count">· 뺀 문장 {excludedCount}</span>}
          </h3>
          {day ? (
            <Badge tone={total ? 'ok' : 'warn'}>{total ? `Day 자료 재료 ${total}개` : '1개 이상 입력'}</Badge>
          ) : remaining === 0 ? (
            <Badge tone="ok">선정 완료</Badge>
          ) : (
            <Badge tone="warn">{remaining}개 더 선정</Badge>
          )}
        </div>
        <ProgressBar value={(total / max) * 100} className="mt-2" label="핵심 문장 선정 진행률" />
        {day && (
          <p className="mt-2 text-sm text-muted">
            영상 원문 후보(위)와 여기서 직접 입력하거나 자막에서 고른 문장이 합쳐서 Day 자료 재료가 돼요 (최대 {DAY_SENTENCE_MAX}개, 같은 문장은 한 번만). ‘Day 자료에서 빼기’를 누른 문장은 문장·학습 기록은 그대로 두고 Day 자료 요청에서만 빠져요 (개수에도 세지 않음).
          </p>
        )}
        <p className="mt-2 text-sm text-muted">
          영상에서 고른 영어 문장은 <b className="text-ink">원문 그대로</b> 저장하며, 저장한 뒤에는 고칠 수 없습니다. 번역·상황·핵심 표현은
          언제든 수정할 수 있어요.
        </p>
      </Card>

      {sorted.length > 0 && (
        <ol className="space-y-3">
          {sorted.map((s) => (
            <li key={s.id}>
              <SentenceCard sentence={s} dialogues={dialogues} expressions={expressions} onSeek={video.youtubeVideoId ? onSeek : undefined} day={day} linkedIds={linkedIds} excluded={!!excludedIds?.has(s.id)} hasMaterial={hasMaterial} />
            </li>
          ))}
        </ol>
      )}

      {remaining > 0 && <AddSentencePanel video={video} transcript={transcript} sentences={sentences} day={day} />}

      <AiAssistCard video={video} sentences={sorted} expressions={expressions} />
    </div>
  );
}

// ─────────────────────────────────────────────

function SentenceCard({
  sentence: s,
  dialogues,
  expressions,
  onSeek,
  day,
  linkedIds,
  excluded = false,
  hasMaterial = false,
}: {
  sentence: KeySentence;
  dialogues: Dialogue[];
  expressions: Expression[];
  onSeek?: (sec: number) => void;
  day: boolean;
  linkedIds?: ReadonlySet<string>;
  excluded?: boolean;
  hasMaterial?: boolean;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [spanFor, setSpanFor] = useState<string | null>(null);
  const blocker = useLiveData(() => getRemovalBlocker(repos, s, { day, linkedIds }), [s.id, s.updatedAt, dialogues.length, day, linkedIds?.has(s.id)]);
  const usedIn = dialogues.find((d) => d.lines.some((l) => l.segments.some((seg) => seg.keySentenceId === s.id)));
  const linked = s.expressionIds.map((id) => expressions.find((e) => e.id === id)).filter((e): e is Expression => !!e);
  const spans = resolveSpans(s, expressions);
  const st = LEARNING_STATUS[s.status];

  return (
    <Card className={`p-4 ${excluded ? 'opacity-70' : ''}`} data-testid="key-sentence-card" data-excluded={day ? String(excluded) : undefined}>
      <div className="flex gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-key text-sm font-bold text-key-ink">{s.order}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <HighlightedSentence sentence={s} expressions={expressions} className="min-w-0 flex-1 text-[17px] leading-snug font-semibold" />
            <span className="mt-0.5 shrink-0 text-subtle" title="영어 원문은 수정할 수 없어요">
              <Icon name="lock" className="size-4" />
              <span className="sr-only">원문 잠김</span>
            </span>
          </div>
          {day && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {excluded && <Badge tone="warn">Day 자료에서 뺌</Badge>}
              <DayExclusionToggle videoId={s.videoId} sentenceId={s.id} excluded={excluded} hasMaterial={hasMaterial} />
            </div>
          )}

          {editing ? (
            <DetailsEditor sentence={s} onDone={() => setEditing(false)} />
          ) : (
            <>
              <p className={`mt-0.5 text-[15px] ${s.korean ? 'text-muted' : 'text-subtle italic'}`}>{s.korean || '번역을 입력해 주세요'}</p>
              <p className="mt-2 text-sm text-muted">
                <span className="font-semibold text-ink">상황</span> {s.situation || <span className="text-subtle">미입력</span>}
              </p>
            </>
          )}

          {/* 핵심 표현 */}
          <div className="mt-3 rounded-xl bg-canvas p-3">
            <p className="text-xs font-semibold text-muted">핵심 표현</p>
            {linked.length === 0 && <p className="mt-1 text-sm text-subtle">아직 연결한 핵심 표현이 없어요.</p>}
            <ul className="mt-1.5 space-y-2">
              {linked.map((e) => {
                const sp = spans.find((x) => x.expressionId === e.id);
                return (
                  <li key={e.id} className="text-sm">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="en font-semibold">{e.text}</span>
                      {e.meaningKo && <span className="text-muted">— {e.meaningKo}</span>}
                      {!sp && <Badge tone="warn">위치 지정 필요</Badge>}
                      {sp?.source === 'auto' && <Badge>자동 위치</Badge>}
                      <span className="ml-auto flex gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setSpanFor(spanFor === e.id ? null : e.id)}>
                          위치 지정
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={async () => {
                            const ok = await confirm({
                              title: '이 문장에서 표현 연결을 해제할까요?',
                              message: `‘${e.text}’ 표현 자체와 즐겨찾기·학습 기록은 그대로 남고, 이 문장과의 연결만 해제됩니다.`,
                              confirmLabel: '연결 해제',
                            });
                            if (!ok) return;
                            await unlinkExpression(repos, s.id, e.id);
                            toast('연결을 해제했어요');
                          }}
                        >
                          해제
                        </Button>
                      </span>
                    </div>
                    {spanFor === e.id && (
                      <SpanEditor
                        sentence={s}
                        initial={sp ?? null}
                        onSave={async (span) => {
                          await setExpressionSpan(repos, s.id, e.id, span);
                          setSpanFor(null);
                          toast('표현 위치를 저장했어요');
                        }}
                        onCancel={() => setSpanFor(null)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
            {adding ? (
              <ExpressionAdder sentence={s} onDone={() => setAdding(false)} />
            ) : (
              <Button variant="secondary" size="sm" className="mt-2" onClick={() => setAdding(true)}>
                + 핵심 표현 추가
              </Button>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <Badge tone={st.tone}>{st.label}</Badge>
            {s.origin && <Badge>{s.origin === 'transcript' ? '자막에서 선택' : '직접 입력'}</Badge>}
            {s.timestampSec != null &&
              (onSeek ? (
                <button type="button" className="inline-flex items-center gap-1 font-semibold text-brand" onClick={() => onSeek(s.timestampSec!)}>
                  <Icon name="clock" className="size-3.5" /> {formatTimestamp(s.timestampSec)}
                </button>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <Icon name="clock" className="size-3.5" /> {formatTimestamp(s.timestampSec)}
                </span>
              ))}
            {usedIn && (
              <Link to={`/dialogues/${usedIn.id}`} className="font-semibold text-brand">
                대화문 {usedIn.orderInVideo}에서 사용
              </Link>
            )}
            <span className="ml-auto flex gap-1">
              {!editing && (
                <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                  번역·상황 수정
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={blocker !== null}
                title={blocker ?? undefined}
                onClick={async () => {
                  const ok = await confirm({
                    title: '이 문장의 선정을 취소할까요?',
                    message: `‘${s.english}’ 문장이 핵심 문장 목록에서 빠집니다. 연결된 표현과 다른 학습 기록은 그대로 남습니다.`,
                    confirmLabel: '선정 취소',
                    danger: true,
                  });
                  if (!ok) return;
                  try {
                    await removeKeySentence(repos, s.id, { day, linkedIds });
                    toast('선정을 취소했어요');
                  } catch (e) {
                    toast(errorMessage(e), 'error');
                  }
                }}
              >
                선정 취소
              </Button>
            </span>
          </div>
          {blocker && <p className="mt-1 text-right text-xs text-subtle">{blocker}</p>}
        </div>
      </div>
    </Card>
  );
}

function DetailsEditor({ sentence, onDone }: { sentence: KeySentence; onDone: () => void }) {
  const toast = useToast();
  const [korean, setKorean] = useState(sentence.korean);
  const [situation, setSituation] = useState(sentence.situation);
  const [time, setTime] = useState(formatTimestamp(sentence.timestampSec) ?? '');
  const sec = parseTimestamp(time);
  const timeInvalid = sec !== null && Number.isNaN(sec);

  return (
    <div className="mt-3 space-y-3">
      <Field label="번역">
        <TextInput value={korean} onChange={(e) => setKorean(e.target.value)} aria-label="번역" />
      </Field>
      <Field label="사용 상황">
        <TextInput value={situation} onChange={(e) => setSituation(e.target.value)} aria-label="사용 상황" />
      </Field>
      <Field label="영상 시간 (선택)" hint={timeInvalid ? '“1:05”처럼 입력해 주세요.' : '예: 1:05'}>
        <TextInput value={time} onChange={(e) => setTime(e.target.value)} inputMode="numeric" aria-label="영상 시간" className="max-w-40" />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onDone}>
          취소
        </Button>
        <Button
          size="sm"
          disabled={timeInvalid}
          onClick={async () => {
            await updateKeySentenceDetails(repos, sentence.id, { korean, situation, timestampSec: sec });
            toast('저장했어요');
            onDone();
          }}
        >
          저장
        </Button>
      </div>
    </div>
  );
}

function ExpressionAdder({ sentence, onDone }: { sentence: KeySentence; onDone: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [meaning, setMeaning] = useState('');
  const [span, setSpan] = useState<TextSpan | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-line bg-surface p-3">
      <TokenRangePicker
        text={sentence.english}
        value={span}
        onChange={(sp) => {
          setSpan(sp);
          // 고른 단어로 표현 칸을 채워 준다 (사전형으로 바꾸고 싶으면 직접 수정)
          if (sp) setText(sentence.english.slice(sp.start, sp.end));
        }}
        label="문장에서 핵심 표현 부분을 누르세요"
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="표현 (사전형으로 고쳐도 돼요)" hint="예: slipped my mind → slip my mind">
          <TextInput value={text} onChange={(e) => setText(e.target.value)} aria-label="핵심 표현" />
        </Field>
        <Field label="뜻">
          <TextInput value={meaning} onChange={(e) => setMeaning(e.target.value)} aria-label="표현 뜻" />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onDone}>
          취소
        </Button>
        <Button
          size="sm"
          disabled={!text.trim() || busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await linkExpression(repos, sentence.id, { text, meaningKo: meaning, span: span ?? undefined });
              toast(r.spanFound ? '핵심 표현을 연결했어요' : '연결했어요. 문장 속 위치는 직접 지정해 주세요', r.spanFound ? 'success' : 'info');
              onDone();
            } catch (e) {
              toast(errorMessage(e), 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          연결
        </Button>
      </div>
    </div>
  );
}

function SpanEditor({
  sentence,
  initial,
  onSave,
  onCancel,
}: {
  sentence: KeySentence;
  initial: TextSpan | null;
  onSave: (span: TextSpan) => Promise<void>;
  onCancel: () => void;
}) {
  const [span, setSpan] = useState<TextSpan | null>(initial);
  return (
    <div className="mt-2 space-y-2 rounded-xl border border-line bg-surface p-3">
      <TokenRangePicker text={sentence.english} value={span} onChange={setSpan} label="빈칸으로 만들 표현 부분" />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          취소
        </Button>
        <Button size="sm" disabled={!span} onClick={() => span && onSave(span)}>
          위치 저장
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────

function AddSentencePanel({ video, transcript, sentences, day }: { video: Video; transcript: Transcript | undefined; sentences: KeySentence[]; day: boolean }) {
  const segments = transcript?.status === 'success' ? transcript.segments : [];
  const [mode, setMode] = useState<'transcript' | 'manual'>(segments.length > 0 ? 'transcript' : 'manual');

  return (
    <Card className="p-4" data-testid="add-key-sentence">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-bold">핵심 문장 추가</h3>
        <div className="flex gap-1 rounded-xl bg-canvas p-1" role="tablist">
          {(
            [
              ['transcript', '자막에서 선택'],
              ['manual', '직접 입력'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={mode === k}
              onClick={() => setMode(k)}
              className={`h-9 rounded-lg px-3 text-sm font-semibold ${mode === k ? 'bg-surface text-ink shadow-sm' : 'text-muted'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {mode === 'transcript' ? (
        segments.length > 0 ? (
          <TranscriptPicker video={video} segments={segments} sentences={sentences} day={day} />
        ) : (
          <p className="mt-3 rounded-xl bg-canvas p-3 text-sm text-muted">
            저장된 자막이 없어요. <b className="text-ink">자막</b> 탭에서 자막을 붙여넣거나, <b className="text-ink">직접 입력</b>으로 문장을 추가하세요.
          </p>
        )
      ) : (
        <ManualSentenceForm video={video} day={day} />
      )}
    </Card>
  );
}

function useAddSentence(video: Video, day = false) {
  const confirm = useConfirm();
  const toast = useToast();
  return async (input: { english: string; korean: string; situation: string; timestampSec: number | null; origin: 'transcript' | 'manual' }) => {
    const ok = await confirm({
      title: '핵심 문장으로 저장할까요?',
      message: `“${cleanOriginal(input.english)}”\n\n영어 원문은 저장한 뒤 고칠 수 없어요. 영상 속 문장과 같은지 확인해 주세요.`,
      confirmLabel: '저장',
    });
    if (!ok) return false;
    try {
      await addKeySentence(repos, video.id, input, { day });
      toast('핵심 문장을 추가했어요');
      return true;
    } catch (e) {
      toast(e instanceof KeySentenceError ? e.message : errorMessage(e), 'error');
      return false;
    }
  };
}

function TranscriptPicker({
  video,
  segments,
  sentences,
  day,
}: {
  video: Video;
  segments: Transcript['segments'];
  sentences: KeySentence[];
  day: boolean;
}) {
  const add = useAddSentence(video, day);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [trim, setTrim] = useState<TextSpan | null>(null);
  const [korean, setKorean] = useState('');
  const [situation, setSituation] = useState('');
  const [query, setQuery] = useState('');

  const joined = range ? cleanOriginal(segments.slice(range[0], range[1] + 1).map((s) => s.text).join(' ')) : '';
  const english = trim ? joined.slice(trim.start, trim.end) : joined;
  const picked = useMemo(() => new Set(sentences.map((s) => normalizeExpressionKey(s.english))), [sentences]);
  const isPicked = (text: string) => [...picked].some((p) => normalizeExpressionKey(text).includes(p));
  const visible = segments
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !query.trim() || s.text.toLowerCase().includes(query.trim().toLowerCase()));

  const reset = () => {
    setRange(null);
    setTrim(null);
    setKorean('');
    setSituation('');
  };

  return (
    <div className="mt-3 space-y-3">
      <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="자막에서 찾기 (영어 단어)" aria-label="자막 검색" />
      <ol className="max-h-80 space-y-1 overflow-y-auto rounded-xl border border-line p-1.5" data-testid="transcript-pick-list">
        {visible.map(({ s, i }) => {
          const selected = range != null && i >= range[0] && i <= range[1];
          return (
            <li key={i}>
              <button
                type="button"
                onClick={() => {
                  setRange([i, i]);
                  setTrim(null);
                }}
                aria-pressed={selected}
                className={`flex w-full gap-3 rounded-lg px-2 py-2 text-left text-[15px] ${selected ? 'bg-brand-soft ring-1 ring-brand' : 'hover:bg-canvas'}`}
              >
                <span className="w-12 shrink-0 pt-0.5 text-xs text-subtle tabular-nums">{formatTimestamp(s.startSec) ?? '—'}</span>
                <span className="en min-w-0 flex-1">{s.text}</span>
                {isPicked(s.text) && <Badge tone="key">선정됨</Badge>}
              </button>
            </li>
          );
        })}
        {visible.length === 0 && <li className="p-3 text-sm text-subtle">찾는 단어가 있는 자막이 없어요.</li>}
      </ol>

      {range && (
        <div className="space-y-3 rounded-xl bg-canvas p-3" data-testid="transcript-selection">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold">선택한 자막 {range[1] - range[0] + 1}줄</span>
            <Button variant="secondary" size="sm" disabled={range[0] === 0} onClick={() => (setRange([range[0] - 1, range[1]]), setTrim(null))}>
              앞 줄 포함
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={range[1] >= segments.length - 1}
              onClick={() => (setRange([range[0], range[1] + 1]), setTrim(null))}
            >
              다음 줄 포함
            </Button>
          </div>
          <p className="text-xs text-muted">자막 한 줄에 문장이 나뉘어 있으면 앞·다음 줄을 포함하고, 필요 없는 앞뒤 말은 아래에서 단어를 골라 빼세요.</p>
          <TokenRangePicker text={joined} value={trim} onChange={setTrim} label="문장 일부만 쓰려면 첫 단어와 마지막 단어를 누르세요" />
          <div className="rounded-lg bg-surface p-3">
            <p className="text-xs font-semibold text-muted">저장될 영어 원문</p>
            <p className="en mt-0.5 text-[17px] font-semibold" data-testid="pending-english">
              {english}
            </p>
            {day && <DayLengthNote english={english} />}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="번역 (선택)">
              <TextInput value={korean} onChange={(e) => setKorean(e.target.value)} aria-label="새 문장 번역" />
            </Field>
            <Field label="사용 상황 (선택)">
              <TextInput value={situation} onChange={(e) => setSituation(e.target.value)} aria-label="새 문장 사용 상황" />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={reset}>
              선택 취소
            </Button>
            <Button
              size="sm"
              disabled={!english.trim() || (day && tooLongForDay(english))}
              onClick={async () => {
                const ok = await add({ english, korean, situation, timestampSec: segments[range[0]].startSec, origin: 'transcript' });
                if (ok) reset();
              }}
            >
              핵심 문장으로 저장
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ManualSentenceForm({ video, day }: { video: Video; day: boolean }) {
  const add = useAddSentence(video, day);
  const [english, setEnglish] = useState('');
  const [korean, setKorean] = useState('');
  const [situation, setSituation] = useState('');
  const [time, setTime] = useState('');
  const sec = parseTimestamp(time);
  const timeInvalid = sec !== null && Number.isNaN(sec);

  return (
    <div className="mt-3 space-y-3">
      <Field label="영어 문장 (영상 원문 그대로)" hint="저장한 뒤에는 고칠 수 없어요. 철자와 구두점까지 영상과 같게 입력해 주세요.">
        <TextArea value={english} onChange={(e) => setEnglish(e.target.value)} rows={2} className="en" aria-label="영어 문장" />
      </Field>
      {day && <DayLengthNote english={english} />}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="번역 (선택)">
          <TextInput value={korean} onChange={(e) => setKorean(e.target.value)} aria-label="번역 입력" />
        </Field>
        <Field label="사용 상황 (선택)">
          <TextInput value={situation} onChange={(e) => setSituation(e.target.value)} aria-label="사용 상황 입력" />
        </Field>
        <Field label="영상 시간 (선택)" hint={timeInvalid ? '“1:05”처럼 입력해 주세요.' : '예: 1:05'}>
          <TextInput value={time} onChange={(e) => setTime(e.target.value)} inputMode="numeric" aria-label="영상 시간 입력" />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!english.trim() || timeInvalid || (day && tooLongForDay(english))}
          onClick={async () => {
            const ok = await add({ english, korean, situation, timestampSec: sec, origin: 'manual' });
            if (ok) {
              setEnglish('');
              setKorean('');
              setSituation('');
              setTime('');
            }
          }}
        >
          핵심 문장으로 저장
        </Button>
      </div>
    </div>
  );
}

/** Day 자료 문장 길이 (저장할 때와 같은 기준: 공백만 정리한 원문) */
const tooLongForDay = (english: string) => cleanOriginal(english).length > DAY_SENTENCE_CHARS;

/** Day 영상: 500자를 넘으면 저장 버튼을 막고 이유를 바로 보여 준다 (원문은 자르지 않음) */
function DayLengthNote({ english }: { english: string }) {
  const n = cleanOriginal(english).length;
  if (n <= DAY_SENTENCE_CHARS) return null;
  return (
    <p role="alert" className="mt-1 text-sm text-danger" data-testid="day-length-error">
      Day 자료 문장은 {DAY_SENTENCE_CHARS}자까지예요 (지금 {n}자). 원문을 자르지 않으므로 이대로는 저장할 수 없어요 — 문장을 나눠서 넣어 주세요.
    </p>
  );
}
