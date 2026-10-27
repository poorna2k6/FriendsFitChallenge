// Renders the StakeFit icon set to PNG with Playwright (dev-only; PNGs are committed).
const { chromium } = require('playwright');
const path = require('path');
const out = path.join(__dirname, '..', 'public', 'icons');
const svg = (size, pad) => `<html><body style="margin:0;background:#0b0f19">
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#10b981"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
<rect width="512" height="512" fill="#0b0f19"/>
<g transform="translate(${pad} ${pad}) scale(${(512 - 2 * pad) / 512})">
<rect x="40" y="40" width="432" height="432" rx="104" fill="url(#g)"/>
<circle cx="256" cy="256" r="150" fill="none" stroke="#06281f" stroke-width="34" stroke-linecap="round" stroke-dasharray="760 200" transform="rotate(-100 256 256)"/>
<text x="256" y="292" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-weight="900" font-size="130" fill="#06281f">SF</text>
</g></svg></body></html>`;
(async () => {
  const b = await chromium.launch();
  for (const [name, size, pad] of [['icon-192.png', 192, 0], ['icon-512.png', 512, 0], ['icon-maskable-512.png', 512, 70], ['apple-touch-icon.png', 180, 0]]) {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    await p.setContent(svg(size, pad));
    await p.screenshot({ path: path.join(out, name) });
    await p.close();
  }
  await b.close();
})();
