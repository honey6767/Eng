/** 태평양 시간(Gemini·서버 일일 한도 초기화 기준) */
const PACIFIC = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
export const pacificDay = (ms: number) => PACIFIC.format(new Date(ms));

/** 다음 태평양 시간 자정 (ISO) */
export function nextPacificMidnight(ms: number): string {
  const today = pacificDay(ms);
  let t = Math.ceil(ms / 3_600_000) * 3_600_000;
  for (let i = 0; i < 48 && pacificDay(t) === today; i++) t += 3_600_000;
  return new Date(t).toISOString();
}
