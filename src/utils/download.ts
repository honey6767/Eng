/** 텍스트를 파일로 내려받기 (iPad Safari: 파일 앱 '다운로드'에 저장됨) */
export function downloadTextFile(fileName: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Safari가 다운로드를 시작할 시간을 준 뒤 해제
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** 공유 시트로 파일 보내기 (지원하는 기기만). 지원하지 않으면 false */
export async function shareTextFile(fileName: string, text: string, mime = 'application/json'): Promise<boolean> {
  if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function' || typeof File === 'undefined') return false;
  const file = new File([text], fileName, { type: mime });
  if (!navigator.canShare({ files: [file] })) return false;
  await navigator.share({ files: [file], title: fileName });
  return true;
}

export function canShareFiles(): boolean {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function' || typeof File === 'undefined') return false;
    return navigator.canShare({ files: [new File(['{}'], 'x.json', { type: 'application/json' })] });
  } catch {
    return false;
  }
}
