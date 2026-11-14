import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { Icon } from '@/components/ui/Icon';
import { MOBILE_TABS, MORE_PATHS, NAV_ITEMS } from './navItems';

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <img src="/favicon.svg" alt="" className="size-8" />
      <div className="leading-tight">
        <p className="text-[15px] font-extrabold tracking-tight text-ink">My English Study</p>
        <p className="text-[11px] text-subtle">대화문으로 외우는 영어 회화</p>
      </div>
    </div>
  );
}

export function AppShell() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to));

  return (
    <div className="min-h-dvh lg:flex">
      {/* PC 사이드바 */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface px-4 py-6 lg:flex">
        <Logo />
        <nav className="mt-8 flex flex-col gap-1" aria-label="주 메뉴">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive: a }) =>
                `flex h-11 items-center gap-3 rounded-xl px-3 text-[15px] font-semibold transition-colors ${
                  a ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-canvas hover:text-ink'
                }`
              }
            >
              <Icon name={item.icon} className="size-5" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <p className="mt-auto text-xs leading-relaxed text-subtle">
          데이터는 이 기기의 브라우저에만 저장됩니다.
        </p>
      </aside>

      <div className="min-w-0 flex-1">
        {/* 모바일 상단 바 */}
        <header className="sticky top-0 z-30 flex h-14 items-center border-b border-line bg-canvas/90 px-4 backdrop-blur lg:hidden">
          <Logo />
        </header>

        <main className="mx-auto w-full max-w-5xl px-4 pt-5 pb-28 sm:px-6 lg:px-10 lg:pt-10 lg:pb-16">
          <Outlet />
        </main>
      </div>

      {/* 모바일 하단 탭 */}
      <nav
        aria-label="하단 메뉴"
        className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur lg:hidden"
      >
        <ul className="mx-auto flex max-w-lg">
          {MOBILE_TABS.map((tab) => {
            const active = tab.to === '/more' ? MORE_PATHS.some((p) => pathname.startsWith(p)) : isActive(tab.to);
            return (
              <li key={tab.to} className="flex-1">
                <NavLink
                  to={tab.to}
                  aria-current={active ? 'page' : undefined}
                  className={`flex flex-col items-center gap-0.5 pt-2 pb-1 text-[11px] font-semibold ${
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
