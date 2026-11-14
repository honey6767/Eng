import type { IconName } from '@/components/ui/Icon';

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: '홈', icon: 'home' },
  { to: '/videos', label: '영상', icon: 'video' },
  { to: '/dialogues', label: '대화문', icon: 'chat' },
  { to: '/review', label: '복습', icon: 'review' },
  { to: '/expressions', label: '표현', icon: 'book' },
  { to: '/favorites', label: '즐겨찾기', icon: 'star' },
  { to: '/settings', label: '설정', icon: 'settings' },
];

/** 모바일 하단 탭 (나머지는 '더보기') */
export const MOBILE_TABS: NavItem[] = [
  ...NAV_ITEMS.slice(0, 4),
  { to: '/more', label: '더보기', icon: 'more' },
];

export const MORE_PATHS = ['/more', '/expressions', '/favorites', '/settings'];
