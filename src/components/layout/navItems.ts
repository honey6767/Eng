import type { IconName } from '@/components/ui/Icon';

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
}

/** 학습 중심 주 메뉴 — 사이드바 위쪽과 하단 탭 */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: '홈', icon: 'home' },
  { to: '/dialogues', label: '외우기', icon: 'chat' },
  { to: '/review', label: '복습', icon: 'review' },
  { to: '/collection', label: '컬렉션', icon: 'award' },
];

/** 콘텐츠 준비·기록·설정 — 사이드바 아래쪽, 좁은 화면에서는 '더보기' 안 */
export const SECONDARY_NAV: { title: string; items: NavItem[] }[] = [
  {
    title: '콘텐츠 준비',
    items: [
      { to: '/videos', label: '영상 · 핵심 표현', icon: 'video' },
      { to: '/expressions', label: '표현 노트', icon: 'book' },
      { to: '/extraction', label: '자료 생성', icon: 'sparkle' },
      { to: '/days', label: 'Day 정리', icon: 'clock' },
    ],
  },
  {
    title: '내 기록',
    items: [{ to: '/favorites', label: '즐겨찾기', icon: 'star' }],
  },
  {
    title: '앱',
    items: [{ to: '/settings', label: '설정', icon: 'settings' }],
  },
];

/** 좁은 화면(iPad 세로 포함) 하단 탭 */
export const MOBILE_TABS: NavItem[] = [...NAV_ITEMS, { to: '/more', label: '더보기', icon: 'more' }];

/** '더보기' 탭이 활성으로 보일 경로 */
export const MORE_PATHS = ['/more', '/videos', '/expressions', '/extraction', '/days', '/favorites', '/settings'];
