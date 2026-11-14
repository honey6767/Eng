import { useState } from 'react';
import { repos } from '@/repositories';
import { useConfirm } from '@/hooks/useConfirm';
import { useToast } from '@/hooks/useToast';
import type { ContentOrigin, Expression, ExpressionNote, KeySentence, Video } from '@/types/models';
import { NoteError, saveExpressionNote, type NoteInput } from '@/services/expressionNoteService';
import { formatTimestamp, parseTimestamp } from '@/utils/date';
import { normalizeExpressionKey } from '@/utils/text';
import { ORIGIN } from '@/utils/labels';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Field, TextArea, TextInput } from '@/components/ui/Field';
import { AiAssistCard } from './AiAssistCard';

type Draft = NoteInput & { id?: string };

const emptyDraft = (over: Partial<Draft> = {}): Draft => ({
  expression: '',
  meaningKo: '',
  usageContext: '',
  nuance: '',
  examples: [{ en: '', ko: '' }],
  similar: [],
  sourceTimestampSec: null,
  origin: 'video',
  verification: 'confirmed',
  ...over,
});

const fromNote = (n: ExpressionNote): Draft => ({
  id: n.id,
  expression: n.expression,
  meaningKo: n.meaningKo,
  usageContext: n.usageContext,
  nuance: n.nuance,
  examples: n.examples.length ? n.examples : [{ en: '', ko: '' }],
  similar: n.similar,
  sourceTimestampSec: n.sourceTimestampSec,
  origin: n.origin,
  verification: n.verification,
});

/** 3단계 — 주요(핵심) 표현 노트: 뜻·뉘앙스·사용 상황·예문 (영상 설명 / AI 보충 / 직접 입력 구분) */
export function ExpressionNotesPanel({
  video,
  notes,
  sentences,
  expressions,
}: {
  video: Video;
  notes: ExpressionNote[];
  sentences: KeySentence[];
  expressions: Expression[];
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);

  // 핵심 문장에 연결했지만 아직 노트가 없는 표현
  const noted = new Set(notes.map((n) => normalizeExpressionKey(n.expression)));
  const linked = [...new Set(sentences.flatMap((s) => s.expressionIds))]
    .map((id) => expressions.find((e) => e.id === id))
    .filter((e): e is Expression => !!e && !noted.has(e.normalizedKey));

  const groups = new Map<string, ExpressionNote[]>();
  for (const n of notes) groups.set(n.expression, [...(groups.get(n.expression) ?? []), n]);

  return (
    <div className="space-y-3">
      {notes.length === 0 ? (
        <Card className="p-5">
          <Badge tone="warn">
            <Icon name="alert" className="size-3.5" />
            설명 내용 확인 필요
          </Badge>
          <p className="mt-2 text-sm text-muted">
            아직 정리한 주요 표현이 없어요. 영상에서 설명하지 않은 내용을 앱이 임의로 만들어 표시하지 않습니다. 영상에서 확인한 설명을 직접
            입력하거나, 아래 AI 도움으로 <b className="text-ink">AI 보충</b> 설명을 받아 저장하세요.
          </p>
        </Card>
      ) : (
        <p className="text-sm text-muted">
          영상을 보기 전에 앞부분에서 설명하는 주요 표현을 먼저 복습하세요. <Badge tone="brand">영상 설명</Badge>은 영상에서 확인한 내용,{' '}
          <Badge tone="info">AI 보충</Badge>은 추가 설명입니다.
        </p>
      )}

      {draft ? (
        <NoteEditor
          video={video}
          draft={draft}
          onCancel={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            toast('표현 노트를 저장했어요');
          }}
        />
      ) : (
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => setDraft(emptyDraft())}>
              + 표현 노트 추가
            </Button>
            {linked.length > 0 && <span className="text-xs text-muted">노트가 없는 핵심 표현:</span>}
            {linked.map((e) => (
              <Button key={e.id} variant="secondary" size="sm" onClick={() => setDraft(emptyDraft({ expression: e.text, meaningKo: e.meaningKo }))}>
                <span className="en">{e.text}</span>
              </Button>
            ))}
          </div>
        </Card>
      )}

      {[...groups.entries()].map(([expression, items]) => (
        <Card key={expression} className="p-5" data-testid="expression-note-group">
          <h3 className="en text-lg font-bold">{expression}</h3>
          <p className="text-[15px] text-muted">{items[0].meaningKo}</p>
          <div className="mt-3 space-y-3">
            {items.map((n) => (
              <div
                key={n.id}
                className={`rounded-xl p-3.5 text-sm ${n.origin === 'video' ? 'bg-brand-soft/60' : 'border border-dashed border-info/30 bg-info-soft/40'}`}
              >
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <Badge tone={ORIGIN[n.origin].tone}>{ORIGIN[n.origin].label}</Badge>
                  {n.verification === 'needs_check' && <Badge tone="warn">확인 필요</Badge>}
                  {n.sourceTimestampSec != null && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted">
                      <Icon name="clock" className="size-3.5" />
                      {formatTimestamp(n.sourceTimestampSec)}
                    </span>
                  )}
                  <span className="ml-auto flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setDraft(fromNote(n))}>
                      수정
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        const ok = await confirm({
                          title: '이 설명을 삭제할까요?',
                          message: `‘${n.expression}’의 ${ORIGIN[n.origin].label} 설명 하나만 삭제됩니다. 표현 자체와 즐겨찾기·학습·복습 기록은 그대로 남습니다.`,
                          confirmLabel: '설명 삭제',
                          danger: true,
                        });
                        if (!ok) return;
                        await repos.expressionNotes.remove(n.id);
                        toast('설명을 삭제했어요');
                      }}
                    >
                      삭제
                    </Button>
                  </span>
                </div>
                <dl className="space-y-1.5">
                  {n.usageContext && (
                    <div>
                      <dt className="inline font-semibold">사용 상황 </dt>
                      <dd className="inline text-muted">{n.usageContext}</dd>
                    </div>
                  )}
                  {n.nuance && (
                    <div>
                      <dt className="inline font-semibold">뉘앙스 </dt>
                      <dd className="inline text-muted">{n.nuance}</dd>
                    </div>
                  )}
                </dl>
                {n.examples.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {n.examples.map((ex, i) => (
                      <li key={i} className="border-l-2 border-line-strong pl-2.5">
                        <p className="en text-ink">{ex.en}</p>
                        <p className="text-xs text-muted">{ex.ko}</p>
                      </li>
                    ))}
                  </ul>
                )}
                {n.similar.length > 0 && (
                  <div className="mt-2">
                    <p className="font-semibold">비슷한 표현</p>
                    <ul className="mt-0.5 space-y-0.5 text-muted">
                      {n.similar.map((s, i) => (
                        <li key={i}>
                          <span className="en font-medium text-ink">{s.expression}</span> — {s.difference}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      ))}

      <AiAssistCard video={video} sentences={sentences} expressions={expressions} />
    </div>
  );
}

const ORIGIN_CHOICES: { value: ContentOrigin; label: string; hint: string }[] = [
  { value: 'video', label: '영상 설명', hint: '영상에서 직접 들은 설명' },
  { value: 'user', label: '직접 입력', hint: '내가 정리한 설명' },
  { value: 'ai_supplement', label: 'AI 보충', hint: 'AI가 덧붙인 설명 (항상 확인 필요)' },
];

function NoteEditor({ video, draft: initial, onCancel, onSaved }: { video: Video; draft: Draft; onCancel: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<Draft>(initial);
  const [time, setTime] = useState(formatTimestamp(initial.sourceTimestampSec) ?? '');
  const [busy, setBusy] = useState(false);
  const sec = parseTimestamp(time);
  const timeInvalid = sec !== null && Number.isNaN(sec);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  return (
    <Card className="space-y-3 p-4" data-testid="note-editor">
      <h3 className="font-bold">{d.id ? '표현 노트 수정' : '표현 노트 추가'}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="표현">
          <TextInput value={d.expression} onChange={(e) => set('expression', e.target.value)} className="en" aria-label="노트 표현" />
        </Field>
        <Field label="뜻">
          <TextInput value={d.meaningKo} onChange={(e) => set('meaningKo', e.target.value)} aria-label="노트 뜻" />
        </Field>
      </div>
      <Field label="뉘앙스">
        <TextArea value={d.nuance} onChange={(e) => set('nuance', e.target.value)} rows={2} aria-label="노트 뉘앙스" />
      </Field>
      <Field label="사용 상황">
        <TextArea value={d.usageContext} onChange={(e) => set('usageContext', e.target.value)} rows={2} aria-label="노트 사용 상황" />
      </Field>

      <div>
        <p className="mb-1 text-sm font-semibold">예문</p>
        <div className="space-y-2">
          {d.examples.map((ex, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <TextInput
                value={ex.en}
                placeholder="영어 예문"
                className="en"
                aria-label={`예문 ${i + 1} 영어`}
                onChange={(e) => set('examples', d.examples.map((x, j) => (j === i ? { ...x, en: e.target.value } : x)))}
              />
              <TextInput
                value={ex.ko}
                placeholder="번역"
                aria-label={`예문 ${i + 1} 번역`}
                onChange={(e) => set('examples', d.examples.map((x, j) => (j === i ? { ...x, ko: e.target.value } : x)))}
              />
              <Button variant="ghost" size="sm" onClick={() => set('examples', d.examples.filter((_, j) => j !== i))} aria-label={`예문 ${i + 1} 빼기`}>
                빼기
              </Button>
            </div>
          ))}
        </div>
        <Button variant="secondary" size="sm" className="mt-2" onClick={() => set('examples', [...d.examples, { en: '', ko: '' }])}>
          + 예문
        </Button>
      </div>

      <div>
        <p className="mb-1 text-sm font-semibold">비슷한 표현 (선택)</p>
        <div className="space-y-2">
          {d.similar.map((sm, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <TextInput
                value={sm.expression}
                placeholder="비슷한 표현"
                className="en"
                aria-label={`비슷한 표현 ${i + 1}`}
                onChange={(e) => set('similar', d.similar.map((x, j) => (j === i ? { ...x, expression: e.target.value } : x)))}
              />
              <TextInput
                value={sm.difference}
                placeholder="차이"
                aria-label={`비슷한 표현 ${i + 1} 차이`}
                onChange={(e) => set('similar', d.similar.map((x, j) => (j === i ? { ...x, difference: e.target.value } : x)))}
              />
              <Button variant="ghost" size="sm" onClick={() => set('similar', d.similar.filter((_, j) => j !== i))}>
                빼기
              </Button>
            </div>
          ))}
        </div>
        <Button variant="secondary" size="sm" className="mt-2" onClick={() => set('similar', [...d.similar, { expression: '', difference: '' }])}>
          + 비슷한 표현
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <fieldset>
          <legend className="mb-1 text-sm font-semibold">설명 출처</legend>
          <div className="space-y-1.5">
            {ORIGIN_CHOICES.map((o) => (
              <label key={o.value} className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="note-origin"
                  className="mt-1 accent-[var(--color-brand)]"
                  checked={d.origin === o.value}
                  onChange={() => setD((x) => ({ ...x, origin: o.value, verification: o.value === 'ai_supplement' ? 'needs_check' : x.verification }))}
                />
                <span>
                  <span className="font-semibold">{o.label}</span> <span className="text-muted">— {o.hint}</span>
                </span>
              </label>
            ))}
          </div>
          {d.origin !== 'ai_supplement' && (
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="accent-[var(--color-brand)]"
                checked={d.verification === 'confirmed'}
                onChange={(e) => set('verification', e.target.checked ? 'confirmed' : 'needs_check')}
              />
              내용을 확인했어요 (끄면 ‘확인 필요’로 표시)
            </label>
          )}
        </fieldset>
        <Field label="영상 속 설명 시간 (선택)" hint={timeInvalid ? '“1:05”처럼 입력해 주세요.' : '예: 1:05'}>
          <TextInput value={time} onChange={(e) => setTime(e.target.value)} inputMode="numeric" aria-label="설명 시간" className="max-w-40" />
        </Field>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          취소
        </Button>
        <Button
          disabled={busy || timeInvalid || !d.expression.trim() || !d.meaningKo.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await saveExpressionNote(repos, video.id, { ...d, sourceTimestampSec: sec }, d.id);
              onSaved();
            } catch (e) {
              toast(e instanceof NoteError ? e.message : '저장하지 못했어요', 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          저장
        </Button>
      </div>
    </Card>
  );
}
