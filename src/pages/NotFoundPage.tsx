import { LinkButton } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Card } from '@/components/ui/Card';

export function NotFoundPage({ message = '페이지를 찾을 수 없어요.' }: { message?: string }) {
  return (
    <Card className="mt-6">
      <EmptyState icon="alert" title={message}>
        <LinkButton to="/" variant="secondary" size="sm" className="mt-3">
          홈으로
        </LinkButton>
      </EmptyState>
    </Card>
  );
}
