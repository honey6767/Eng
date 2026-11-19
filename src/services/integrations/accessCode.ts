/**
 * 기기별 접근 코드 — 이 브라우저(이 기기의 이 브라우저, 이 주소)에만 저장한다.
 *
 * - 저장 위치: localStorage (키 'mes:accessCode'). 서버·IndexedDB 학습 데이터에는 저장하지 않으므로
 *   B0 백업 파일(IndexedDB만 내보냄)에 들어가지 않고, 복원으로 바뀌지도 않는다.
 * - 다른 기기·다른 브라우저, iPad 홈 화면 앱과 Safari 탭은 저장 공간이 서로 달라 각각 따로 입력한다.
 * - 한계: 이 기기를 쓸 수 있는 사람(또는 이 주소에서 실행되는 스크립트)은 저장된 코드를 볼 수 있다.
 *   그래서 YouTube 프록시 사용 권한에만 쓰고, 학습 데이터 보호용 비밀번호로 쓰지 않는다.
 */

const CODE_KEY = 'mes:accessCode';
const SKIP_KEY = 'mes:accessCodeSkipped';

type Listener = () => void;
const listeners = new Set<Listener>();
/** 서버가 저장된 코드를 거부했을 때 (코드 변경 등) — 다시 입력 화면을 보여 주기 위한 표시 (메모리만) */
let rejected = false;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* 저장 못 하는 환경(사생활 보호 모드 등) — 이번 실행 동안만 동작하지 않음 */
  }
}
const emit = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  // 같은 브라우저의 다른 탭에서 바뀌면 반영
  window.addEventListener('storage', (e) => {
    if (e.key === CODE_KEY || e.key === SKIP_KEY || e.key === null) emit();
  });
}

export const accessCodeStore = {
  get: (): string | null => {
    const v = read(CODE_KEY);
    return v && v.trim() ? v : null;
  },
  /** 서버 확인을 마친 코드만 저장한다 */
  save(code: string) {
    write(CODE_KEY, code.trim());
    write(SKIP_KEY, null);
    rejected = false;
    emit();
  },
  /** 로그아웃: 이 브라우저에서 코드와 '건너뛰기' 표시를 지운다 */
  clear() {
    write(CODE_KEY, null);
    write(SKIP_KEY, null);
    rejected = false;
    emit();
  },
  isSkipped: () => read(SKIP_KEY) === '1',
  /** 지금은 건너뛰기 — 서버가 거부한 옛 코드가 남아 있으면 함께 지운다 */
  skip() {
    write(SKIP_KEY, '1');
    if (rejected) write(CODE_KEY, null);
    rejected = false;
    emit();
  },
  isRejected: () => rejected,
  markRejected() {
    if (rejected) return;
    rejected = true;
    emit();
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

/** 이 서버 주소로 접근 코드를 보내도 되는지 — 같은 주소(/api) 또는 HTTPS 주소만 (http 원격 주소로는 보내지 않음) */
export function canSendAccessCode(apiBaseUrl: string | null): boolean {
  if (!apiBaseUrl) return true;
  try {
    const u = new URL(apiBaseUrl);
    return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}
