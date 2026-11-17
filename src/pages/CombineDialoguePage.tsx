import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { contentStore } from '@/repositories';
import { useLiveData } from '@/hooks/useLiveData';
import { useToast } from '@/hooks/useToast';
import {
  buildDialogueRequest,
  defaultChecked,
  dialogueDeps,
  generateCombinedDialogue,
  loadGroups,
  pendingDialogueTask,
  recommendGroups,
  type DialogueProgress,
} from '@/services/dialogue';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Loading } from '@/components/ui/Loading';

/**
 * 통합 대화문 만들기 — 여러 Day에서 배운 Chunk를 한 상황의 자연스러운 대화로.
 * 기본: 최근 학습한 Day 2~3개, 그 안에서 학습함·선택함인 Chunk만 체크. 사용자가 Day·Chunk를 바꿀 수 있다.
 */
export function CombineDialoguePage() {
  const toast = useToast();
  const navigate = useNavigate();
  const data = useLiveData(async () => ({ groups: await loadGroups(contentStore), pending: await pendingDialogueTask(contentStore) }), []);
  const [groupKeys, setGroupKeys] = useState<string[] | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [lines, setLines] = useState(10);
  const [progress, setProgress] = useState<DialogueProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!data || groupKeys) return;
    const rec = recommendGroups(data.groups);
    setGroupKeys(rec);
    setChecked(defaultChecked(data.groups, rec));
  }, [data, groupKeys]);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const recommended = useMemo(() => (data ? recommendGroups(data.groups) : []), [data]);
  if (!data || !groupKeys) return <Loading />;
  const { groups, pending } = data;
  const chosen = groups.filter((g) => groupKeys.includes(g.key));
  const checkedInChosen = checked.filter((id) => chosen.some((g) => g.chunks.some((c) => c.item.id === id)));
  const daysUsed = new Set(chosen.filter((g) => g.chunks.some((c) => checkedInChosen.includes(c.item.id))).map((g) => g.key));

  const toggleGroup = (key: string) => {
    if (groupKeys.includes(key)) {
      setGroupKeys(groupKeys.filter((k) => k !== key));
    } else {
      setGroupKeys([...groupKeys, key]);
      // 새로 고른 Day는 학습함·선택함인 Chunk를 미리 체크
      setChecked([...new Set([...checked, ...defaultChecked(groups, [key])])]);
    }
  };
  const toggleChunk = (id: string) => setChecked(checked.includes(id) ? checked.filter((x) => x !== id) : [...checked, id]);

  const generate = async () => {
    const req = buildDialogueRequest(groups, checkedInChosen, lines);
    if ('error' in req) {
      toast(req.error);
      return;
    }
    setBusy(true);
    try {
      const p = await generateCombinedDialogue(dialogueDeps, req, setProgress);
      if (p.phase === 'succeeded') {
        toast(`통합 대화문을 저장했어요 (Chunk ${p.used}개)`);
        navigate(`/dialogues/${p.dialogueId}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="combine-page">
      <PageHeader back={{ to: '/dialogues', label: '외우기' }} title="통합 대화문 만들기" description="여러 Day에서 배운 Chunk를 한 상황의 자연스러운 대화로 엮어요." />

      {pending && (
        <Card className="p-4 text-sm" data-testid="combine-pending">
          이전에 보낸 통합 대화문 요청이 아직 끝나지 않았어요. ‘대화문 만들기’를 누르면 <b>새로 만들지 않고</b> 그 결과부터 확인해요.
        </Card>
      )}

      {groups.length === 0 ? (
        <Card className="p-5 text-sm text-muted" data-testid="combine-empty">
          아직 쓸 수 있는 Chunk가 없어요. 영상의 ‘핵심 문장·Chunk’ 탭에서 원문 문장·Chunk를 먼저 만들어 주세요.
        </Card>
      ) : (
        <>
          <section>
            <h2 className="mb-2 font-bold">1. Day 고르기</h2>
            <p className="mb-2 text-sm text-muted">기본은 최근 학습한 Day {recommended.length}개예요. 다른 Day도 직접 고를 수 있어요.</p>
            <div className="flex flex-wrap gap-2">
              {groups.map((g) => {
                const on = groupKeys.includes(g.key);
                return (
                  <button
                    key={g.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleGroup(g.key)}
                    data-testid={`group-${g.key}`}
                    className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-semibold transition-colors ${on ? 'bg-ink text-white' : 'border border-line bg-surface text-muted hover:text-ink'}`}
                  >
                    <span className="truncate">{g.dayNumber ? g.label : `일반 · ${g.label}`}</span>
                    <span className="opacity-70">{g.chunks.length}</span>
                    {recommended.includes(g.key) && <span className="text-[11px] opacity-80">최근</span>}
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <h2 className="mb-2 font-bold">2. Chunk 고르기</h2>
            <p className="mb-2 text-sm text-muted">
              ‘학습함’(복습 기록 있음)과 ‘고름’(암기할 Chunk) 표시가 있는 것이 미리 체크돼요. 체크한 Chunk만 대화문에 쓰여요.
            </p>
            <div className="space-y-3">
              {chosen.map((g) => (
                <Card key={g.key} className="p-3.5">
                  <p className="mb-2 font-bold">{g.dayNumber ? g.label : `일반 영상 · ${g.label}`}</p>
                  <ul className="space-y-1.5">
                    {g.chunks.map((c) => (
                      <li key={c.item.id}>
                        <label className="flex cursor-pointer items-start gap-2.5 rounded-xl p-2 hover:bg-canvas">
                          <input type="checkbox" className="mt-1" checked={checked.includes(c.item.id)} onChange={() => toggleChunk(c.item.id)} data-testid="combine-chunk" />
                          <span className="min-w-0 flex-1">
                            <span className="en font-semibold text-ink">{c.learnText ?? c.expression.text}</span>
                            {c.originText && <span className="ml-1 text-xs text-subtle">(원문: <span className="en">{c.originText}</span>)</span>}
                            {c.role === 'core' && <Badge tone="key" className="ml-2">{c.coreOf ? `★ 핵심 ${c.coreOf} 활용` : '★ 핵심'}</Badge>}
                            {c.role === 'extra' && <Badge tone="info" className="ml-2">✨ 유용한 표현</Badge>}
                            {c.expression.meaningKo && <span className="ml-2 text-sm text-muted">{c.expression.meaningKo}</span>}
                            {c.learned && <Badge tone="ok" className="ml-2">학습함</Badge>}
                            {c.selected && <Badge tone="brand" className="ml-1">고름</Badge>}
                            {c.sentence && <span className="mt-0.5 block truncate text-xs text-subtle">“{c.sentence}”</span>}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </Card>
              ))}
              {chosen.length === 0 && <Card className="p-4 text-sm text-muted">위에서 Day를 하나 이상 골라 주세요.</Card>}
            </div>
          </section>

          <section>
            <h2 className="mb-2 font-bold">3. 만들기</h2>
            <Card className="space-y-3 p-4">
              <p className="text-sm" data-testid="combine-summary">
                고른 Chunk <b>{checkedInChosen.length}개</b> · Day/영상 <b>{daysUsed.size}곳</b>
                {daysUsed.size === 1 && <span className="ml-1 text-warn">(서로 다른 Day를 2곳 이상 고르면 더 좋아요)</span>}
              </p>
              <label className="flex items-center gap-2 text-sm">
                대화 길이
                <select className="h-10 rounded-xl border border-line-strong bg-surface px-2" value={lines} onChange={(e) => setLines(Number(e.target.value))}>
                  <option value={8}>짧게 (8줄 안팎)</option>
                  <option value={10}>보통 (10줄 안팎)</option>
                  <option value={14}>길게 (14줄 안팎)</option>
                </select>
              </label>
              {progress && <DialogueStatus p={progress} />}
              <Button disabled={busy || checkedInChosen.length < 2} onClick={() => void generate()} data-testid="combine-generate">
                {busy ? '만드는 중…' : '대화문 만들기'}
              </Button>
              <p className="text-xs text-subtle">무료 한도 안에서 한 번에 하나만 만들어요. 기존 대화문과 학습 기록은 그대로 두고 새 대화문만 추가해요.</p>
            </Card>
          </section>
        </>
      )}
      <p className="text-center text-sm">
        <Link to="/dialogues" className="text-brand underline underline-offset-2">대화문 목록으로</Link>
      </p>
    </div>
  );
}

function DialogueStatus({ p }: { p: DialogueProgress }) {
  const since = p.phase === 'processing' ? p.since : null;
  const s = since ? Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000)) : 0;
  return (
    <div className="rounded-xl bg-canvas px-3 py-2.5 text-sm" role="status" data-testid="combine-status" data-phase={p.phase}>
      {p.phase === 'sending' && <p className="font-semibold text-brand">요청 보내는 중…</p>}
      {p.phase === 'processing' && (
        <>
          <p className="font-semibold text-brand">대화문 만드는 중 · {s}초 경과</p>
          {p.note && <p className="mt-1 text-xs text-subtle">{p.note}</p>}
        </>
      )}
      {p.phase === 'succeeded' && <p className="font-semibold text-ok">저장 완료 — Chunk {p.used}개 사용{p.unused ? ` · 자연스럽게 넣기 어려워 뺀 Chunk ${p.unused}개` : ''}</p>}
      {p.phase === 'failed' && (
        <>
          <p className="font-semibold text-danger" data-testid="combine-error">
            실패{p.httpStatus ? ` · HTTP ${p.httpStatus}` : ''} · {p.code}
          </p>
          <p className="mt-1 text-xs text-muted">{p.message}</p>
        </>
      )}
    </div>
  );
}
