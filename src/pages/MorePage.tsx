import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { SECONDARY_NAV } from '@/components/layout/navItems';

const HINTS: Record<string, string> = {
  '/videos': '영상 등록, 자막, 핵심 표현 정리',
  '/expressions': '모은 표현과 뜻 · 어려워요 표시',
  '/extraction': '자동 자막 추출 진행 · 확인 필요 항목',
  '/days': '영상별 Day 번호 확정',
  '/favorites': '즐겨찾기한 대화문과 표현',
  '/ai-questions': 'Chunk별로 AI에게 물어본 질문과 답변',
  '/settings': '데이터 · YouTube 연결 · 샘플 데이터',
};

export function MorePage() {
  return (
    <div className="space-y-5">
      <PageHeader title="더보기" description="콘텐츠 준비와 기록, 설정을 모아 두었어요." />
      {SECONDARY_NAV.map((group) => (
        <section key={group.title} aria-label={group.title}>
          <h2 className="mb-2 px-1 text-sm font-bold text-muted">{group.title}</h2>
          <Card className="divide-y divide-line overflow-hidden">
            {group.items.map((item) => (
              <Link key={item.to} to={item.to} className="flex min-h-16 items-center gap-3.5 px-4 py-3 hover:bg-canvas">
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-brand-soft text-brand">
                  <Icon name={item.icon} className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-bold">{item.label}</span>
                  {HINTS[item.to] && <span className="block text-sm text-muted">{HINTS[item.to]}</span>}
                </span>
                <Icon name="chevronRight" className="size-4 text-subtle" />
              </Link>
            ))}
          </Card>
        </section>
      ))}
    </div>
  );
}
