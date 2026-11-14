export const DAY_MS = 24 * 60 * 60 * 1000;

export function nowISO(): string {
  return new Date().toISOString();
}

/** 로컬 시간 기준 YYYY-MM-DD */
export function toDateKey(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

/** 로컬 기준 그날 23:59:59.999 */
export function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/** 로컬 기준 해당 주의 월요일 00:00 */
export function startOfWeek(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const diff = (d.getDay() + 6) % 7; // 월=0
  d.setDate(d.getDate() - diff);
  return d;
}

/** 최근 n일의 날짜 키 (오래된 날짜 → 오늘) */
export function lastNDateKeys(n: number, today = new Date()): string[] {
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    keys.push(toDateKey(d));
  }
  return keys;
}

const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];

export function weekdayKo(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return WEEKDAYS_KO[new Date(y, m - 1, d).getDay()];
}

/** '오늘', '내일', '3일 후', '2일 지남' 형태 */
export function relativeDayLabel(iso: string | null, now = new Date()): string {
  if (!iso) return '예정 없음';
  const target = new Date(iso);
  const a = new Date(toDateKey(now)).getTime();
  const b = new Date(toDateKey(target)).getTime();
  const diff = Math.round((b - a) / DAY_MS);
  if (diff === 0) return '오늘';
  if (diff === 1) return '내일';
  if (diff > 1) return `${diff}일 후`;
  return `${-diff}일 지남`;
}

/** 영상 길이: "12분 35초", "1시간 2분 3초", "45초" */
export function formatDuration(sec: number | null): string {
  if (sec == null) return '길이 미확인';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}시간`);
  if (m) parts.push(`${m}분`);
  if (s || parts.length === 0) parts.push(`${s}초`);
  return parts.join(' ');
}

/** 자막/영상 위치: "0:42", "12:05", "1:02:03" */
export function formatTimestamp(sec: number | null): string | null {
  if (sec == null) return null;
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${h ? String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`;
  return h ? `${h}:${mmss}` : mmss;
}

export function formatDateKo(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}
