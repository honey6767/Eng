import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Toki } from '@/components/brand/Toki';
import { MOBILE_TABS, MORE_PATHS, NAV_ITEMS, SECONDARY_NAV } from './navItems';

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <Toki stage="kid" size={36} />
      <div className="leading-tight">
        <p className="en text-[15px] font-extrabold tracking-tight text-ink">My English Study</p>
        <p className="text-[11px] text-subtle">대화문으로 외우는 영어 회화</p>
      </div>
    </div>
  );
}

const navClass = (active: boolean, size: 'lg' | 'sm' = 'lg') =>
  `flex items-center gap-3 rounded-2xl px-3.5 transition-colors ${size === 'lg' ? 'h-12 text-[15px] font-bold' : 'h-10 text-sm font-semibold'} ${
    active ? 'bg-brand-soft text-brand-strong' : 'text-muted hover:bg-canvas hover:text-ink'
  }`;

export function AppShell() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to));

  return (
    <div className="min-h-dvh lg:flex">
      {/* 넓은 화면(iPad 가로·PC) 사이드바 */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface px-4 py-6 lg:flex">
        <Logo />
        <nav className="mt-7 flex flex-col gap-4" aria-label="주 메뉴">
          <div className="flex flex-col gap-1">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive: a }) => navClass(a)}>
                <Icon name={item.icon} className="size-5" />
                {item.label}
              </NavLink>
            ))}
          </div>
          {SECONDARY_NAV.map((group) => (
            <div key={group.title} className="flex flex-col gap-0.5 border-t border-line pt-3">
              <p className="px-3.5 pb-1 text-xs font-bold text-subtle">{group.title}</p>
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} className={({ isActive: a }) => navClass(a, 'sm')}>
                  <Icon name={item.icon} className="size-4.5" />
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <p className="mt-auto rounded-2xl bg-canvas p-3 text-xs leading-relaxed text-muted">학습 기록은 이 기기의 브라우저에만 저장돼요.</p>
      </aside>

      <div className="min-w-0 flex-1">
        {/* 좁은 화면 상단 바 */}
        <header className="sticky top-0 z-30 flex h-14 items-center border-b border-line bg-canvas/90 px-4 backdrop-blur sm:px-6 lg:hidden">
          <Logo />
        </header>

        <main className="mx-auto w-full max-w-5xl px-4 pt-5 pb-32 sm:px-6 sm:pt-7 lg:px-10 lg:pt-10 lg:pb-16">
          <Outlet />
        </main>
      </div>

      {/* 좁은 화면(iPad 세로 포함) 하단 탭 */}
      <nav aria-label="하단 메뉴" className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur lg:hidden">
        <ul className="mx-auto flex max-w-2xl">
          {MOBILE_TABS.map((tab) => {
            const active = tab.to === '/more' ? MORE_PATHS.some((p) => pathname.startsWith(p)) : isActive(tab.to);
            return (
              <li key={tab.to} className="flex-1">
                <NavLink
                  to={tab.to}
                  aria-current={active ? 'page' : undefined}
                  className={`flex min-h-14 flex-col items-center justify-center gap-0.5 pt-2 pb-1 text-xs font-bold ${
                    active ? 'text-brand' : 'text-subtle'
                  }`}
                >
                  <Icon name={tab.icon} className="size-6" />
                  {tab.label}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
