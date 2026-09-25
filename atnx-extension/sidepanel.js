// Production lives on the www host (the apex domain redirects there), and
// the manifest grants `*.atnx.app`, so either spelling works — but the
// default skips the redirect.
const DEFAULT_WEB_APP_URL = 'https://www.atnx.app';
const STALE_STATUS_MS = 10_000;
// A capture still "busy" after this long means the worker died mid-flight
// (the upload itself gives up at 75 s); show the button again.
const BUSY_STALE_MS = 90_000;
const REFRESH_MS = 30_000;
// While the web app is failing, the wait between refreshes doubles up to
// this, so an outage is not met with a steady stream of retries.
const MAX_REFRESH_MS = 5 * 60_000;
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

// atnx.app (the install-time host permission) or a local dev server (the
// optional one). Nothing else can be granted.
function isAllowedWebAppUrl(url) {
  const { protocol, hostname } = new URL(url);
  if (protocol === 'https:' && (hostname === 'atnx.app' || hostname.endsWith('.atnx.app'))) return true;
  return protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1');
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
// `logo` draws the image contained on a light tile (a company mark) instead
// of filling the frame (a screenshot or portrait), as the web cards do.
function thumb(imageUrl, name, badge, logo = false) {
  const box = el('div', logo ? 'thumb logo' : 'thumb');
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
  if (open && !urlForm.hidden) webAppUrlInput.focus();
});

// The Web App URL setting is for admins. It also stays visible while a
// non-default URL is saved, so nobody is stranded on a host where they
// aren't (or can't be seen as) an admin. `isAdmin` comes from the
// portfolio answer; null until the first one arrives.
let isAdmin = null;
async function updateUrlFormVisibility() {
  const { webAppUrl } = await chrome.storage.local.get('webAppUrl');
  const custom = normalizeWebAppUrl(webAppUrl);
  urlForm.hidden = !(isAdmin === true || (custom && custom !== DEFAULT_WEB_APP_URL));
}
function setIsAdmin(value) {
  if (isAdmin === value) return;
  isAdmin = value;
  updateUrlFormVisibility();
}

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

  await updateUrlFormVisibility();

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
  // The manifest can only ever grant atnx.app and a local dev server, so
  // any other host would save fine and then fail on every request.
  if (!isAllowedWebAppUrl(normalized)) {
    setUrlStatus('Use an atnx.app address or a local one (localhost)', 'error');
    return;
  }

  // Host permission for the web app keeps the auth cookie flowing even when
  // third-party cookies are blocked. *.atnx.app is granted at install; a
  // local dev server (the optional localhost / 127.0.0.1 permission) is
  // requested here, inside the click.
  let granted = true;
  try {
    granted = await chrome.permissions.request({ origins: [originPattern(normalized)] });
  } catch (err) {
    console.warn('Permission request failed:', err.message);
    granted = false;
  }

  await chrome.storage.local.set({ webAppUrl: normalized });
  webAppUrlInput.value = normalized;
  // Whether they are an admin on the new host is for its answer to say.
  isAdmin = null;
  updateUrlFormVisibility();
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
const resultNote = $('resultNote');
const resultText = $('resultText');
const resultOpen = $('resultOpen');
const resultDismiss = $('resultDismiss');

// The last capture's market (written on success by the worker, or by the
// review below), shown with a link until it is dismissed, the next capture
// starts, or five minutes pass.
const RESULT_FRESH_MS = 5 * 60 * 1000;
let resultUrl = null;
let resultTimer = null;

function renderResult({ lastResult } = {}) {
  clearTimeout(resultTimer);
  const left = lastResult?.marketId ? RESULT_FRESH_MS - (Date.now() - (lastResult.at || 0)) : 0;
  resultNote.hidden = left <= 0;
  if (left <= 0) {
    resultUrl = null;
    return;
  }
  resultTimer = setTimeout(() => chrome.storage.local.remove('lastResult'), left);
  const name = lastResult.name || 'the market';
  resultText.textContent = lastResult.isNew ? `Created ${name}` : `Added to ${name}`;
  resultText.title = resultText.textContent;
  resultUrl = `${lastResult.base}/app/markets/${lastResult.marketId}`;
}

async function loadResult() {
  renderResult(await chrome.storage.local.get('lastResult'));
}

resultOpen.addEventListener('click', () => {
  if (resultUrl) openTab(resultUrl);
});

resultDismiss.addEventListener('click', () => chrome.storage.local.remove('lastResult'));

loadResult();

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
let busyTimer = null;
let viTimer = null;
const VI_FOLLOWUP_MS = 20_000;

function renderStatus({ captureStatus = 'ready', captureStatusAt = 0 }) {
  let status = captureStatus;
  const age = Date.now() - captureStatusAt;
  if ((status === 'done' || status === 'error') && age > STALE_STATUS_MS) {
    status = 'ready';
  }
  // A pending review keeps its badge until the panel commits or drops it;
  // the draft's own expiry is checked in loadReview().
  if (status === 'review') status = 'ready';
  let timedOut = false;
  if (BUSY[status] && age > BUSY_STALE_MS) {
    status = 'ready';
    timedOut = true;
  }

  captureBtn.className = 'btn-capture';
  captureText.textContent = 'CAPTURE';
  captureBtn.disabled = false;

  if (BUSY[status]) {
    captureBtn.classList.add('analyzing');
    captureBtn.disabled = true;
    captureText.textContent = BUSY[status];
    // Re-check when this status would go stale, so a dead worker cannot
    // leave the button disabled until the next storage event.
    clearTimeout(busyTimer);
    busyTimer = setTimeout(loadStatus, BUSY_STALE_MS - age + 50);
  } else if (timedOut) {
    captureNote.textContent = 'Last capture timed out — try again';
    captureNote.hidden = false;
  }

  // A finished capture changes the market list, so pull fresh data. The
  // server scores the market's VI after it answers, so pull once more a
  // little later to pick that up.
  if (status === 'done' && lastStatus !== 'done') {
    refreshData();
    clearTimeout(viTimer);
    viTimer = setTimeout(refreshData, VI_FOLLOWUP_MS);
  }
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
  if ('lastResult' in changes) loadResult();
  if ('pendingReview' in changes) loadReview();
});

// --- Review: the proposal the worker parked, waiting for a choice ---
//
// The compact version of /app/submit/review/<id>: the same draft, the same
// commit endpoint, without the crop tool (the selection was the crop) and
// without the name/type/alias pickers; those are one click away on the web.

const reviewEl = $('review');
let reviewBusy = false;

async function loadReview() {
  const { pendingReview } = await chrome.storage.local.get('pendingReview');
  const draft = pendingReview?.draft;
  if (!draft || new Date(draft.expiresAt).getTime() <= Date.now()) {
    if (pendingReview) dropReview('ready');
    reviewEl.hidden = true;
    reviewEl.replaceChildren();
    return;
  }
  renderReview(draft, pendingReview.base);
}

async function dropReview(status) {
  await chrome.storage.local.remove('pendingReview').catch(() => {});
  chrome.runtime.sendMessage({ action: 'set-status', status }).catch(() => {});
}

function reviewHeadline(draft) {
  const n = draft.nudge;
  const strong = n.candidates.find((c) => c.id === draft.choices.strongMatchId);
  if (n.tier === 'strong' && strong) return `Looks like ${strong.name}`;
  if (n.tier === 'subject' && n.subject) return `About ${n.subject.name}`;
  if (n.tier === 'ambiguous') return 'Could be one of these';
  return draft.choices.canCreate ? 'Nothing like this yet' : 'Review';
}

function renderReview(draft, base) {
  const n = draft.nudge;
  const c = draft.choices;
  const isDefault = (choice) => JSON.stringify(choice) === JSON.stringify(n.defaultChoice);
  const frag = document.createDocumentFragment();

  const head = el('div', 'review-head');
  head.append(el('span', 'tile-label', 'Review'), el('strong', '', reviewHeadline(draft)));
  frag.append(head);
  if (draft.analysis?.description) frag.append(el('p', 'review-desc', draft.analysis.description));

  const options = el('div', 'review-options');
  const offered = [...n.candidates, ...(n.subject ? [n.subject] : [])];
  for (const m of offered) {
    const choice = { kind: 'attach', marketId: m.id };
    const btn = el('button', `review-option${isDefault(choice) ? ' primary' : ''}`);
    btn.type = 'button';
    const meta =
      m.relation === 'subject'
        ? 'what this is about'
        : m.id === c.strongMatchId
          ? 'same thing'
          : m.similarity !== null
            ? `${Math.round(m.similarity * 100)}% similar`
            : '';
    btn.append(el('span', 'review-option-name', `Add to ${m.name}`), el('span', 'muted', `${meta}${meta ? ' · ' : ''}VI ${m.currentVi}`));
    btn.addEventListener('click', () => commitReview(draft, base, choice));
    options.append(btn);
  }
  if (c.canCreate && draft.analysis?.name) {
    const nm = draft.analysis;
    const choice = {
      kind: 'create',
      name: c.names[0] || nm.name,
      entityType: nm.entityType || 'other',
      category: nm.category || 'other',
      aliases: c.aliases,
      parentMarketId: c.parentMarketId
    };
    const btn = el('button', `review-option${isDefault({ ...choice, parentMarketId: null }) || isDefault(choice) ? ' primary' : ''}`);
    btn.type = 'button';
    const note = c.strongMatchId
      ? 'this is something else · flagged for review'
      : c.parentMarketId && n.subject
        ? `its own market, marked as about ${n.subject.name}`
        : `${nm.entityType || 'market'} · ${nm.category || ''}`;
    btn.append(el('span', 'review-option-name', `Create “${choice.name}”`), el('span', 'muted', note));
    btn.addEventListener('click', () => commitReview(draft, base, choice));
    options.append(btn);
  }
  if (c.createSubject) {
    const btn = el('button', 'review-option');
    btn.type = 'button';
    btn.append(el('span', 'review-option-name', `Track ${c.createSubject.name} instead`), el('span', 'muted', c.createSubject.entityType));
    btn.addEventListener('click', () => commitReview(draft, base, { kind: 'create_subject' }));
    options.append(btn);
  }
  frag.append(options);

  const actions = el('div', 'review-actions');
  const full = el('a', '', 'Crop or edit on the web →');
  full.href = '#';
  full.addEventListener('click', (e) => {
    e.preventDefault();
    openTab(`${base}/app/submit/review/${draft.draftId}`);
  });
  const discard = el('button', 'link-btn', 'Discard');
  discard.type = 'button';
  discard.addEventListener('click', async () => {
    await dropReview('ready');
    loadReview();
  });
  actions.append(full, discard);
  frag.append(actions);
  frag.append(el('div', 'status-text review-note'));

  reviewEl.replaceChildren(frag);
  reviewEl.hidden = false;
}

async function commitReview(draft, base, choice) {
  if (reviewBusy) return;
  reviewBusy = true;
  reviewEl.classList.add('busy');
  const note = reviewEl.querySelector('.review-note');
  if (note) note.textContent = 'Saving…';
  try {
    const res = await fetch(`${base}/api/captures/commit`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId: draft.draftId, choice })
    });
    const body = await readJson(res);
    if (res.ok && body?.success) {
      const { captureCount = 0 } = await chrome.storage.local.get('captureCount');
      await chrome.storage.local.set({ captureCount: captureCount + 1 });
      if (body.marketId) {
        await chrome.storage.local.set({
          lastResult: { marketId: body.marketId, name: body.entityName, isNew: !!body.isNew, base, at: Date.now() }
        });
      }
      await dropReview('done');
      loadReview();
      refreshData();
      return;
    }
    if (res.status === 410) {
      await dropReview('ready');
      loadReview();
      captureNote.textContent = body?.error || 'That review expired — capture again';
      captureNote.hidden = false;
      return;
    }
    if (note) note.textContent = body?.error || `Save failed (${res.status})`;
  } catch (e) {
    if (note) note.textContent = `Can't reach ${hostOf(base)}: ${e.message}`;
  } finally {
    reviewBusy = false;
    reviewEl.classList.remove('busy');
  }
}

loadReview();

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
const avatarEl = $('avatar');
// The seed of the avatar drawn now, so a poll with the same account does
// not redraw it every 30 s.
let avatarSeed = null;
const refreshBtn = $('refreshBtn');

// Last good payload per range, so switching tabs is instant and a failed
// refresh never blanks a chart that was fine a moment ago.
const portfolioCache = new Map();
let signedIn = false;

function setHandle(handle, userId) {
  handleChip.textContent = handle ? `@${handle}` : 'Not signed in';
  handleChip.className = handle ? 'handle' : 'handle muted';
  setAvatar(userId || null);
}

// The account's face beside the handle, the same one the site draws from
// the same id (identicon.js); the ATNX mark while nobody is signed in.
function setAvatar(userId) {
  if (userId === avatarSeed) return;
  avatarSeed = userId;
  if (userId && typeof identiconSvg === 'function') {
    avatarEl.replaceChildren(identiconSvg(userId, 28));
  } else {
    const img = document.createElement('img');
    img.src = 'icons/icon48.png';
    img.width = 28;
    img.height = 28;
    img.alt = '';
    avatarEl.replaceChildren(img);
  }
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

// --- Trading: close from the portfolio, open from the top markets ---
//
// The same two trades the site's pages make, through /api/positions (open)
// and /api/positions/<id>/close, so nothing here needs a tab. The numbers
// shown before a trade (fee, total, liquidation VI) follow lib/pnl.ts; the
// server is the one that decides, at the market's VI when it answers.

const FEE_RATE = 0.01;
const QUICK_SIZES = [25, 50, 100, 500];
const LEVERAGES = [1, 2, 5, 10];
const NOTE_MS = 7_000;

const portfolioNote = $('portfolioNote');
const marketsNote = $('marketsNote');

// The cash balance from the last portfolio answer; null while signed out.
let balanceUsd = null;
// The position whose row is expanded (entry, PnL, the close button).
let expandedPositionId = null;
let closingId = null;
// The order ticket open under a top-market row, and what it holds. The
// last ticket's side, size and leverage carry over to the next one.
let ticket = null; // { marketId, side, amount, lev }
let ticketBusy = false;
let ticketError = null;
let lastTicket = { side: 'long', amount: '100', lev: 1 };
// The last good answers, so a toggle re-renders without another fetch.
let lastPortfolio = null; // { data, base }
let lastMarkets = null; // { top, base }

const noteTimers = new WeakMap();
function showNote(target, text, kind = '') {
  target.textContent = text;
  target.className = `note trade-note ${kind}`.trim();
  target.hidden = false;
  clearTimeout(noteTimers.get(target));
  noteTimers.set(target, setTimeout(() => {
    target.hidden = true;
  }, NOTE_MS));
}

// Fee on an open, in whole cents, the way open_position() rounds it.
function tradeFee(sizeUsd) {
  return Math.round(sizeUsd * FEE_RATE * 100) / 100;
}

// The VI at which the position is liquidated: a move of 1/leverage against it.
function liquidationVi(entryVi, side, leverage) {
  const move = entryVi / (leverage || 1);
  return side === 'long' ? Math.max(0, entryVi - move) : entryVi + move;
}

// The most you can put in when the fee comes out of the same balance.
function maxSize(balance) {
  return Math.max(0, Math.floor(balance / (1 + FEE_RATE)));
}

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function postJson(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return { res, body: await readJson(res) };
}

// The message for a trade the web app refused. A 404 that carries no JSON
// is a web app without the endpoint, not a missing position.
function tradeError(res, body, base) {
  if (res.status === 401) return `Sign in at ${hostOf(base)} first`;
  if (body?.error) return body.error;
  if (res.status === 404) return 'Trading from the panel needs a newer web app build';
  return `Failed (${res.status})`;
}

// Restore focus to the control that had it before a list was rebuilt, so a
// refresh mid-typing does not throw the person out of the amount field.
function rerender(container, build) {
  const key = document.activeElement?.dataset?.focusKey;
  container.replaceChildren(...build());
  if (!key) return;
  const again = container.querySelector(`[data-focus-key="${key}"]`);
  if (!again) return;
  again.focus();
  if (typeof again.setSelectionRange === 'function') {
    const n = again.value.length;
    again.setSelectionRange(n, n);
  }
}

// Position row: thumbnail · name · current value / PnL %. Expands to the
// entry and exit numbers and the close button.
function positionRow(p, base) {
  const wrap = el('div', 'pos');
  const open = expandedPositionId === p.id;
  const row = el('button', 'row');
  row.type = 'button';
  row.dataset.focusKey = `pos-${p.id}`;
  row.setAttribute('aria-expanded', String(open));
  row.title = `${p.direction === 'short' ? 'Short' : 'Long'} ${p.leverage}x · ${usd.format(p.sizeUsd)} in · VI ${p.entryVi} → ${p.currentVi}`;
  row.addEventListener('click', () => {
    expandedPositionId = open ? null : p.id;
    renderPortfolio();
  });

  const badge = p.direction === 'short' ? { text: 'S', title: 'Short' } : null;
  const dir = p.pnlPercent >= 0 ? 'up' : 'down';
  const end = el('div', 'end');
  end.appendChild(el('div', 'big', usd.format(p.valueUsd ?? p.sizeUsd + p.pnlUsd)));
  end.appendChild(el('div', `small ${dir}`, p.liquidated ? 'liquidating' : `${signed(p.pnlPercent, (x) => x.toFixed(1))}%`));

  row.append(thumb(p.imageUrl, p.name, badge, p.imageSource === 'wikidata:logo'), el('div', 'name', p.name), end);
  wrap.append(row);
  if (open) wrap.append(positionDetail(p, base));
  return wrap;
}

function positionDetail(p, base) {
  const box = el('div', 'row-detail');
  box.append(el('div', 'detail-caption', `${p.direction === 'short' ? 'Short' : 'Long'} ${p.leverage}× · ${usd.format(p.sizeUsd)} in · opened ${timeAgo(p.openedAt)}`));

  const up = p.pnlUsd >= 0;
  const facts = el('dl', 'facts');
  for (const [label, value, cls] of [
    ['Entry', String(p.entryVi), 'yellow'],
    ['Now', String(p.currentVi), 'yellow'],
    ['PnL', signed(p.pnlUsd, (x) => usd.format(x)), up ? 'up' : 'down'],
    ['Size', usd.format(p.sizeUsd), '']
  ]) {
    const fact = el('div', 'fact');
    fact.append(el('dt', '', label), el('dd', cls, value));
    facts.append(fact);
  }

  const actions = el('div', 'detail-actions');
  const view = el('a', '', 'View market ↗');
  view.href = '#';
  view.addEventListener('click', (e) => {
    e.preventDefault();
    openTab(`${base}/app/markets/${p.marketId}`);
  });
  const closing = closingId === p.id;
  const closeBtn = el('button', 'btn-small', closing ? 'Closing…' : p.liquidated ? 'Settle position' : 'Close position');
  closeBtn.type = 'button';
  closeBtn.dataset.focusKey = `close-${p.id}`;
  closeBtn.disabled = closing;
  closeBtn.addEventListener('click', () => closePosition(p, base));
  actions.append(view, closeBtn);

  box.append(facts, actions);
  return box;
}

async function closePosition(p, base) {
  if (closingId) return;
  closingId = p.id;
  renderPortfolio();
  try {
    const { res, body } = await postJson(base, `/api/positions/${encodeURIComponent(p.id)}/close`);
    if (res.ok && body?.success) {
      const pnl = Number(body.realizedPnl ?? 0);
      const pct = p.sizeUsd > 0 ? (pnl / p.sizeUsd) * 100 : 0;
      const exit = Number.isFinite(Number(body.exitVi)) ? Math.round(Number(body.exitVi)) : p.currentVi;
      showNote(
        portfolioNote,
        body.liquidated
          ? `${p.name} liquidated · ${signed(pnl, (x) => usd.format(x))} · nothing paid back`
          : `Closed ${p.name} · ${signed(pnl, (x) => usd.format(x))} (${signed(pct, (x) => x.toFixed(1))}%) at VI ${exit}`,
        pnl >= 0 && !body.liquidated ? 'up' : 'down'
      );
      expandedPositionId = null;
      closingId = null;
      portfolioCache.clear();
      await refreshData();
      return;
    }
    if (res.status === 401) {
      setSignedOut(base);
      return;
    }
    showNote(portfolioNote, tradeError(res, body, base), 'error');
    // Closed elsewhere already (the site, or a liquidation): show the truth.
    if (res.status === 404 && body?.error) {
      expandedPositionId = null;
      portfolioCache.clear();
      refreshData();
    }
  } catch (e) {
    showNote(portfolioNote, `Can't reach ${hostOf(base)}: ${e.message}`, 'error');
  } finally {
    closingId = null;
    renderPortfolio();
  }
}

// The order ticket under a top-market row: side, size, leverage, the
// numbers, and the button. Built once per render; the controls patch the
// numbers in place so typing never loses the field.
function ticketEl(c, base) {
  const t = ticket;
  const entry = Number(c.viralityScore) || 0;
  const box = el('div', 'ticket');

  const sides = el('div', 'seg sides');
  const sideBtns = [];
  for (const s of ['long', 'short']) {
    const b = el('button', `seg-btn ${s}`, s === 'long' ? '↗ Long' : '↘ Short');
    b.type = 'button';
    b.dataset.focusKey = `side-${s}`;
    b.addEventListener('click', () => {
      t.side = s;
      update();
    });
    sides.append(b);
    sideBtns.push([s, b]);
  }

  const amountHead = el('div', 'ticket-row');
  const amountLabel = el('label', 'tile-label', 'Amount');
  amountLabel.htmlFor = 'ticketAmount';
  const maxBtn = el('button', 'link-btn');
  maxBtn.type = 'button';
  maxBtn.dataset.focusKey = 'max';
  maxBtn.title = 'Leaves room for the 1% fee';
  maxBtn.addEventListener('click', () => {
    if (balanceUsd === null) return;
    t.amount = String(maxSize(balanceUsd));
    update();
  });
  amountHead.append(amountLabel, maxBtn);

  const field = el('div', 'amount-field');
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.id = 'ticketAmount';
  input.className = 'ticket-amount';
  input.autocomplete = 'off';
  input.value = t.amount;
  input.dataset.focusKey = 'amount';
  input.addEventListener('input', () => {
    t.amount = input.value;
    update(false);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit.click();
    }
  });
  field.append(el('span', 'currency', '$'), input, el('span', 'unit', 'USDC'));

  const quick = el('div', 'quick');
  const quickBtns = [];
  for (const q of QUICK_SIZES) {
    const b = el('button', 'quick-btn', `$${q}`);
    b.type = 'button';
    b.dataset.focusKey = `quick-${q}`;
    b.addEventListener('click', () => {
      t.amount = String(q);
      update();
    });
    quick.append(b);
    quickBtns.push([q, b]);
  }

  const levRow = el('div', 'ticket-row');
  levRow.append(el('span', 'tile-label', 'Leverage'));
  const levSeg = el('div', 'seg');
  levSeg.setAttribute('role', 'group');
  levSeg.setAttribute('aria-label', 'Leverage');
  const levBtns = [];
  for (const l of LEVERAGES) {
    const b = el('button', 'seg-btn', `${l}×`);
    b.type = 'button';
    b.dataset.focusKey = `lev-${l}`;
    b.addEventListener('click', () => {
      t.lev = l;
      update();
    });
    levSeg.append(b);
    levBtns.push([l, b]);
  }
  levRow.append(levSeg);

  const summary = el('dl', 'summary');
  const line = (label, cls, title) => {
    const row = el('div', 'summary-row');
    const dt = el('dt', '', label);
    if (title) dt.title = title;
    const dd = el('dd', cls || '');
    row.append(dt, dd);
    summary.append(row);
    return dd;
  };
  line('Entry VI', 'yellow').textContent = String(entry);
  const ddExposure = line('Exposure');
  const ddLiq = line('Liquidation VI', 'down');
  const ddFee = line('Fee (1%)', '', "Half goes to whoever created this market, half to the treasury");
  const ddTotal = line('Total', 'strong');
  const ddAvail = signedIn ? line('Available') : null;

  const note = el('div', 'status-text ticket-note');

  const submit = el('button', 'btn-trade');
  submit.type = 'button';
  submit.dataset.focusKey = 'submit';
  submit.addEventListener('click', () => {
    if (!signedIn) openSignIn(base);
    else submitTicket(c, base);
  });

  const actions = el('div', 'review-actions');
  const view = el('a', '', 'View market ↗');
  view.href = '#';
  view.addEventListener('click', (e) => {
    e.preventDefault();
    openTab(`${base}/app/markets/${c.marketId}`);
  });
  const cancel = el('button', 'link-btn', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    ticket = null;
    ticketError = null;
    renderMarkets();
  });
  actions.append(view, cancel);

  function update(syncInput = true) {
    const amount = parseFloat(t.amount) || 0;
    const fee = tradeFee(amount);
    const total = amount + fee;
    const over = signedIn && balanceUsd !== null && total > balanceUsd;
    const long = t.side === 'long';

    for (const [s, b] of sideBtns) b.setAttribute('aria-pressed', String(t.side === s));
    for (const [q, b] of quickBtns) b.setAttribute('aria-pressed', String(amount === q));
    for (const [l, b] of levBtns) {
      b.setAttribute('aria-pressed', String(t.lev === l));
      b.title = `A ${l}× ${t.side} loses everything when the VI moves ${Math.round(100 / l)}% against it`;
    }
    if (syncInput) input.value = t.amount;
    field.classList.toggle('over', over);
    maxBtn.hidden = balanceUsd === null;
    maxBtn.textContent = balanceUsd === null ? '' : `Max ${usd.format(maxSize(balanceUsd))}`;

    ddExposure.textContent = usd.format(amount * t.lev);
    ddLiq.textContent = String(Math.round(liquidationVi(entry, t.side, t.lev)));
    ddFee.textContent = usd.format(fee);
    ddTotal.textContent = usd.format(total);
    if (ddAvail) {
      ddAvail.textContent = usd.format(balanceUsd ?? 0);
      ddAvail.className = over ? 'down' : '';
    }

    box.classList.toggle('short', !long);
    if (signedIn) {
      submit.className = `btn-trade ${t.side}`;
      submit.textContent = ticketBusy ? 'Opening…' : `Open ${long ? 'Long' : 'Short'} · ${usd.format(amount)}`;
      submit.disabled = ticketBusy || amount <= 0 || over;
    } else {
      submit.className = 'btn-trade signin';
      submit.textContent = 'Sign in to trade';
      submit.disabled = false;
    }
    note.textContent = ticketError || (over ? 'Amount plus fee exceeds your balance' : '');
    note.classList.toggle('error', Boolean(ticketError || over));
    lastTicket = { side: t.side, amount: t.amount, lev: t.lev };
  }
  update();

  box.append(sides, amountHead, field, quick, levRow, summary, note, submit, actions);
  return box;
}

function toggleTicket(c) {
  ticket = ticket?.marketId === c.marketId ? null : { marketId: c.marketId, ...lastTicket };
  ticketError = null;
  renderMarkets();
  if (ticket) {
    const input = marketsEl.querySelector('.ticket-amount');
    if (input) {
      input.focus();
      input.select();
    }
  }
}

async function submitTicket(c, base) {
  const t = ticket;
  if (!t || ticketBusy) return;
  const amount = parseFloat(t.amount) || 0;
  if (amount <= 0) return;
  ticketBusy = true;
  ticketError = null;
  renderMarkets();
  try {
    const { res, body } = await postJson(base, '/api/positions', {
      marketId: c.marketId,
      direction: t.side,
      sizeUsd: amount,
      leverage: t.lev
    });
    if (res.ok && body?.success) {
      const name = c.analysis?.name || 'this market';
      ticket = null;
      ticketBusy = false;
      showNote(
        marketsNote,
        `Opened ${t.side} ${t.lev}× · ${usd.format(amount)} on ${name}`,
        t.side === 'long' ? 'up' : 'down'
      );
      // The new position shows up in the portfolio list, so open it.
      setPortfolioOpen(true);
      portfolioCache.clear();
      await refreshData();
      return;
    }
    if (res.status === 401) {
      setSignedOut(base);
      return;
    }
    ticketError = tradeError(res, body, base);
  } catch (e) {
    ticketError = `Can't reach ${hostOf(base)}: ${e.message}`;
  } finally {
    ticketBusy = false;
    renderMarkets();
  }
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
  setIsAdmin(false);
  valueTile.hidden = true;
  portfolioCache.clear();
  balanceUsd = null;
  lastPortfolio = null;
  expandedPositionId = null;
  // An open ticket now offers sign-in instead of the trade.
  if (ticket) renderMarkets();

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

// Resolves true when the web app answered properly (signed out counts:
// that is an answer), false when it could not be reached or errored, which
// slows the refresh timer down.
async function loadPortfolio() {
  const range = chartRange;
  let res;
  let base;
  try {
    ({ res, base } = await fetchJson(`/api/portfolio?range=${range}`));
  } catch {
    valueTile.hidden = true;
    portfolioEl.replaceChildren(placeholder(`Can't reach ${hostOf(await getWebAppUrl())}`));
    return false;
  }

  if (res.status === 401) {
    setSignedOut(base);
    return true;
  }
  if (!res.ok) {
    valueTile.hidden = true;
    portfolioEl.replaceChildren(placeholder(
      res.status === 404 ? 'Portfolio needs a newer web app build' : `Portfolio unavailable (${res.status})`
    ));
    return false;
  }

  const data = await readJson(res);
  if (!data || !Array.isArray(data.positions)) {
    valueTile.hidden = true;
    portfolioEl.replaceChildren(placeholder(`Unexpected response from ${hostOf(base)}`));
    return false;
  }

  signedIn = true;
  authNote.hidden = true;
  setHandle(data.handle, data.userId);
  setIsAdmin(data.isAdmin === true);
  portfolioCache.set(range, data);
  balanceUsd = Number(data.balanceUsd) || 0;
  // The user switched range while this request was in flight; the newer
  // request will draw the tile.
  if (range !== chartRange) return true;

  renderTile(data);
  lastPortfolio = { data, base };
  renderPortfolio();
  return true;
}

// The portfolio card from the last answer. Collapsed: the three numbers.
// Expanded: the open positions, one of which may be expanded in turn.
function renderPortfolio() {
  if (!lastPortfolio) return;
  const { data, base } = lastPortfolio;

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

  rerender(portfolioEl, () => [toggle, list]);
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

// Market row: thumbnail · name · VI. Expands to the order ticket.
function marketRow(c, base, rank, heat) {
  const wrap = el('div', 'mkt');
  // 1 → 0.25 heat across the five rows; the rail on the row reads it.
  wrap.style.setProperty('--rank-heat', String(heat));
  const open = ticket?.marketId === c.marketId;
  const row = el('button', 'row ranked');
  row.type = 'button';
  row.dataset.focusKey = `mkt-${c.marketId}`;
  row.setAttribute('aria-expanded', String(open));
  const trend = c.trends?.trend;
  row.title = trend ? `Virality Index ${c.viralityScore} · ${trend}` : `Virality Index ${c.viralityScore}`;
  row.addEventListener('click', () => toggleTicket(c));

  const name = c.analysis?.name || 'Unknown';
  const end = el('div', 'end');
  end.appendChild(el('div', 'big', String(c.viralityScore)));

  // The market's curated image when the web app has one (the logo, the
  // portrait, the meme's reference picture); the newest capture otherwise.
  row.append(
    el('div', 'rank', String(rank)),
    thumb(c.marketImage || c.screenshot, name, null, Boolean(c.marketImage) && c.marketImageSource === 'wikidata:logo'),
    el('div', 'name', name),
    end
  );
  wrap.append(row);
  if (open) wrap.append(ticketEl(c, base));
  return wrap;
}

// The top-markets list from the last answer, the open ticket included.
function renderMarkets() {
  if (!lastMarkets) return;
  const { top, base } = lastMarkets;
  rerender(marketsEl, () =>
    top.map((c, i) => marketRow(c, base, i + 1, 1 - (i / Math.max(1, top.length - 1)) * 0.75))
  );
}

// Same contract as loadPortfolio: true when the web app answered.
async function loadMarkets() {
  let res;
  let base;
  try {
    ({ res, base } = await fetchJson('/api/captures'));
  } catch {
    marketsEl.replaceChildren(placeholder(`Can't reach ${hostOf(await getWebAppUrl())}`));
    marketsMeta.textContent = '';
    return false;
  }
  if (!res.ok) {
    marketsEl.replaceChildren(placeholder(`Markets unavailable (${res.status})`));
    marketsMeta.textContent = '';
    // 401 is the web app answering "sign in", not an outage; only a real
    // failure should slow the refresh timer down.
    return res.status === 401;
  }

  const data = await readJson(res);
  if (!data || !Array.isArray(data.captures)) {
    marketsEl.replaceChildren(placeholder(`Unexpected response from ${hostOf(base)}`));
    marketsMeta.textContent = '';
    return false;
  }
  const top = topMarkets(data.captures);
  marketsMeta.textContent = top.length ? 'VI Score' : '';

  if (top.length === 0) {
    lastMarkets = null;
    marketsEl.replaceChildren(placeholder('No markets yet — capture something to spawn one'));
    return true;
  }
  lastMarkets = { top, base };
  renderMarkets();
  return true;
}

// Wait until the next automatic refresh: REFRESH_MS while the web app is
// answering, doubling towards MAX_REFRESH_MS while it is not.
let refreshDelay = REFRESH_MS;

// One refresh at a time. A call that lands while one is running (a trade
// finishing during the 30 s poll) runs once more afterwards, so what the
// panel shows is never older than the trade.
let refreshing = false;
let refreshQueued = false;
async function refreshData() {
  if (refreshing) {
    refreshQueued = true;
    return;
  }
  refreshing = true;
  refreshBtn.classList.add('spinning');
  document.body.classList.add('refreshing');
  try {
    const ok = await Promise.all([loadPortfolio(), loadMarkets()]);
    refreshDelay = ok.every(Boolean) ? REFRESH_MS : Math.min(MAX_REFRESH_MS, refreshDelay * 2);
  } finally {
    refreshing = false;
    refreshBtn.classList.remove('spinning');
    document.body.classList.remove('refreshing');
  }
  if (refreshQueued) {
    refreshQueued = false;
    await refreshData();
  }
}

refreshBtn.addEventListener('click', refreshData);

// Poll while the panel is visible; stop when it is hidden. One timer at a
// time, re-armed after each refresh with the current delay.
let timer = null;
function schedule() {
  clearTimeout(timer);
  timer = null;
  if (document.visibilityState !== 'visible') return;
  timer = setTimeout(async () => {
    await refreshData();
    schedule();
  }, refreshDelay);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshData();
  schedule();
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
