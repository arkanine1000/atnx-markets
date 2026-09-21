// Renders the eval fixture images from scripts/fixtures/manifest.json.
//
//   node scripts/fixtures/render.mjs
//
// Each image fixture has a `render` block describing a synthetic social-media
// post (frame + handle + text + tags) or a non-content screen (blank,
// spreadsheet, settings, document, noise). Output goes to
// scripts/fixtures/images/<id>.png. Uses `sharp`, which Next.js already
// installs, so there is nothing extra to add.
//
// The images are deliberately synthetic so the repo carries nothing with an
// unclear licence. What the model sees is what the extension normally sends:
// a screenshot of a post with readable text, a handle and a platform frame.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'images');
fs.mkdirSync(OUT, { recursive: true });

const W = 1080;
const H = 720;

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Naive word wrap for SVG <text>: ~chars per line at a given font size.
function wrap(text, maxChars) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars) {
      lines.push(line.trim());
      line = w;
    } else {
      line = (line + ' ' + w).trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}

const tspans = (lines, x, y, lh) =>
  lines.map((l, i) => `<tspan x="${x}" y="${y + i * lh}">${esc(l)}</tspan>`).join('');

const FRAMES = {
  x: { bg: '#000000', fg: '#e7e9ea', muted: '#71767b', accent: '#1d9bf0', label: 'X' },
  reddit: { bg: '#ffffff', fg: '#1c1c1c', muted: '#7c7c7c', accent: '#ff4500', label: 'reddit' },
  tiktok: { bg: '#121212', fg: '#ffffff', muted: '#a6a6a6', accent: '#fe2c55', label: 'TikTok' },
  instagram: { bg: '#ffffff', fg: '#262626', muted: '#8e8e8e', accent: '#e1306c', label: 'Instagram' },
  youtube: { bg: '#0f0f0f', fg: '#f1f1f1', muted: '#aaaaaa', accent: '#ff0000', label: 'YouTube' },
};

function postSvg(r) {
  const f = FRAMES[r.frame];
  const lines = wrap(r.text, 44);
  const tags = (r.tags ?? []).join('  ');
  // A coloured block stands in for the post's media so the layout reads as a
  // post with an image, without shipping any real image.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${f.bg}"/>
  <rect x="0" y="0" width="${W}" height="64" fill="${f.bg}" stroke="${f.muted}" stroke-width="1"/>
  <text x="32" y="42" font-family="sans-serif" font-size="26" font-weight="bold" fill="${f.accent}">${esc(f.label)}</text>
  <circle cx="64" cy="120" r="28" fill="${f.accent}"/>
  <text x="108" y="114" font-family="sans-serif" font-size="24" font-weight="bold" fill="${f.fg}">${esc(r.handle)}</text>
  <text x="108" y="142" font-family="sans-serif" font-size="18" fill="${f.muted}">2h</text>
  <text font-family="sans-serif" font-size="30" fill="${f.fg}">${tspans(lines, 40, 210, 42)}</text>
  <text x="40" y="${210 + lines.length * 42 + 8}" font-family="sans-serif" font-size="24" fill="${f.accent}">${esc(tags)}</text>
  <rect x="40" y="${210 + lines.length * 42 + 40}" width="${W - 80}" height="${Math.max(120, H - (210 + lines.length * 42 + 40) - 90)}" rx="16" fill="${f.muted}" opacity="0.35"/>
  <text x="40" y="${H - 36}" font-family="sans-serif" font-size="20" fill="${f.muted}">12.4K   3,201   48K</text>
</svg>`;
}

function blankSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#ffffff"/></svg>`;
}

function spreadsheetSvg() {
  const cols = ['', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const head = ['', 'Item', 'Q1', 'Q2', 'Q3', 'Q4', 'Total', 'Notes'];
  const rows = [
    ['Rent', '1200', '1200', '1250', '1250', '4900', ''],
    ['Utilities', '140', '155', '162', '148', '605', 'gas up'],
    ['Payroll', '8400', '8400', '8600', '8600', '34000', ''],
    ['Software', '310', '310', '290', '290', '1200', 'renewal'],
    ['Travel', '0', '640', '120', '980', '1740', ''],
    ['Total', '10050', '10705', '10422', '11268', '42445', ''],
  ];
  const cw = 135;
  const rh = 40;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#ffffff"/>
  <rect width="${W}" height="56" fill="#f8f9fa"/><text x="24" y="36" font-family="sans-serif" font-size="20" fill="#202124">Q3 budget - Google Sheets</text>`;
  for (let r = 0; r < 12; r++) {
    for (let c = 0; c < cols.length; c++) {
      const x = c * cw;
      const y = 70 + r * rh;
      const hdr = r === 0 || c === 0;
      s += `<rect x="${x}" y="${y}" width="${cw}" height="${rh}" fill="${hdr ? '#f1f3f4' : '#fff'}" stroke="#dadce0"/>`;
      let t = '';
      if (r === 0) t = cols[c];
      else if (c === 0) t = String(r);
      else if (r === 1) t = head[c];
      else if (rows[r - 2]) t = rows[r - 2][c - 1] ?? '';
      if (t) s += `<text x="${x + 8}" y="${y + 26}" font-family="sans-serif" font-size="16" fill="#202124">${esc(t)}</text>`;
    }
  }
  return s + '</svg>';
}

function settingsSvg() {
  const items = ['Wi-Fi', 'Bluetooth', 'Notifications', 'Display & brightness', 'Battery', 'Privacy & security', 'Storage', 'Accounts', 'About phone'];
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#f2f2f7"/>
  <text x="40" y="70" font-family="sans-serif" font-size="40" font-weight="bold" fill="#000">Settings</text>
  <rect x="40" y="100" width="${W - 80}" height="48" rx="12" fill="#e5e5ea"/><text x="64" y="132" font-family="sans-serif" font-size="22" fill="#8e8e93">Search</text>`;
  items.forEach((it, i) => {
    const y = 170 + i * 58;
    s += `<rect x="40" y="${y}" width="${W - 80}" height="56" fill="#fff" stroke="#e5e5ea"/><rect x="60" y="${y + 13}" width="30" height="30" rx="7" fill="#0a84ff"/><text x="110" y="${y + 36}" font-family="sans-serif" font-size="24" fill="#000">${esc(it)}</text><text x="${W - 70}" y="${y + 36}" font-family="sans-serif" font-size="24" fill="#c7c7cc">&gt;</text>`;
  });
  return s + '</svg>';
}

function documentSvg(text) {
  const lines = wrap(text, 70);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#ffffff"/>
  <text x="80" y="100" font-family="serif" font-size="34" font-weight="bold" fill="#111">Untitled document</text>
  <text font-family="serif" font-size="24" fill="#222">${tspans(lines, 80, 160, 36)}</text></svg>`;
}

async function noisePng() {
  // Deterministic pseudo-random RGB noise so the file is stable across runs.
  let seed = 1234567;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const w = 270;
  const h = 180;
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(rnd() * 256);
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .resize(W, H, { kernel: 'nearest' })
    .png()
    .toBuffer();
}

async function renderOne(fx) {
  const r = fx.render;
  let png;
  switch (r.frame) {
    case 'blank':
      png = await sharp(Buffer.from(blankSvg())).png().toBuffer();
      break;
    case 'spreadsheet':
      png = await sharp(Buffer.from(spreadsheetSvg())).png().toBuffer();
      break;
    case 'settings':
      png = await sharp(Buffer.from(settingsSvg())).png().toBuffer();
      break;
    case 'document':
      png = await sharp(Buffer.from(documentSvg(r.text))).png().toBuffer();
      break;
    case 'noise':
      png = await noisePng();
      break;
    default:
      if (!FRAMES[r.frame]) throw new Error(`${fx.id}: unknown frame ${r.frame}`);
      png = await sharp(Buffer.from(postSvg(r))).png({ compressionLevel: 9 }).toBuffer();
  }
  const file = path.join(OUT, `${fx.id}.png`);
  fs.writeFileSync(file, png);
  return file;
}

const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
let n = 0;
for (const fx of manifest.fixtures) {
  if (fx.kind !== 'image') continue;
  const file = await renderOne(fx);
  n++;
  console.log(`rendered ${path.relative(process.cwd(), file)}`);
}
console.log(`${n} images`);
