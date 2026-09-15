const DEFAULT_WEB_APP_URL = 'https://atnx.app';
const STALE_STATUS_MS = 10_000;
const REFRESH_MS = 30_000;
const TOP_MARKETS = 8;

const $ = (id) => document.getElementById(id);

// --- Helpers ---

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function replaceChildren(parent, ...children) {
  parent.replaceChildren(...children);
}

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2
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
  $('statusHint').textContent = cmd?.shortcut
    ? `${cmd.shortcut} on any page`
    : 'Drag to select any part of the page';
}

urlForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const normalized = normalizeWebAppUrl(webAppUrlInput.value);
  if (!normalized) {
    setUrlStatus('Enter a valid http(s) URL', 'error');
    return;
  }

  // Host permission for the web app keeps the auth cookie flowing even when
  // third-party cookies are blocked. atnx.app is granted at install; any
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
const statusDot = $('statusDot');
const statusLabel = $('statusLabel');
const captureNote = $('captureNote');
const captureCount = $('captureCount');

captureBtn.addEventListener('click', async () => {
  captureNote.hidden = true;
  const result = await chrome.runtime.sendMessage({ action: 'start-capture' });
  if (result && !result.ok) {
    captureNote.textContent = result.reason;
    captureNote.hidden = false;
  }
});

const LABELS = {
  capturing: 'Capturing…',
  analyzing: 'Analyzing with AI…',
  done: 'Done',
  error: 'Error',
  ready: 'Ready'
};

let lastStatus = 'ready';

function renderStatus({ captureStatus = 'ready', captureStatusAt = 0, captureCount: count = 0 }) {
  let status = captureStatus;
  if ((status === 'done' || status === 'error') && Date.now() - captureStatusAt > STALE_STATUS_MS) {
    status = 'ready';
  }

  captureCount.textContent = `${count} capture${count === 1 ? '' : 's'}`;
  statusLabel.textContent = LABELS[status] || LABELS.ready;

  statusDot.className = 'status-dot';
  captureBtn.className = 'btn-capture';
  captureText.textContent = 'CAPTURE';
  captureBtn.disabled = false;

  if (status === 'capturing' || status === 'error') statusDot.classList.add(status);
  if (status === 'analyzing') {
    statusDot.classList.add('analyzing');
    captureBtn.classList.add('analyzing');
    captureBtn.disabled = true;
    captureText.textContent = 'ANALYZING…';
  }

  // A finished capture changes the market list, so pull fresh data.
  if (status === 'done' && lastStatus !== 'done') refreshData();
  lastStatus = status;
}

async function loadStatus() {
  renderStatus(
    await chrome.storage.local.get(['captureStatus', 'captureStatusAt', 'captureCount'])
  );
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('captureStatus' in changes || 'captureCount' in changes) loadStatus();
});

// --- Data: portfolio + top markets ---

const portfolioEl = $('portfolio');
const marketsEl = $('markets');
const marketsMeta = $('marketsMeta');
const handleChip = $('handleChip');
const refreshBtn = $('refreshBtn');

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

function stat(label, value, cls, sub) {
  const box = el('div', 'stat');
  box.appendChild(el('div', 'label', label));
  box.appendChild(el('div', `value ${cls || ''}`.trim(), value));
  if (sub) box.appendChild(el('div', 'sub', sub));
  return box;
}

function positionRow(p, base) {
  const row = el('button', 'row');
  row.type = 'button';
  row.title = 'Open market';
  row.addEventListener('click', () => openTab(`${base}/app/markets/${p.marketId}`));

  const tag = el('span', `tag ${p.direction}`, `${p.direction.toUpperCase()} ${p.leverage}x`);

  const lead = el('div', 'lead');
  lead.appendChild(el('div', 'name', p.name));
  lead.appendChild(el('div', 'meta', `${usd.format(p.sizeUsd)} · VI ${p.entryVi} → ${p.currentVi}`));

  const end = el('div', 'end');
  const dir = p.pnlUsd >= 0 ? 'up' : 'down';
  end.appendChild(el('div', `big ${dir}`, signed(p.pnlUsd, (x) => usd.format(x))));
  end.appendChild(el('div', `small ${dir}`, `${signed(p.pnlPercent)}%`));

  row.append(tag, lead, end);
  return row;
}

async function loadPortfolio() {
  let res;
  let base;
  try {
    ({ res, base } = await fetchJson('/api/portfolio'));
  } catch {
    replaceChildren(portfolioEl, placeholder(`Can't reach ${hostOf(await getWebAppUrl())}`));
    return;
  }

  if (res.status === 401) {
    handleChip.hidden = true;
    replaceChildren(
      portfolioEl,
      placeholder(`Sign in at ${hostOf(base)} to see your balance and positions`, {
        label: 'Sign in',
        onClick: () => openTab(`${base}/app/portfolio`)
      })
    );
    return;
  }
  if (res.status === 404) {
    // Older web app without the portfolio endpoint.
    replaceChildren(portfolioEl, placeholder('Portfolio needs a newer web app build'));
    return;
  }
  if (!res.ok) {
    replaceChildren(portfolioEl, placeholder(`Portfolio unavailable (${res.status})`));
    return;
  }

  const data = await readJson(res);
  if (!data || !Array.isArray(data.positions)) {
    replaceChildren(portfolioEl, placeholder(`Unexpected response from ${hostOf(base)}`));
    return;
  }

  if (data.handle) {
    handleChip.textContent = `@${data.handle}`;
    handleChip.hidden = false;
  } else {
    handleChip.hidden = true;
  }

  const stats = el('div', 'stats');
  stats.appendChild(stat('Balance', usd.format(data.balanceUsd), 'yellow', 'USDC'));
  const pnlDir = data.unrealizedPnlUsd >= 0 ? 'up' : 'down';
  stats.appendChild(
    stat('Unrealized', signed(data.unrealizedPnlUsd, (x) => usd.format(x)), pnlDir,
      `${signed(data.realizedPnlUsd, (x) => usd.format(x))} realized`)
  );
  stats.appendChild(stat('Open', String(data.positions.length), '', `${data.totalTrades} trades`));

  const list = el('div', 'list');
  list.appendChild(stats);
  if (data.positions.length === 0) {
    list.appendChild(placeholder('No open positions', {
      label: 'Browse markets',
      onClick: () => openTab(`${base}/app`)
    }));
  } else {
    for (const p of data.positions) list.appendChild(positionRow(p, base));
  }
  replaceChildren(portfolioEl, list);
}

const TREND = {
  spiking: { glyph: '▲▲', cls: 'up' },
  rising: { glyph: '▲', cls: 'up' },
  falling: { glyph: '▼', cls: 'down' },
  new: { glyph: '✦', cls: 'value yellow' },
  stable: { glyph: '—', cls: 'muted' }
};

// /api/captures returns the capture feed newest-first; the dashboard groups
// it by market and ranks by VI, so do the same here.
function topMarkets(captures) {
  const byMarket = new Map();
  for (const c of captures) {
    if (!c.marketId) continue;
    const entry = byMarket.get(c.marketId);
    if (entry) {
      entry.captures += 1;
    } else {
      byMarket.set(c.marketId, { latest: c, captures: 1 });
    }
  }
  return [...byMarket.values()]
    .sort((a, b) => b.latest.viralityScore - a.latest.viralityScore)
    .slice(0, TOP_MARKETS);
}

function marketRow(group, rank, base) {
  const c = group.latest;
  const row = el('button', 'row');
  row.type = 'button';
  row.title = 'Open market';
  row.addEventListener('click', () => openTab(`${base}/app/markets/${c.marketId}`));

  const lead = el('div', 'lead');
  lead.appendChild(el('div', 'name', c.analysis?.name || 'Unknown'));
  const category = c.analysis?.category || c.analysis?.type || 'other';
  lead.appendChild(
    el('div', 'meta', `${category} · ${group.captures} capture${group.captures === 1 ? '' : 's'}`)
  );

  const trend = TREND[c.trends?.trend] || TREND.stable;
  const end = el('div', 'end');
  end.appendChild(el('div', 'big', `VI ${c.viralityScore}`));
  end.appendChild(el('div', `small trend ${trend.cls}`, `${trend.glyph} ${c.trends?.trend || 'stable'}`));

  row.append(el('div', 'rank', String(rank)), lead, end);
  return row;
}

async function loadMarkets() {
  let res;
  let base;
  try {
    ({ res, base } = await fetchJson('/api/captures'));
  } catch {
    replaceChildren(marketsEl, placeholder(`Can't reach ${hostOf(await getWebAppUrl())}`));
    marketsMeta.textContent = '';
    return;
  }
  if (!res.ok) {
    replaceChildren(marketsEl, placeholder(`Markets unavailable (${res.status})`));
    marketsMeta.textContent = '';
    return;
  }

  const data = await readJson(res);
  if (!data || !Array.isArray(data.captures)) {
    replaceChildren(marketsEl, placeholder(`Unexpected response from ${hostOf(base)}`));
    marketsMeta.textContent = '';
    return;
  }
  const groups = topMarkets(data.captures);
  marketsMeta.textContent = groups.length ? 'by Virality Index' : '';

  if (groups.length === 0) {
    replaceChildren(marketsEl, placeholder('No markets yet — capture something to spawn one'));
    return;
  }
  replaceChildren(marketsEl, ...groups.map((g, i) => marketRow(g, i + 1, base)));
}

let refreshing = false;
async function refreshData() {
  if (refreshing) return;
  refreshing = true;
  refreshBtn.classList.add('spinning');
  try {
    await Promise.all([loadPortfolio(), loadMarkets()]);
  } finally {
    refreshing = false;
    refreshBtn.classList.remove('spinning');
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

loadSettings();
loadStatus();
refreshData();
schedule();
