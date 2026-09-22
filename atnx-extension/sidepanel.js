// Production lives on the www host (the apex domain redirects there), and
// the manifest grants `*.atnx.app`, so either spelling works — but the
// default skips the redirect.
const DEFAULT_WEB_APP_URL = 'https://www.atnx.app';
const STALE_STATUS_MS = 10_000;
const REFRESH_MS = 30_000;
// After the user clicks "Sign in" we poll faster for a few minutes so the
// panel flips to signed-in as soon as the web app tab finishes.
const SIGNIN_POLL_MS = 3_000;
const SIGNIN_POLL_TICKS = 60;
const TOP_MARKETS = 5;

// Chart ranges: query value → tab label, delta wording, tooltip time format.
const RANGES = {
  '1d': {
    label: '1D',
    delta: '24h',
    time: new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
  },
  '1w': {
    label: '1W',
    delta: '7d',
    time: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  },
  '1m': {
    label: '1M',
    delta: '30d',
    time: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
  },
  all: {
    label: 'ALL',
    delta: 'all time',
    time: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }
};
const DEFAULT_RANGE = '1w';

const $ = (id) => document.getElementById(id);

// --- Helpers ---

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2
});

const usdCompact = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
});

function signed(n, fmt = (x) => x.toFixed(2)) {
  return `${n >= 0 ? '+' : '-'}${fmt(Math.abs(n))}`;
}

function normalizeWebAppUrl(value) {
  const trimmed = (value || '').trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return trimmed;
  } catch {
    return null;
  }
}

async function getWebAppUrl() {
  const { webAppUrl } = await chrome.storage.local.get('webAppUrl');
  return normalizeWebAppUrl(webAppUrl) || DEFAULT_WEB_APP_URL;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function openTab(url) {
  await chrome.tabs.create({ url });
}

// Thumbnail with a first-letter fallback when there is no image (or it fails).
function thumb(imageUrl, name, badge) {
  const box = el('div', 'thumb');
  const letter = el('span', '', (name || '?').trim().charAt(0).toUpperCase());
  if (imageUrl) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = imageUrl;
    img.addEventListener('error', () => img.replaceWith(letter));
    box.appendChild(img);
  } else {
    box.appendChild(letter);
  }
  if (badge) {
    const b = el('span', 'badge', badge.text);
    b.title = badge.title;
    box.appendChild(b);
  }
  return box;
}

// --- Settings (URL, shortcut, version) ---

const settings = $('settings');
const settingsToggle = $('settingsToggle');
const urlForm = $('urlForm');
const webAppUrlInput = $('webAppUrl');
const urlStatus = $('urlStatus');
const shortcutLink = $('shortcutLink');

settingsToggle.addEventListener('click', () => {
  const open = settings.hidden;
  settings.hidden = !open;
  settingsToggle.setAttribute('aria-expanded', String(open));
  if (open) webAppUrlInput.focus();
});

function setUrlStatus(text, kind = '') {
  urlStatus.textContent = text;
  urlStatus.className = `status-text ${kind}`.trim();
}

function originPattern(url) {
  return `${new URL(url).origin}/*`;
}

async function loadSettings() {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;

  const { webAppUrl } = await chrome.storage.local.get('webAppUrl');
  if (webAppUrl) {
    webAppUrlInput.value = webAppUrl;
    const granted = await chrome.permissions.contains({
      origins: [originPattern(webAppUrl)]
    });
    setUrlStatus(
      granted ? 'URL saved' : 'Saved, but site access not granted',
      granted ? 'saved' : 'error'
    );
  }

  const commands = await chrome.commands.getAll();
  const cmd = commands.find((c) => c.name === 'activate-capture');
  shortcutLink.textContent = cmd?.shortcut || 'Set shortcut';
}

urlForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const normalized = normalizeWebAppUrl(webAppUrlInput.value);
  if (!normalized) {
    setUrlStatus('Enter a valid http(s) URL', 'error');
    return;
  }

  // Host permission for the web app keeps the auth cookie flowing even when
  // third-party cookies are blocked. *.atnx.app is granted at install; any
  // other origin (e.g. localhost) is requested here, inside the click.
  let granted = true;
  try {
    granted = await chrome.permissions.request({ origins: [originPattern(normalized)] });
  } catch (err) {
    console.warn('Permission request failed:', err.message);
    granted = false;
  }

  await chrome.storage.local.set({ webAppUrl: normalized });
  webAppUrlInput.value = normalized;
  setUrlStatus(
    granted ? 'URL saved' : 'Saved, but site access denied — captures may not authenticate',
    granted ? 'saved' : 'error'
  );
  portfolioCache.clear();
  refreshData();
});

shortcutLink.addEventListener('click', async (e) => {
  e.preventDefault();
  await openTab('chrome://extensions/shortcuts');
});

$('openDashboard').addEventListener('click', async (e) => {
  e.preventDefault();
  await openTab(`${await getWebAppUrl()}/app`);
});

// --- Capture button + status ---

const captureBtn = $('captureBtn');
const captureText = $('captureText');
const captureNote = $('captureNote');
const authNote = $('authNote');

captureBtn.addEventListener('click', async () => {
  captureNote.hidden = true;
  const result = await chrome.runtime.sendMessage({ action: 'start-capture' });
  if (result && !result.ok) {
    captureNote.textContent = result.reason;
    captureNote.hidden = false;
  }
});

// The button is the status: it reads CAPTURING… / ANALYZING… while the
// pipeline runs. Errors surface as a toast on the page and on the badge.
const BUSY = { capturing: 'CAPTURING…', analyzing: 'ANALYZING…' };

let lastStatus = 'ready';

function renderStatus({ captureStatus = 'ready', captureStatusAt = 0 }) {
  let status = captureStatus;
  if ((status === 'done' || status === 'error') && Date.now() - captureStatusAt > STALE_STATUS_MS) {
    status = 'ready';
  }

  captureBtn.className = 'btn-capture';
  captureText.textContent = 'CAPTURE';
  captureBtn.disabled = false;

  if (BUSY[status]) {
    captureBtn.classList.add('analyzing');
    captureBtn.disabled = true;
    captureText.textContent = BUSY[status];
  }

  // A finished capture changes the market list, so pull fresh data.
  if (status === 'done' && lastStatus !== 'done') refreshData();
  lastStatus = status;
}

async function loadStatus() {
  renderStatus(
    await chrome.storage.local.get(['captureStatus', 'captureStatusAt'])
  );
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('captureStatus' in changes) loadStatus();
});

// --- Value tile: hero number + range delta + chart ---

const valueTile = $('valueTile');
const tileValue = $('tileValue');
const tileDelta = $('tileDelta');
const chartEl = $('chart');
const chartSvg = $('chartSvg');
const chartTip = $('chartTip');
const tipValue = $('tipValue');
const tipTime = $('tipTime');
const rangeBar = $('rangeBar');

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART_H = 72;
const PAD_Y = 6;
const UP = '#00D4FF';
const DOWN = '#FF00E5';
// The y-axis never spans less than this share of the portfolio, so a $20
// wobble on $10k reads as a ripple rather than a cliff.
const MIN_SPAN_RATIO = 0.02;

let chartRange = DEFAULT_RANGE;
let chartSeries = [];
let chartPoints = []; // [{x, y, t, value}] in SVG px
let chartHover = -1;
let chartColor = UP;

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

const px = (n) => n.toFixed(1);

// Monotone cubic interpolation (Fritsch–Carlson). Rounds the corners
// between samples without overshooting: the curve stays inside each pair of
// neighbouring values, so smoothing never invents a peak or a dip.
function monotonePath(pts) {
  const n = pts.length;
  if (n < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${px(p.x)},${px(p.y)}`).join(' ');

  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x;
    slope[i] = dx[i] > 0 ? (pts[i + 1].y - pts[i].y) / dx[i] : 0;
  }
  const tangent = new Array(n);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    tangent[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      tangent[i] = k * a * slope[i];
      tangent[i + 1] = k * b * slope[i];
    }
  }

  let d = `M${px(pts[0].x)},${px(pts[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${px(pts[i].x + h)},${px(pts[i].y + h * tangent[i])}`
      + ` ${px(pts[i + 1].x - h)},${px(pts[i + 1].y - h * tangent[i + 1])}`
      + ` ${px(pts[i + 1].x)},${px(pts[i + 1].y)}`;
  }
  return d;
}

function renderChart() {
  const w = chartEl.clientWidth;
  if (!w || chartSeries.length === 0) return;
  const h = CHART_H;
  chartSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  chartSvg.replaceChildren();

  const values = chartSeries.map((p) => p.value);
  const first = values[0];
  const lastValue = values[values.length - 1];
  let min = Math.min(...values);
  let max = Math.max(...values);
  const floor = Math.max(Math.abs(lastValue) * MIN_SPAN_RATIO, 1);
  if (max - min < floor) {
    const mid = (max + min) / 2;
    min = mid - floor / 2;
    max = mid + floor / 2;
  }
  // A little headroom so the line never kisses the tile edge.
  const pad = (max - min) * 0.08;
  min -= pad;
  max += pad;

  // One series, so colour carries polarity only: cyan when the window ends
  // higher than it starts, magenta when lower (the app's up/down pair).
  chartColor = lastValue >= first ? UP : DOWN;

  const t0 = new Date(chartSeries[0].t).getTime();
  const t1 = new Date(chartSeries[chartSeries.length - 1].t).getTime();
  const span = Math.max(1, t1 - t0);

  chartPoints = chartSeries.map((p) => {
    const t = new Date(p.t).getTime();
    return {
      x: ((t - t0) / span) * w,
      y: PAD_Y + (1 - (p.value - min) / (max - min)) * (h - PAD_Y * 2),
      t,
      value: p.value
    };
  });

  const line = monotonePath(chartPoints);
  const last = chartPoints[chartPoints.length - 1];

  // Area wash: series hue at ~18% opacity fading to nothing.
  const defs = svgEl('defs', {});
  const grad = svgEl('linearGradient', { id: 'sparkFill', x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': chartColor, 'stop-opacity': 0.18 }));
  grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': chartColor, 'stop-opacity': 0 }));
  defs.appendChild(grad);
  chartSvg.appendChild(defs);

  chartSvg.appendChild(svgEl('path', {
    d: `${line} L${px(last.x)},${h} L${px(chartPoints[0].x)},${h} Z`,
    fill: 'url(#sparkFill)'
  }));
  // Hairline at the window's starting value so the reader sees above/below
  // at a glance. Drawn under the line.
  const y0 = chartPoints[0].y;
  chartSvg.appendChild(svgEl('line', {
    x1: 0, x2: w, y1: px(y0), y2: px(y0),
    stroke: '#2A2A2A', 'stroke-width': 1, 'stroke-dasharray': '3 3'
  }));
  chartSvg.appendChild(svgEl('path', {
    d: line,
    fill: 'none',
    stroke: chartColor,
    'stroke-width': 2,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round'
  }));
  // End marker with a surface ring.
  chartSvg.appendChild(svgEl('circle', { cx: last.x, cy: last.y, r: 5.5, fill: '#141414' }));
  chartSvg.appendChild(svgEl('circle', { cx: last.x, cy: last.y, r: 4, fill: chartColor }));

  // Crosshair layer (hidden until hover/focus).
  const cross = svgEl('g', { id: 'cross', visibility: 'hidden' });
  cross.appendChild(svgEl('line', { id: 'crossLine', y1: 0, y2: h, stroke: '#8A8A8A', 'stroke-width': 1 }));
  cross.appendChild(svgEl('circle', { id: 'crossRing', r: 6, fill: '#141414' }));
  cross.appendChild(svgEl('circle', { id: 'crossDot', r: 4, fill: '#F0F0F0' }));
  chartSvg.appendChild(cross);

  if (chartHover >= 0) showHover(Math.min(chartHover, chartPoints.length - 1));
}

function showHover(i) {
  chartHover = i;
  const p = chartPoints[i];
  if (!p) return;
  const cross = chartSvg.querySelector('#cross');
  cross.setAttribute('visibility', 'visible');
  cross.querySelector('#crossLine').setAttribute('x1', p.x);
  cross.querySelector('#crossLine').setAttribute('x2', p.x);
  cross.querySelector('#crossRing').setAttribute('cx', p.x);
  cross.querySelector('#crossRing').setAttribute('cy', p.y);
  cross.querySelector('#crossDot').setAttribute('cx', p.x);
  cross.querySelector('#crossDot').setAttribute('cy', p.y);

  tipValue.textContent = usd.format(p.value);
  tipTime.textContent = RANGES[chartRange].time.format(new Date(p.t));
  chartTip.hidden = false;
  // Keep the tooltip inside the tile.
  const w = chartEl.clientWidth;
  const tw = chartTip.offsetWidth;
  const left = Math.min(Math.max(p.x, tw / 2), w - tw / 2);
  chartTip.style.left = `${left}px`;
}

function hideHover() {
  chartHover = -1;
  chartSvg.querySelector('#cross')?.setAttribute('visibility', 'hidden');
  chartTip.hidden = true;
}

function nearestIndex(clientX) {
  const rect = chartEl.getBoundingClientRect();
  const x = clientX - rect.left;
  let best = 0;
  let bestD = Infinity;
  chartPoints.forEach((p, i) => {
    const d = Math.abs(p.x - x);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

chartEl.addEventListener('pointermove', (e) => {
  if (chartPoints.length) showHover(nearestIndex(e.clientX));
});
chartEl.addEventListener('pointerleave', hideHover);
chartEl.addEventListener('focus', () => {
  if (chartPoints.length) showHover(chartPoints.length - 1);
});
chartEl.addEventListener('blur', hideHover);
chartEl.addEventListener('keydown', (e) => {
  if (!chartPoints.length) return;
  if (e.key === 'ArrowLeft') showHover(Math.max(0, (chartHover < 0 ? chartPoints.length : chartHover) - 1));
  else if (e.key === 'ArrowRight') showHover(Math.min(chartPoints.length - 1, chartHover + 1));
  else if (e.key === 'Home') showHover(0);
  else if (e.key === 'End') showHover(chartPoints.length - 1);
  else return;
  e.preventDefault();
});
new ResizeObserver(() => renderChart()).observe(chartEl);

// --- Range tabs ---

function syncRangeBar() {
  for (const btn of rangeBar.querySelectorAll('.range-btn')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.range === chartRange));
  }
}

rangeBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.range-btn');
  if (!btn || !RANGES[btn.dataset.range] || btn.dataset.range === chartRange) return;
  chartRange = btn.dataset.range;
  chrome.storage.local.set({ chartRange });
  syncRangeBar();
  hideHover();
  // Show the last good render for this range immediately, then refresh it.
  const cached = portfolioCache.get(chartRange);
  if (cached) renderTile(cached);
  refreshData();
});

function renderTile(data) {
  valueTile.hidden = false;
  tileValue.textContent = usd.format(data.totalValueUsd);
  const dir = data.changeUsd >= 0 ? 'up' : 'down';
  const range = RANGES[data.range] ? data.range : chartRange;
  tileDelta.className = `tile-delta ${dir}`;
  tileDelta.textContent =
    `${signed(data.changeUsd, (x) => usdCompact.format(x))} (${signed(data.changePercent, (x) => x.toFixed(1))}%) ${RANGES[range].delta}`;
  chartEl.setAttribute(
    'aria-label',
    `Portfolio value ${usd.format(data.totalValueUsd)}, ${tileDelta.textContent}`
  );
  chartSeries = Array.isArray(data.history) ? data.history : [];
  renderChart();
}

// --- Data: portfolio + top markets ---

const portfolioEl = $('portfolio');
const marketsEl = $('markets');
const marketsMeta = $('marketsMeta');
const handleChip = $('handleChip');
const refreshBtn = $('refreshBtn');

// Last good payload per range, so switching tabs is instant and a failed
// refresh never blanks a chart that was fine a moment ago.
const portfolioCache = new Map();
let signedIn = false;

function setHandle(handle) {
  handleChip.textContent = handle ? `@${handle}` : 'Not signed in';
  handleChip.className = handle ? 'handle' : 'handle muted';
}

let portfolioOpen = false;

async function fetchJson(path) {
  const base = await getWebAppUrl();
  const res = await fetch(`${base}${path}`, { credentials: 'include' });
  return { res, base };
}

// A URL pointing at something other than ATNX answers 200 with HTML;
// treat that as "unavailable" rather than throwing out of the loader.
async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function placeholder(text, action) {
  const box = el('div', 'placeholder');
  box.appendChild(el('div', '', text));
  if (action) {
    const btn = el('button', 'btn-small', action.label);
    btn.type = 'button';
    btn.addEventListener('click', action.onClick);
    box.appendChild(btn);
  }
  return box;
}

function stat(label, value, cls) {
  const box = el('div', 'stat');
  box.appendChild(el('div', 'label', label));
  box.appendChild(el('div', `value ${cls || ''}`.trim(), value));
  return box;
}

// Position row: thumbnail · name · current value / PnL %.
function positionRow(p, base) {
  const row = el('button', 'row');
  row.type = 'button';
  row.title = `${p.direction === 'short' ? 'Short' : 'Long'} ${p.leverage}x · ${usd.format(p.sizeUsd)} in · VI ${p.entryVi} → ${p.currentVi}`;
  row.addEventListener('click', () => openTab(`${base}/app/markets/${p.marketId}`));

  const badge = p.direction === 'short' ? { text: 'S', title: 'Short' } : null;
  const dir = p.pnlPercent >= 0 ? 'up' : 'down';
  const end = el('div', 'end');
  end.appendChild(el('div', 'big', usd.format(p.valueUsd ?? p.sizeUsd + p.pnlUsd)));
  end.appendChild(el('div', `small ${dir}`, `${signed(p.pnlPercent, (x) => x.toFixed(1))}%`));

  row.append(thumb(p.imageUrl, p.name, badge), el('div', 'name', p.name), end);
  return row;
}

function setPortfolioOpen(open) {
  portfolioOpen = open;
  chrome.storage.local.set({ portfolioOpen: open });
  const toggle = portfolioEl.querySelector('.stats-toggle');
  const list = portfolioEl.querySelector('.positions');
  if (toggle) toggle.setAttribute('aria-expanded', String(open));
  if (list) list.hidden = !open;
}

// Signing in happens in a web app tab; poll quickly for a few minutes so the
// panel notices without the user having to hit refresh.
let signinPoll = null;
function watchForSignIn() {
  clearInterval(signinPoll);
  let ticks = 0;
  signinPoll = setInterval(() => {
    if (signedIn || ++ticks > SIGNIN_POLL_TICKS) {
      clearInterval(signinPoll);
      signinPoll = null;
      return;
    }
    refreshData();
  }, SIGNIN_POLL_MS);
}

async function openSignIn(base) {
  watchForSignIn();
  await openTab(`${base}/app/portfolio`);
}

function setSignedOut(base) {
  signedIn = false;
  setHandle(null);
  valueTile.hidden = true;
  portfolioCache.clear();

  authNote.replaceChildren(el('span', '', 'Sign in to save your captures'));
  const btn = el('button', 'btn-small', 'Sign in');
  btn.type = 'button';
  btn.addEventListener('click', () => openSignIn(base));
  authNote.appendChild(btn);
  authNote.hidden = false;

  portfolioEl.replaceChildren(
    placeholder(`Sign in at ${hostOf(base)} to see your balance and positions`, {
      label: 'Sign in',
      onClick: () => openSignIn(base)
    })
  );
}

async function loadPortfolio() {
  const range = chartRange;
  let res;
  let base;
  try {
    ({ res, base } = await fetchJson(`/api/portfolio?range=${range}`));
  } catch {
    valueTile.hidden = true;
    portfolioEl.replaceChildren(placeholder(`Can't reach ${hostOf(await getWebAppUrl())}`));
    return;
  }

  if (res.status === 401) {
    setSignedOut(base);
    return;
  }
  if (!res.ok) {
    valueTile.hidden = true;
    portfolioEl.replaceChildren(placeholder(
      res.status === 404 ? 'Portfolio needs a newer web app build' : `Portfolio unavailable (${res.status})`
    ));
    return;
  }

  const data = await readJson(res);
  if (!data || !Array.isArray(data.positions)) {
    valueTile.hidden = true;
    portfolioEl.replaceChildren(placeholder(`Unexpected response from ${hostOf(base)}`));
    return;
  }

  signedIn = true;
  authNote.hidden = true;
  setHandle(data.handle);
  portfolioCache.set(range, data);
  // The user switched range while this request was in flight; the newer
  // request will draw the tile.
  if (range !== chartRange) return;

  renderTile(data);

  // Collapsed: the three numbers. Expanded: the open positions.
  const toggle = el('button', 'stats-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(portfolioOpen));
  toggle.setAttribute('aria-controls', 'positions');
  toggle.appendChild(stat('Balance', usd.format(data.balanceUsd), 'yellow'));
  toggle.appendChild(
    stat('Unrealized', signed(data.unrealizedPnlUsd, (x) => usd.format(x)),
      data.unrealizedPnlUsd >= 0 ? 'up' : 'down')
  );
  toggle.appendChild(stat('Open', String(data.positions.length)));
  const chev = svgEl('svg', { class: 'chevron', viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' });
  chev.appendChild(svgEl('path', {
    d: 'M6 9l6 6 6-6', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round'
  }));
  toggle.appendChild(chev);
  toggle.addEventListener('click', () => setPortfolioOpen(!portfolioOpen));

  const list = el('div', 'positions');
  list.id = 'positions';
  list.hidden = !portfolioOpen;
  if (data.positions.length === 0) {
    list.appendChild(placeholder('No open positions', {
      label: 'Browse markets',
      onClick: () => openTab(`${base}/app`)
    }));
  } else {
    for (const p of data.positions) list.appendChild(positionRow(p, base));
  }

  portfolioEl.replaceChildren(toggle, list);
}

// /api/captures returns the capture feed newest-first; the dashboard groups
// it by market and ranks by VI, so do the same here.
function topMarkets(captures) {
  const byMarket = new Map();
  for (const c of captures) {
    if (!c.marketId) continue;
    if (!byMarket.has(c.marketId)) byMarket.set(c.marketId, c);
  }
  return [...byMarket.values()]
    .sort((a, b) => b.viralityScore - a.viralityScore)
    .slice(0, TOP_MARKETS);
}

// Market row: thumbnail · name · VI.
function marketRow(c, base, rank) {
  const row = el('button', 'row ranked');
  row.type = 'button';
  const trend = c.trends?.trend;
  row.title = trend ? `Virality Index ${c.viralityScore} · ${trend}` : `Virality Index ${c.viralityScore}`;
  row.addEventListener('click', () => openTab(`${base}/app/markets/${c.marketId}`));

  const name = c.analysis?.name || 'Unknown';
  const end = el('div', 'end');
  end.appendChild(el('div', 'big', String(c.viralityScore)));

  row.append(el('div', 'rank', String(rank)), thumb(c.screenshot, name), el('div', 'name', name), end);
  return row;
}

async function loadMarkets() {
  let res;
  let base;
  try {
    ({ res, base } = await fetchJson('/api/captures'));
  } catch {
    marketsEl.replaceChildren(placeholder(`Can't reach ${hostOf(await getWebAppUrl())}`));
    marketsMeta.textContent = '';
    return;
  }
  if (!res.ok) {
    marketsEl.replaceChildren(placeholder(`Markets unavailable (${res.status})`));
    marketsMeta.textContent = '';
    return;
  }

  const data = await readJson(res);
  if (!data || !Array.isArray(data.captures)) {
    marketsEl.replaceChildren(placeholder(`Unexpected response from ${hostOf(base)}`));
    marketsMeta.textContent = '';
    return;
  }
  const top = topMarkets(data.captures);
  marketsMeta.textContent = top.length ? 'VI Score' : '';

  if (top.length === 0) {
    marketsEl.replaceChildren(placeholder('No markets yet — capture something to spawn one'));
    return;
  }
  marketsEl.replaceChildren(
    ...top.map((c, i) => {
      const row = marketRow(c, base, i + 1);
      // 1 → 0.25 heat across the five rows.
      row.style.setProperty('--rank-heat', String(1 - (i / Math.max(1, top.length - 1)) * 0.75));
      return row;
    })
  );
}

let refreshing = false;
async function refreshData() {
  if (refreshing) return;
  refreshing = true;
  refreshBtn.classList.add('spinning');
  document.body.classList.add('refreshing');
  try {
    await Promise.all([loadPortfolio(), loadMarkets()]);
  } finally {
    refreshing = false;
    refreshBtn.classList.remove('spinning');
    document.body.classList.remove('refreshing');
  }
}

refreshBtn.addEventListener('click', refreshData);

// Poll while the panel is visible; stop when it is hidden.
let timer = null;
function schedule() {
  clearInterval(timer);
  timer = null;
  if (document.visibilityState === 'visible') {
    timer = setInterval(refreshData, REFRESH_MS);
  }
}
document.addEventListener('visibilitychange', () => {
  schedule();
  if (document.visibilityState === 'visible') refreshData();
});

// --- Init ---

async function init() {
  const saved = await chrome.storage.local.get(['chartRange', 'portfolioOpen']);
  if (RANGES[saved.chartRange]) chartRange = saved.chartRange;
  portfolioOpen = Boolean(saved.portfolioOpen);
  syncRangeBar();

  loadSettings();
  loadStatus();
  refreshData();
  schedule();
}

init();
