const DEFAULT_WEB_APP_URL = 'https://atnx.app';

// A done/error status older than this is treated as stale: the service
// worker that wrote it was torn down before its reset timer fired.
const STALE_STATUS_MS = 10_000;

const $ = (id) => document.getElementById(id);
const urlForm = $('urlForm');
const webAppUrlInput = $('webAppUrl');
const urlStatus = $('urlStatus');
const captureBtn = $('captureBtn');
const captureText = $('captureText');
const statusDot = $('statusDot');
const statusLabel = $('statusLabel');
const captureCount = $('captureCount');
const shortcutLink = $('shortcutLink');
const openDashboard = $('openDashboard');

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

function originPattern(url) {
  return `${new URL(url).origin}/*`;
}

function setUrlStatus(text, kind = '') {
  urlStatus.textContent = text;
  urlStatus.className = `status-text ${kind}`.trim();
}

// --- Web App URL ---

async function loadWebAppUrl() {
  const { webAppUrl } = await chrome.storage.local.get('webAppUrl');
  if (!webAppUrl) return;
  webAppUrlInput.value = webAppUrl;
  const granted = await chrome.permissions.contains({
    origins: [originPattern(webAppUrl)]
  });
  setUrlStatus(
    granted ? 'URL saved' : 'Saved, but site access not granted',
    granted ? 'saved' : 'error'
  );
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
    granted = await chrome.permissions.request({
      origins: [originPattern(normalized)]
    });
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
});

// --- Capture button + dashboard link ---

captureBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'start-capture' });
  window.close();
});

openDashboard.addEventListener('click', async (e) => {
  e.preventDefault();
  const { webAppUrl } = await chrome.storage.local.get('webAppUrl');
  await chrome.tabs.create({ url: normalizeWebAppUrl(webAppUrl) || DEFAULT_WEB_APP_URL });
  window.close();
});

// Show whatever shortcut is actually bound (users can change it), and link
// to the shortcuts page. chrome:// URLs can't be opened via <a href>.
async function loadShortcut() {
  const commands = await chrome.commands.getAll();
  const cmd = commands.find((c) => c.name === 'activate-capture');
  shortcutLink.textContent = cmd?.shortcut || 'Set shortcut';
  shortcutLink.title = cmd?.shortcut ? 'Change shortcut' : 'No shortcut assigned — click to set one';
}

shortcutLink.addEventListener('click', async (e) => {
  e.preventDefault();
  await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  window.close();
});

// --- Status ---
// No polling: the background writes status to storage, and storage.onChanged
// fires in the popup the moment it changes.

const LABELS = {
  capturing: 'Capturing...',
  analyzing: 'Analyzing with AI...',
  done: 'Done!',
  error: 'Error occurred',
  ready: 'Ready'
};

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
    captureText.textContent = 'ANALYZING...';
  }
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

loadWebAppUrl();
loadShortcut();
loadStatus();
