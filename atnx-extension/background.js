const DEFAULT_WEB_APP_URL = 'https://atnx.app';

// One-time cleanup: legacy `captures` array stored base64 screenshots and
// blew the 10 MB chrome.storage.local quota. Web dashboard is now the source
// of truth, so drop the key on every service-worker wake.
chrome.storage.local.remove('captures').catch(() => {});
// Claude vision moved server-side in v1.2 — the extension no longer needs
// an Anthropic API key. Clear any stored value on every wake.
chrome.storage.local.remove('apiKey').catch(() => {});

async function getWebAppUrl() {
  const { webAppUrl } = await chrome.storage.local.get('webAppUrl');
  const raw = (webAppUrl || '').trim().replace(/\/+$/, '');
  return raw || DEFAULT_WEB_APP_URL;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Inject content script if not already present, then send activation message
async function activateTab(tab) {
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'activate-capture' });
  } catch {
    // Content script not injected yet — inject it manually
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ['content.css']
    });
    await chrome.tabs.sendMessage(tab.id, { action: 'activate-capture' });
  }
}

// Command listener (hotkey)
chrome.commands.onCommand.addListener((command) => {
  if (command === 'activate-capture') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        activateTab(tabs[0]);
      }
    });
  }
});

// Message listener
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'capture-region') {
    handleCapture(msg, sender.tab);
  }
  if (msg.action === 'start-capture') {
    // From popup
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        activateTab(tabs[0]);
      }
    });
  }
  if (msg.action === 'get-status') {
    chrome.storage.local.get(['captureStatus', 'captureCount'], (data) => {
      sendResponse({
        status: data.captureStatus || 'ready',
        count: data.captureCount || 0
      });
    });
    return true;
  }
});

function base64ToBlob(base64, mediaType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mediaType });
}

async function handleCapture(msg, tab) {
  try {
    updateStatus('capturing');
    notifyTab(tab, 'capturing');

    // 1. Capture visible tab
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });

    // 2. Crop to selection using offscreen document
    const croppedBase64 = await cropImageOffscreen(dataUrl, msg.rect);

    updateStatus('analyzing');
    notifyTab(tab, 'analyzing');

    // 3. Bump the popup counter (web app holds the durable history).
    const { captureCount = 0 } = await chrome.storage.local.get('captureCount');
    await chrome.storage.local.set({ captureCount: captureCount + 1 });

    // 4. POST the raw image to the web app. The server runs Claude vision and
    // persists the capture. `credentials: 'include'` attaches the Supabase
    // auth cookie so the handler can attribute the capture to the user.
    const webAppUrl = await getWebAppUrl();
    const form = new FormData();
    form.append('image', base64ToBlob(croppedBase64, 'image/png'), 'capture.png');
    form.append('sourceUrl', msg.pageUrl || '');
    form.append('pageTitle', msg.pageTitle || '');

    let persistFailed = null;
    let serverPayload = null;
    try {
      const res = await fetch(`${webAppUrl}/api/captures`, {
        method: 'POST',
        credentials: 'include',
        body: form
      });
      if (res.status === 401) {
        persistFailed = `Sign in at ${hostOf(webAppUrl)} first`;
      } else if (!res.ok) {
        persistFailed = `Save failed (${res.status})`;
      } else {
        serverPayload = await res.json().catch(() => null);
      }
    } catch (e) {
      console.warn('Could not send to web app:', e.message);
      persistFailed = 'Web app unreachable — check URL in popup';
    }

    if (persistFailed) {
      updateStatus('error');
      notifyTab(tab, 'error', persistFailed);
      setTimeout(() => updateStatus('ready'), 5000);
    } else {
      const name = serverPayload?.entityName || 'Content';
      updateStatus('done');
      notifyTab(tab, 'done', `Identified: ${name}`);
      setTimeout(() => updateStatus('ready'), 3000);
    }
  } catch (err) {
    console.error('Capture error:', err);
    updateStatus('error');
    notifyTab(tab, 'error', err.message);
    setTimeout(() => updateStatus('ready'), 5000);
  }
}

function notifyTab(tab, status, detail) {
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, {
    action: 'capture-status',
    status,
    detail
  }).catch(() => {});
}

async function cropImageOffscreen(dataUrl, rect) {
  // Ensure offscreen document exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Crop screenshot to selection area'
    });
  }

  const response = await chrome.runtime.sendMessage({
    action: 'crop-image',
    dataUrl: dataUrl,
    rect: rect
  });

  return response.base64;
}

function updateStatus(status) {
  chrome.storage.local.set({ captureStatus: status });
}
