/**
 * 텍스트 복사. 클릭 핸들러 안에서 호출해야 한다.
 * 일부 환경(오래된 Safari, 앱 내 보기)에서 Clipboard API가 거부되면 예전 방식으로 한 번 더 시도한다.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
