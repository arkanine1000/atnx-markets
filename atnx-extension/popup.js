const apiKeyInput = document.getElementById('apiKey');
const saveKeyBtn = document.getElementById('saveKey');
const keyStatus = document.getElementById('keyStatus');
const captureBtn = document.getElementById('captureBtn');
const captureText = document.getElementById('captureText');
const statusDot = document.getElementById('statusDot');
const statusLabel = document.getElementById('statusLabel');
const captureCount = document.getElementById('captureCount');
const openDashboard = document.getElementById('openDashboard');

// Load saved API key
chrome.storage.local.get('apiKey', (data) => {
  if (data.apiKey) {
    apiKeyInput.value = data.apiKey;
    keyStatus.textContent = 'Key saved';
    keyStatus.className = 'status-text saved';
  }
});

// Save API key
saveKeyBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    keyStatus.textContent = 'Please enter a key';
    keyStatus.className = 'status-text error';
    return;
  }
  chrome.storage.local.set({ apiKey: key }, () => {
    keyStatus.textContent = 'Key saved';
    keyStatus.className = 'status-text saved';
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
  chrome.tabs.create({ url: 'http://localhost:3000' });
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
