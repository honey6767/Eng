import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { NAV_ITEMS } from '@/components/layout/navItems';

export function MorePage() {
  const items = NAV_ITEMS.filter((n) => ['/expressions', '/favorites', '/settings'].includes(n.to));
  return (
    <div>
      <PageHeader title="더보기" />
      <Card className="divide-y divide-line">
        {items.map((item) => (
          <Link key={item.to} to={item.to} className="flex h-14 items-center gap-3 px-4 font-semibold hover:bg-canvas">
            <Icon name={item.icon} className="size-5 text-muted" />
            {item.label === '표현' ? '표현 노트' : item.label}
            <Icon name="chevronRight" className="ml-auto size-4 text-subtle" />
          </Link>
        ))}
      </Card>
    </div>
  );
}
