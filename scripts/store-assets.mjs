// Generates the Chrome Web Store screenshots and promo tile for the extension
// from the real, unmodified extension code running in headless Chromium.
//
//   node scripts/store-assets.mjs
//
// Needs Playwright (`npm i -g playwright` or a local install) with Chromium.
// The page content and account data are demo fixtures served from a local
// mock of the two ATNX endpoints; nothing here touches atnx.app.
//
// Output: atnx-extension/store/screenshot-*.png (1280×800), promo-small.png
// (440×280).

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'atnx-extension');
const OUT = path.join(SRC, 'store');
fs.mkdirSync(OUT, { recursive: true });

// Copy the extension and grant localhost so the mock server is reachable
// (in production the same grant comes from the atnx.app host permission).
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'atnx-store-'));
fs.cpSync(SRC, EXT, { recursive: true, filter: (p) => !p.includes(`${path.sep}dist`) && !p.includes(`${path.sep}store`) });
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('http://localhost/*', '<all_urls>');
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(manifest));

const PANEL_W = 400;
const PAGE_W = 1280 - PANEL_W;
const H = 800;

// --- Demo fixtures --------------------------------------------------------

const thumbSvg = (a, b, glyph) => `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
  <rect width="96" height="96" fill="url(#g)"/>
  <text x="48" y="60" font-family="ui-monospace,monospace" font-size="40" font-weight="700" text-anchor="middle" fill="rgba(10,10,10,0.75)">${glyph}</text></svg>`;
const THUMBS = {
  a: thumbSvg('#00D4FF', '#0066FF', '◉'),
  b: thumbSvg('#FF00E5', '#7A00B8', '★'),
  c: thumbSvg('#FFE500', '#FF7A00', '▲'),
  d: thumbSvg('#00D4FF', '#FF00E5', '✦'),
  e: thumbSvg('#2A2A2A', '#5A5A5A', '☰'),
};

let PORT = 0;
const img = (k) => `http://localhost:${PORT}/thumb/${k}.svg`;
const now = Date.now();
const day = 86_400_000;
const history = Array.from({ length: 48 }, (_, i) => {
  const t = i / 47;
  const drift = 10000 + t * 380;
  const wave = Math.sin(t * 9) * 70 + Math.sin(t * 23) * 25;
  return { t: new Date(now - 7 * day + t * 7 * day).toISOString(), value: Math.round((drift + wave) * 100) / 100 };
});
const totalValueUsd = history[history.length - 1].value;

const captures = () => [
  { id: 'c1', marketId: 'm1', viralityScore: 812, screenshot: img('a'), analysis: { name: 'Labubu' }, trends: { trend: 'spiking' } },
  { id: 'c2', marketId: 'm2', viralityScore: 640, screenshot: img('b'), analysis: { name: 'Brat Summer' }, trends: { trend: 'rising' } },
  { id: 'c3', marketId: 'm3', viralityScore: 455, screenshot: img('c'), analysis: { name: 'Sad Cat Spooning' }, trends: { trend: 'falling' } },
  { id: 'c4', marketId: 'm4', viralityScore: 310, screenshot: img('d'), analysis: { name: 'Solana Seeker' }, trends: { trend: 'new' } },
  { id: 'c5', marketId: 'm5', viralityScore: 220, screenshot: img('e'), analysis: { name: 'Trollface' }, trends: { trend: 'stable' } },
];
const portfolio = () => ({
  handle: 'osprey', balanceUsd: 9690, realizedPnlUsd: 142.1, totalTrades: 12, unrealizedPnlUsd: 66.25,
  totalValueUsd, history, changeUsd: totalValueUsd - history[0].value, changePercent: ((totalValueUsd - history[0].value) / history[0].value) * 100,
  positions: [
    { id: 'p1', marketId: 'm1', name: 'Labubu', imageUrl: img('a'), direction: 'long', sizeUsd: 250, leverage: 2, entryVi: 700, currentVi: 812, valueUsd: 330, pnlUsd: 80, pnlPercent: 32 },
    { id: 'p2', marketId: 'm3', name: 'Sad Cat Spooning', imageUrl: img('c'), direction: 'short', sizeUsd: 100, leverage: 1, entryVi: 400, currentVi: 455, valueUsd: 86.25, pnlUsd: -13.75, pnlPercent: -13.75 },
  ],
});

// A believable feed page to capture from. No real brands or people.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #f3f4f6; font-family: Inter, system-ui, -apple-system, Segoe UI, sans-serif; color: #111; }
  .top { height: 56px; background: #fff; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; padding: 0 28px; gap: 18px; }
  .logo { width: 30px; height: 30px; border-radius: 8px; background: linear-gradient(135deg,#111,#444); }
  .search { flex: 1; max-width: 460px; height: 34px; border-radius: 17px; background: #f3f4f6; }
  .nav { margin-left: auto; display: flex; gap: 14px; }
  .nav span { width: 28px; height: 28px; border-radius: 50%; background: #e5e7eb; }
  .feed { width: 620px; margin: 28px auto; display: flex; flex-direction: column; gap: 18px; }
  .post { background: #fff; border: 1px solid #e5e7eb; border-radius: 14px; overflow: hidden; }
  .head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; }
  .avatar { width: 38px; height: 38px; border-radius: 50%; background: linear-gradient(135deg,#7dd3fc,#a78bfa); }
  .name { font-weight: 600; font-size: 14px; } .meta { color: #6b7280; font-size: 12px; }
  .text { padding: 0 16px 12px; font-size: 15px; line-height: 1.45; }
  .media { height: 300px; display: grid; place-items: center; font-size: 96px; }
  .m1 { background: linear-gradient(135deg,#fde68a,#fb7185); }
  .m2 { background: linear-gradient(135deg,#a5f3fc,#818cf8); }
  .stats { display: flex; gap: 22px; padding: 12px 16px; color: #6b7280; font-size: 13px; border-top: 1px solid #f1f5f9; }
  .stats b { color: #111; }
</style></head><body>
  <div class="top"><div class="logo"></div><div class="search"></div><div class="nav"><span></span><span></span><span></span></div></div>
  <div class="feed">
    <div class="post">
      <div class="head"><div class="avatar"></div><div><div class="name">toyhunter</div><div class="meta">2h · 4.1M views</div></div></div>
      <div class="text">the plush drop sold out in 40 seconds and the resale is already 6x. this thing is everywhere 😭</div>
      <div class="media m1">🧸</div>
      <div class="stats"><span><b>218K</b> likes</span><span><b>12.4K</b> reposts</span><span><b>9,812</b> comments</span></div>
    </div>
    <div class="post">
      <div class="head"><div class="avatar" style="background:linear-gradient(135deg,#fdba74,#f472b6)"></div><div><div class="name">chartdaily</div><div class="meta">5h · 890K views</div></div></div>
      <div class="text">search interest is up 340% week over week. not a fad anymore.</div>
      <div class="media m2">📈</div>
      <div class="stats"><span><b>41K</b> likes</span><span><b>3.2K</b> reposts</span><span><b>1,104</b> comments</span></div>
    </div>
  </div>
</body></html>`;

const PROMO = (iconDataUrl) => `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; width: 440px; height: 280px; background: #0A0A0A; color: #F0F0F0; font-family: ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace; overflow: hidden; position: relative; }
  .glow { position: absolute; inset: -40%; background: radial-gradient(circle at 25% 60%, rgba(0,212,255,0.22), transparent 45%), radial-gradient(circle at 80% 30%, rgba(255,0,229,0.22), transparent 45%); }
  .wrap { position: relative; display: flex; align-items: center; gap: 26px; padding: 0 34px; height: 100%; }
  img { width: 128px; height: 128px; flex-shrink: 0; filter: drop-shadow(0 8px 24px rgba(0,0,0,0.5)); }
  h1 { margin: 0; font-size: 30px; letter-spacing: 5px; color: #00D4FF; line-height: 1; }
  h2 { margin: 6px 0 0; font-size: 13px; font-weight: 500; color: #9A9A9A; letter-spacing: 1px; }
  p { margin: 14px 0 0; font-size: 12px; line-height: 1.5; color: #F0F0F0; }
  .kbd { display: inline-block; margin-top: 12px; border: 1px solid #2A2A2A; border-radius: 5px; padding: 3px 9px; font-size: 11px; color: #FFE500; }
</style></head><body><div class="glow"></div>
<div class="wrap"><img src="${iconDataUrl}"><div>
  <h1>ATNX</h1><h2>CAPTURE</h2>
  <p>Capture anything.<br>AI names it. You trade it.</p>
  <span class="kbd">Ctrl+Shift+X</span>
</div></div></body></html>`;

// --- Mock server ------------------------------------------------------------

const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Credentials': 'true' };
  if (req.url.startsWith('/thumb/')) {
    const k = req.url.slice(7, 8);
    res.writeHead(200, { ...cors, 'Content-Type': 'image/svg+xml' });
    return res.end(THUMBS[k] ?? THUMBS.e);
  }
  if (req.url === '/api/captures') { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ captures: captures() })); }
  if (req.url === '/api/portfolio') { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify(portfolio())); }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, r));
PORT = server.address().port;

// --- Render -------------------------------------------------------------------

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'p-')), {
  channel: 'chromium',
  headless: true,
  viewport: { width: PAGE_W, height: H },
  deviceScaleFactor: 1,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;
await sw.evaluate((url) => chrome.storage.local.set({ webAppUrl: url }), `http://localhost:${PORT}`);

const page = await ctx.newPage();
await page.goto(`http://localhost:${PORT}/`);

const panel = await ctx.newPage();
await panel.setViewportSize({ width: PANEL_W, height: H });
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
await panel.waitForFunction(() => document.querySelectorAll('#markets .row').length === 5 && document.querySelector('#portfolio .stats-toggle'));
await panel.waitForTimeout(400);

// Frame: page on the left, a 1px divider, panel on the right — the same
// composition as Chrome's side panel.
async function composite(name, pageShot, panelShot) {
  const composer = await ctx.newPage();
  await composer.setViewportSize({ width: 1280, height: H });
  await composer.setContent(`<body style="margin:0;background:#0A0A0A;display:flex">
    <img src="data:image/png;base64,${pageShot.toString('base64')}" style="width:${PAGE_W}px;height:${H}px;display:block">
    <div style="width:1px;background:#2A2A2A"></div>
    <img src="data:image/png;base64,${panelShot.toString('base64')}" style="width:${PANEL_W - 1}px;height:${H}px;display:block;object-fit:cover;object-position:left top">
  </body>`);
  await composer.screenshot({ path: path.join(OUT, name) });
  await composer.close();
}

// Tabs come and go while compositing, so always address the feed page by URL
// rather than relying on which tab Chromium considers active.
const PAGE_URL = `http://localhost:${PORT}/`;
async function activateOnPage() {
  await page.bringToFront();
  await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: url + '*' });
    await activateTab(tab);
  }, PAGE_URL);
  await page.waitForFunction(() => document.querySelector('[data-atnx-capture]')?.matches(':popover-open'));
}

// 1. Capture in progress: selection box drawn around the first post's media.
await activateOnPage();
const media = await page.locator('.post .media').first().boundingBox();
await page.mouse.move(media.x - 12, media.y - 12);
await page.mouse.down();
await page.mouse.move(media.x + media.width + 12, media.y + media.height + 12, { steps: 8 });
await page.waitForTimeout(150);
const shot1 = await page.screenshot();
await page.keyboard.press('Escape');
await composite('screenshot-1-capture.png', shot1, await panel.screenshot());

// 2. Identified: toast on the page, portfolio expanded in the panel.
await sw.evaluate(async (url) => {
  const [tab] = await chrome.tabs.query({ url: url + '*' });
  await chrome.tabs.sendMessage(tab.id, { action: 'capture-status', status: 'done', detail: 'Identified: Labubu' });
}, PAGE_URL);
await page.waitForTimeout(450);
const shot2 = await page.screenshot();
await panel.click('#portfolio .stats-toggle');
await panel.waitForTimeout(350);
await composite('screenshot-2-identified.png', shot2, await panel.screenshot());
await panel.click('#portfolio .stats-toggle');
await panel.waitForTimeout(350);

// 3. Chart tooltip + top markets, page shows the analyzing toast.
await sw.evaluate(async (url) => {
  const [tab] = await chrome.tabs.query({ url: url + '*' });
  await chrome.tabs.sendMessage(tab.id, { action: 'capture-status', status: 'analyzing' });
}, PAGE_URL);
await page.waitForTimeout(450);
const box = await panel.locator('#chart').boundingBox();
await panel.mouse.move(box.x + box.width * 0.62, box.y + box.height / 2);
await panel.waitForFunction(() => !document.getElementById('chartTip').hidden);
await composite('screenshot-3-markets.png', await page.screenshot(), await panel.screenshot());

// Promo tile.
const icon = fs.readFileSync(path.join(SRC, 'icons', 'icon128.png')).toString('base64');
const promo = await ctx.newPage();
await promo.setViewportSize({ width: 440, height: 280 });
await promo.setContent(PROMO(`data:image/png;base64,${icon}`));
await promo.waitForTimeout(100);
await promo.screenshot({ path: path.join(OUT, 'promo-small.png') });

await ctx.close();
server.close();
for (const f of fs.readdirSync(OUT).filter((f) => f.endsWith('.png'))) {
  console.log(`  ${f}`);
}
