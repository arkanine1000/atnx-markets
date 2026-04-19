const DEFAULT_WEB_APP_URL = 'https://atnx.app';

const webAppUrlInput = document.getElementById('webAppUrl');
const saveUrlBtn = document.getElementById('saveUrl');
const urlStatus = document.getElementById('urlStatus');
const captureBtn = document.getElementById('captureBtn');
const captureText = document.getElementById('captureText');
const statusDot = document.getElementById('statusDot');
const statusLabel = document.getElementById('statusLabel');
const captureCount = document.getElementById('captureCount');
const openDashboard = document.getElementById('openDashboard');

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

// Load saved Web App URL (default shown as placeholder; stored value wins).
chrome.storage.local.get('webAppUrl', (data) => {
  if (data.webAppUrl) {
    webAppUrlInput.value = data.webAppUrl;
    urlStatus.textContent = 'URL saved';
    urlStatus.className = 'status-text saved';
  }
});

// Save Web App URL
saveUrlBtn.addEventListener('click', () => {
  const normalized = normalizeWebAppUrl(webAppUrlInput.value);
  if (!normalized) {
    urlStatus.textContent = 'Enter a valid http(s) URL';
    urlStatus.className = 'status-text error';
    return;
  }
  chrome.storage.local.set({ webAppUrl: normalized }, () => {
    webAppUrlInput.value = normalized;
    urlStatus.textContent = 'URL saved';
    urlStatus.className = 'status-text saved';
  });
});

// Capture button
captureBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'start-capture' });
  window.close();
});

// Open dashboard
openDashboard.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.storage.local.get('webAppUrl', (data) => {
    const url = normalizeWebAppUrl(data.webAppUrl) || DEFAULT_WEB_APP_URL;
    chrome.tabs.create({ url });
  });
});

// Poll status
function updateStatusUI() {
  chrome.runtime.sendMessage({ action: 'get-status' }, (response) => {
    if (!response) return;

    const { status, count } = response;
    captureCount.textContent = `${count} capture${count !== 1 ? 's' : ''}`;

    statusDot.className = 'status-dot';
    captureBtn.className = 'btn-capture';

    switch (status) {
      case 'capturing':
        statusLabel.textContent = 'Capturing...';
        statusDot.classList.add('capturing');
        break;
      case 'analyzing':
        statusLabel.textContent = 'Analyzing with AI...';
        statusDot.classList.add('analyzing');
        captureBtn.classList.add('analyzing');
        captureText.textContent = 'ANALYZING...';
        break;
      case 'done':
        statusLabel.textContent = 'Done!';
        captureText.textContent = '⌘ CAPTURE';
        break;
      case 'error':
        statusLabel.textContent = 'Error occurred';
        statusDot.classList.add('error');
        captureText.textContent = '⌘ CAPTURE';
        break;
      default:
        statusLabel.textContent = 'Ready';
        captureText.textContent = '⌘ CAPTURE';
    }
  });
}

updateStatusUI();
setInterval(updateStatusUI, 1000);
