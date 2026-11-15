/**
 * 홈 화면용 앱 아이콘(PNG) 만들기 — favicon.svg와 같은 그림을 정사각형 바탕에 맞춰 그린다.
 * 사용법: node scripts/generate-icons.mjs  (결과: public/ 아래 PNG 4개, 저장소에 함께 커밋)
 *
 * - apple-touch-icon.png (180): iPad/iPhone 홈 화면. iOS가 모서리를 직접 둥글게 하므로 투명 없이 꽉 채움
 * - icon-192.png, icon-512.png: 웹 앱 매니페스트 기본 아이콘
 * - icon-maskable-512.png: 기기가 원·둥근 사각형으로 잘라도 그림이 남도록 가운데 안전 영역(80%) 안에 배치
 * 외부 서비스는 호출하지 않는다 (설치된 Chromium으로 그림).
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BG = '#eeecfc';
// favicon.svg의 그림 (바탕 사각형 제외, 64×64 좌표)
const ART = `<path d="M15 16h34a9 9 0 0 1 9 9v15a9 9 0 0 1-9 9H29l-9 7 2-7h-7a9 9 0 0 1-9-9V25a9 9 0 0 1 9-9z" fill="#c9c3f7"/><path d="M32 16c-1-5 2-8 6-7-1 4-3 6-6 7z" fill="#5fc396"/><circle cx="25" cy="31" r="3" fill="#26233a"/><circle cx="39" cy="31" r="3" fill="#26233a"/><circle cx="19.5" cy="37.5" r="3.2" fill="#ffb8c8"/><circle cx="44.5" cy="37.5" r="3.2" fill="#ffb8c8"/><path d="M28.5 37.5q3.5 3.5 7 0" stroke="#26233a" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;

/** scale: 그림이 차지하는 비율 (1 = favicon과 같은 크기) */
const svg = (scale) => {
  const t = 32 - 32 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="100%" height="100%"><rect width="64" height="64" fill="${BG}"/><g transform="translate(${t} ${t}) scale(${scale})">${ART}</g></svg>`;
};

const targets = [
  { file: 'public/apple-touch-icon.png', size: 180, scale: 1 },
  { file: 'public/icon-192.png', size: 192, scale: 1 },
  { file: 'public/icon-512.png', size: 512, scale: 1 },
  { file: 'public/icon-maskable-512.png', size: 512, scale: 0.78 },
];

const browser = await chromium.launch();
for (const t of targets) {
  const page = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0">${svg(t.scale)}</body></html>`);
  writeFileSync(t.file, await page.screenshot({ type: 'png', omitBackground: false }));
  await page.close();
  console.log(`${t.file} (${t.size}×${t.size})`);
}
await browser.close();
