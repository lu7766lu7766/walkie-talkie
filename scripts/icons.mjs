/**
 * 產生 PWA 圖示：node scripts/icons.mjs
 * 以 SVG 繪製後用 Playwright（Chromium）輸出各尺寸 PNG。
 */
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = new URL('../public/icons/', import.meta.url);

const arc = (cx, cy, r, a0, a1) => {
  const p = (a) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)].map((n) => n.toFixed(1));
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  return `M${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1}`;
};

const defs = `
  <defs>
    <linearGradient id="bg" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#3a1b8a"/>
      <stop offset="0.45" stop-color="#23309b"/>
      <stop offset="0.75" stop-color="#14609f"/>
      <stop offset="1" stop-color="#0f9a9a"/>
    </linearGradient>
    <linearGradient id="edge" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#6a4cf0"/>
      <stop offset="0.5" stop-color="#3f7fe6"/>
      <stop offset="1" stop-color="#22c8b8"/>
    </linearGradient>
    <linearGradient id="body" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4b5272"/>
      <stop offset="1" stop-color="#363b52"/>
    </linearGradient>
    <linearGradient id="face" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4f5677"/>
      <stop offset="1" stop-color="#3d4360"/>
    </linearGradient>
    <radialGradient id="btn" cx="0.4" cy="0.35" r="0.75">
      <stop offset="0" stop-color="#22d3c5"/>
      <stop offset="1" stop-color="#0d939c"/>
    </radialGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#0a0d24" flood-opacity="0.55"/>
    </filter>
  </defs>`;

// 內容以 1000×1000 的卡片座標繪製
const content = `
  <g fill="none" stroke-linecap="round" stroke-width="18">
    <g stroke="#8a90d6" stroke-opacity="0.55">
      <path d="${arc(500, 540, 220, 150, 210)}"/>
      <path d="${arc(500, 540, 290, 152, 208)}"/>
      <path d="${arc(500, 540, 360, 154, 206)}"/>
    </g>
    <g stroke="#5cc4d0" stroke-opacity="0.7">
      <path d="${arc(500, 540, 220, -30, 30)}"/>
      <path d="${arc(500, 540, 290, -28, 28)}"/>
      <path d="${arc(500, 540, 360, -26, 26)}"/>
    </g>
    <g stroke="#7fa6d8" stroke-opacity="0.6">
      <path d="${arc(470, 470, 290, -86, -50)}"/>
      <path d="${arc(470, 470, 350, -88, -46)}"/>
    </g>
  </g>
  <g filter="url(#shadow)">
    <rect x="372" y="128" width="66" height="250" rx="33" fill="#3b4160"/>
    <rect x="552" y="268" width="78" height="72" rx="14" fill="#3b4160"/>
    <g stroke="#262a3d" stroke-width="7" stroke-linecap="round">
      <line x1="574" y1="284" x2="574" y2="318"/><line x1="591" y1="284" x2="591" y2="318"/><line x1="608" y1="284" x2="608" y2="318"/>
    </g>
    <rect x="325" y="335" width="350" height="510" rx="54" fill="url(#body)"/>
    <rect x="345" y="355" width="310" height="455" rx="40" fill="url(#face)"/>
    <circle cx="500" cy="515" r="122" fill="#2c3147"/>
    <circle cx="500" cy="515" r="90" fill="url(#btn)" stroke="#f26b4a" stroke-width="15"/>
    <g stroke="#262a3d" stroke-width="15" stroke-linecap="round">
      <line x1="470" y1="690" x2="530" y2="690"/>
      <line x1="448" y1="722" x2="468" y2="722"/><line x1="490" y1="722" x2="510" y2="722"/><line x1="532" y1="722" x2="552" y2="722"/>
      <line x1="470" y1="754" x2="530" y2="754"/>
    </g>
  </g>`;

/** any：圓角卡片，四角透明（Android 啟動器、桌面、網頁 favicon） */
const roundedSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">${defs}
  <rect x="8" y="8" width="984" height="984" rx="220" fill="url(#bg)" stroke="url(#edge)" stroke-width="10"/>
  ${content}
</svg>`;

/** maskable / apple-touch：滿版背景，內容縮進安全區，由系統套用自己的圓角遮罩 */
const fullBleedSvg = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">${defs}
  <rect width="1000" height="1000" fill="url(#bg)"/>
  <g transform="translate(500 500) scale(${scale}) translate(-500 -500)">${content}</g>
</svg>`;

writeFileSync(new URL('icon.svg', OUT), roundedSvg);

const targets = [
  ['icon-192.png', roundedSvg, 192],
  ['icon-512.png', roundedSvg, 512],
  ['maskable-512.png', fullBleedSvg(0.78), 512],
  ['apple-touch-icon.png', fullBleedSvg(0.9), 180],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, svg, size] of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}">`,
  );
  await page.waitForFunction(() => document.querySelector('img').complete);
  await page.screenshot({ path: new URL(file, OUT).pathname, omitBackground: true });
  console.log('wrote', file);
}
await browser.close();
