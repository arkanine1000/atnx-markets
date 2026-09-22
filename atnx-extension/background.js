// Production lives on the www host; the apex domain 307s there, and a
// redirect target the extension held no host permission for is why v1.4
// showed "Not signed in" to signed-in users. The manifest now grants
// `*.atnx.app`, so both spellings work, but the default skips the hop.
const DEFAULT_WEB_APP_URL = 'https://www.atnx.app';
const LEGACY_WEB_APP_URL = /^https:\/\/atnx\.app\/*$/i;

// Longest edge (in device pixels) of the uploaded crop. Vision models
// downsample anything larger anyway, and Vercel rejects request bodies over
// 4.5 MB — a full-width retina PNG crop can blow straight past that.
// Long-edge cap for uploads. 1080 px is plenty for the vision model and
// keeps the JPEG well under a megabyte.
const MAX_UPLOAD_EDGE = 1080;
const UPLOAD_MIME = 'image/jpeg';
const UPLOAD_QUALITY = 0.85;

// The web app's capture handler has a 60 s budget (maxDuration on
// /api/captures). Give the upload a little longer than that, then give up
// rather than leave the panel on ANALYZING… forever.
const UPLOAD_TIMEOUT_MS = 75_000;
// A busy status older than this is a worker that died mid-capture (Chrome
// tears service workers down) — reset it so the button comes back.
const BUSY_STALE_MS = 90_000;

const BADGE = {
  capturing: { text: '…', color: '#FF00E5' },
  analyzing: { text: '…', color: '#FFE500' },
  done: { text: '✓', color: '#00D4FF' },
  error: { text: '!', color: '#FF00E5' },
  ready: { text: '', color: '#00D4FF' }
};

// Storage migrations. `captures` (v1.0) held base64 screenshots and blew the
// chrome.storage.local quota; `apiKey` (v1.1) became unnecessary once vision
// moved server-side in v1.2. Runs once per install/update instead of on every
// service-worker wake.
chrome.runtime.onInstalled.addListener(async () => {
  chrome.storage.local.remove(['captures', 'apiKey']).catch(() => {});
  // v1.4 saved the apex domain as the web app URL; fall back to the default
  // so requests go straight to www instead of through a redirect.
  const { webAppUrl } = await chrome.storage.local.get('webAppUrl');
  if (LEGACY_WEB_APP_URL.test((webAppUrl || '').trim())) {
    await chrome.storage.local.remove('webAppUrl').catch(() => {});
  }
  updateStatus('ready');
});

// Runs every time the worker wakes: if the previous incarnation was torn
// down while a capture was in flight, the stored status would stay busy and
// the panel's button would stay disabled.
chrome.storage.local
  .get(['captureStatus', 'captureStatusAt'])
  .then(({ captureStatus, captureStatusAt = 0 }) => {
    const busy = captureStatus === 'capturing' || captureStatus === 'analyzing';
    if (busy && Date.now() - captureStatusAt > BUSY_STALE_MS) updateStatus('ready');
  })
  .catch(() => {});

// Clicking the toolbar icon opens the side panel (there is no popup).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn('sidePanel behavior:', err.message));

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

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Content script is injected on demand (activeTab + scripting) rather than
// declared for <all_urls>, so nothing runs on pages the user never captures.
// content.js guards against double-injection, so a retry is always safe.
// Resolves to { ok: true } or { ok: false, reason } so the side panel can
// explain a failure inline.
async function activateTab(tab) {
  if (!tab?.id) return { ok: false, reason: 'No active tab' };
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'activate-capture' });
    return { ok: true };
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      await chrome.tabs.sendMessage(tab.id, { action: 'activate-capture' });
      return { ok: true };
    } catch (err) {
      // Two cases land here: restricted pages (chrome://, the Web Store,
      // PDFs) and tabs the extension has no activeTab grant for — the
      // grant comes from the hotkey or the toolbar click and is per-tab.
      console.warn('Cannot activate capture on this page:', err.message);
      updateStatus('error');
      resetStatusAfter(4000);
      const restricted = /chrome:\/\/|chrome-extension:\/\/|Web Store/i.test(
        `${tab.url || ''} ${err.message}`
      );
      return {
        ok: false,
        reason: restricted
          ? "Chrome doesn't allow captures on this page"
          : 'Press the shortcut on the page, or click the toolbar icon first'
      };
    }
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'activate-capture') {
    activateTab(await getActiveTab());
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'capture-region') {
    handleCapture(msg, sender.tab);
  } else if (msg.action === 'start-capture') {
    getActiveTab().then(activateTab).then(sendResponse);
    return true; // async sendResponse
  }
});

async function handleCapture(msg, tab) {
  try {
    // 1. Screenshot first, toast second — otherwise the "capturing" toast
    //    could land inside the crop.
    const dataUrl = await chrome.tabs.captureVisibleTab(tab?.windowId, {
      format: 'png'
    });

    updateStatus('capturing');
    notifyTab(tab, 'capturing');

    // 2. Crop (and cap the size) right here in the worker. OffscreenCanvas
    //    and createImageBitmap are available to service workers, so the old
    //    offscreen-document round trip is no longer needed.
    const blob = await cropScreenshot(dataUrl, msg.rect);

    updateStatus('analyzing');
    notifyTab(tab, 'analyzing');

    // 3. POST the image to the web app. The server runs the vision model and
    //    persists the capture. `credentials: 'include'` attaches the Supabase
    //    auth cookie so the handler can attribute the capture to the user.
    const webAppUrl = await getWebAppUrl();
    const form = new FormData();
    form.append('image', blob, 'capture.jpg');
    form.append('sourceUrl', msg.pageUrl || '');
    form.append('pageTitle', msg.pageTitle || '');

    let persistFailed = null;
    let serverPayload = null;
    try {
      const res = await fetch(`${webAppUrl}/api/captures`, {
        method: 'POST',
        credentials: 'include',
        body: form,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
      });
      if (res.status === 401) {
        persistFailed = `Sign in at ${hostOf(webAppUrl)} first`;
      } else if (res.status === 413) {
        persistFailed = 'Selection too large to upload';
      } else if (!res.ok) {
        persistFailed = `Save failed (${res.status})`;
      } else {
        serverPayload = await res.json().catch(() => null);
      }
    } catch (e) {
      console.warn('Could not send to web app:', e.message);
      persistFailed = e.name === 'TimeoutError'
        ? 'Analysis timed out — try a smaller selection'
        : `Can't reach ${hostOf(webAppUrl)} — check the URL in the side panel settings`;
    }

    if (persistFailed) {
      updateStatus('error');
      notifyTab(tab, 'error', persistFailed);
      resetStatusAfter(5000);
    } else {
      // Popup counter only; the web app holds the durable history.
      const { captureCount = 0 } = await chrome.storage.local.get('captureCount');
      await chrome.storage.local.set({ captureCount: captureCount + 1 });

      const name = serverPayload?.entityName || 'Content';
      updateStatus('done');
      notifyTab(tab, 'done', `Identified: ${name}`);
      resetStatusAfter(3000);
    }
  } catch (err) {
    console.error('Capture error:', err);
    updateStatus('error');
    notifyTab(tab, 'error', err.message);
    resetStatusAfter(5000);
  }
}

function notifyTab(tab, status, detail) {
  if (!tab?.id) return;
  chrome.tabs
    .sendMessage(tab.id, { action: 'capture-status', status, detail })
    .catch(() => {});
}

// rect is in CSS pixels relative to the viewport; the screenshot is in
// device pixels, so scale by the tab's devicePixelRatio.
async function cropScreenshot(dataUrl, rect) {
  const dpr = rect.devicePixelRatio || 1;
  const sx = Math.round(rect.x * dpr);
  const sy = Math.round(rect.y * dpr);
  const sw = Math.max(1, Math.round(rect.width * dpr));
  const sh = Math.max(1, Math.round(rect.height * dpr));

  const scale = Math.min(1, MAX_UPLOAD_EDGE / Math.max(sw, sh));
  const outW = Math.max(1, Math.round(sw * scale));
  const outH = Math.max(1, Math.round(sh * scale));

  const source = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(source, sx, sy, sw, sh, {
    resizeWidth: outW,
    resizeHeight: outH,
    resizeQuality: 'high'
  });

  const canvas = new OffscreenCanvas(outW, outH);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();

  return canvas.convertToBlob({ type: UPLOAD_MIME, quality: UPLOAD_QUALITY });
}

// Status is written to storage (the popup subscribes via storage.onChanged)
// and mirrored on the toolbar badge, which works even on pages that refuse
// content scripts. `captureStatusAt` lets the popup ignore a stale
// done/error if the worker was torn down before the reset timer fired.
function updateStatus(status) {
  const badge = BADGE[status] || BADGE.ready;
  chrome.action.setBadgeText({ text: badge.text });
  chrome.action.setBadgeBackgroundColor({ color: badge.color });
  chrome.action.setBadgeTextColor?.({ color: '#0A0A0A' });
  chrome.storage.local.set({ captureStatus: status, captureStatusAt: Date.now() });
}

let resetTimer = null;
function resetStatusAfter(ms) {
  clearTimeout(resetTimer);
  resetTimer = setTimeout(() => updateStatus('ready'), ms);
}
