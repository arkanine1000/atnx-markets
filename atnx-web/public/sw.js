// ATNX service worker. Minimal shell so the app is installable as a PWA.
// Strategy: network-first for navigation, pass-through for everything else.
// We intentionally do NOT cache API responses — market data must stay live.
//
// The exception to pass-through is the Android share target. Picking ATNX
// in the share sheet POSTs the shared image or link to /share as a
// navigation. Left alone, that means a blank window for the seconds the
// model takes, a hosting error page when a raw screenshot is over the
// 4.5 MB body limit, and a lost capture when the user is signed out. So
// the worker takes the POST over:
//   1. answers it at once with a small "Capturing…" page,
//   2. shrinks the image to 1080 px JPEG (the cap the web form and the
//      extension apply), and uploads it to /share asking for JSON back,
//   3. moves that window to the market the route answers with, or, when
//      the route says the user is signed out, parks the capture in the
//      Cache API and moves the window to the sign-in page that replays it.
//
// The image is copied into memory before anything else is done with it.
// Chrome on Android hands over a File backed by a content URI whose read
// permission can be gone by the time it is decoded or uploaded (Chromium
// issue 40123366), and Chrome 153 has a regression that strips the file
// from the share entirely. Either way the person lands on the Create form
// with the picker emphasised and a notice that says exactly what arrived.

const SHELL_CACHE = 'atnx-shell-v4';
const SHELL_URLS = ['/app'];

const SHARE_PATH = '/share';
const RESUME_PATH = '/app/share/resume';
const PENDING_CACHE = 'atnx-share-pending';
const MAX_EDGE = 1080;
const JPEG_QUALITY = 0.85;
// Under this size an undecodable file is sent as-is and the server-side
// model gets to try. Above it there is nothing to send.
const MAX_RAW_BYTES = 4 * 1024 * 1024;
// How long to wait for the window that shows the progress page to exist.
const CLIENT_WAIT_MS = 8_000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== SHELL_CACHE && k !== PENDING_CACHE).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Only the share sheet's own POST (a navigation). A fetch() to /share
  // from a page, such as the replay after sign-in, passes straight through.
  if (req.method === 'POST' && url.pathname === SHARE_PATH && req.mode === 'navigate') {
    event.respondWith(handleShare(event));
    return;
  }

  if (req.method !== 'GET') return;

  // Navigation: network-first, fall back to cached shell so the app opens
  // offline after first install.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match('/app').then((res) => res || new Response('Offline', { status: 503 }))
      )
    );
    return;
  }
});

// Results by window client id, for a progress page that starts listening
// after the upload has already finished.
const results = new Map();

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'share-ready') return;
  const id = event.source && event.source.id;
  const url = id && results.get(id);
  if (url) {
    results.delete(id);
    event.source.postMessage({ type: 'share-result', url });
  }
});

async function handleShare(event) {
  const req = event.request;
  let form;
  try {
    form = await req.clone().formData();
  } catch (err) {
    console.warn('[sw] share body unreadable, passing through', err);
    return fetch(req);
  }
  event.waitUntil(processShare(form, event.resultingClientId));
  return new Response(progressPage(), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function processShare(form, clientId) {
  let target;
  try {
    target = await uploadShare(form);
  } catch (err) {
    console.error('[sw] share failed', err);
    const file = form.get('image');
    target =
      file instanceof File
        ? submitPath(
            `The upload failed before it left the phone (${err.message || 'unknown error'}; ${describeFile(file)}). Pick the screenshot below to finish.`
          )
        : `/app?shareError=${encodeURIComponent(err.message || 'Capture failed')}`;
  }
  await moveClient(clientId, target);
}

// The Create form with the picker emphasised and the text fields prefilled
// from what did arrive.
function submitPath(notice, form) {
  const params = new URLSearchParams({ notice, pick: '1' });
  if (form) {
    for (const key of ['url', 'text']) {
      const v = form.get(key);
      if (typeof v === 'string' && v.trim()) params.set(key, v.trim().slice(0, 1000));
    }
  }
  return `/app/submit?${params}`;
}

function describeFile(file) {
  const kb = Math.round(file.size / 1024);
  return `${file.name || 'unnamed'}, ${file.type || 'unknown type'}, ${kb} KB reported`;
}

// Resolves to the path the window should go to next.
async function uploadShare(form) {
  const file = form.get('image');
  const out = new FormData();
  for (const [key, value] of form.entries()) {
    if (key !== 'image') out.append(key, value);
  }

  if (file instanceof File) {
    // Copy the bytes now, while the permission Chrome was granted for this
    // share still holds. An empty or unreadable file ends here with a
    // notice; it must never be uploaded as the platform File, whose body
    // Chrome fails to read at request time ("Failed to fetch").
    let bytes;
    try {
      bytes = await file.arrayBuffer();
    } catch (err) {
      console.warn('[sw] share image unreadable', err);
      return submitPath(
        `Your phone offered a screenshot (${describeFile(file)}) but Chrome would not let ATNX read it. This is a Chrome for Android bug with photos from a cloud gallery. Pick the screenshot below to finish.`,
        form
      );
    }
    if (bytes.byteLength === 0) {
      console.warn('[sw] share image empty', describeFile(file));
      return submitPath(
        `The screenshot arrived empty (${describeFile(file)}, 0 bytes). Chrome for Android 153 has a bug that drops shared images. Pick the screenshot below to finish.`,
        form
      );
    }
    const copy = new Blob([bytes], { type: file.type || 'image/jpeg' });

    let upload;
    try {
      upload = await shrink(copy);
      console.log('[sw] share image shrunk', { from: copy.size, to: upload.size, type: file.type });
    } catch (err) {
      console.warn('[sw] share image could not be decoded', err);
      if (copy.size <= MAX_RAW_BYTES) upload = copy;
      else {
        return submitPath(
          `That screenshot could not be decoded and is too large to send as-is (${describeFile(file)}). Take a fresh screenshot and pick it below.`,
          form
        );
      }
    }
    out.append('image', upload, upload === copy ? file.name || 'share' : 'share.jpg');
  }

  const res = await fetch(SHARE_PATH, {
    method: 'POST',
    body: out,
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });

  let body = null;
  try {
    body = await res.json();
  } catch {
    // A hosting error page or a redirect from an older deploy.
  }
  if (!body || typeof body.redirect !== 'string') {
    throw new Error(res.ok ? 'Unexpected answer from the server' : `Upload failed (${res.status})`);
  }

  if (body.signIn) {
    await stashPending(out, upload);
    return RESUME_PATH;
  }
  return body.redirect;
}

// The multipart body cannot follow the user through Google sign-in, so it
// waits in the Cache API and /app/share/resume replays it once signed in.
async function stashPending(form, upload) {
  const cache = await caches.open(PENDING_CACHE);
  const fields = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') fields[key] = value;
  }
  await cache.put(
    '/pending/meta',
    new Response(JSON.stringify({ fields, hasImage: Boolean(upload), savedAt: Date.now() }), {
      headers: { 'content-type': 'application/json' },
    })
  );
  if (upload) {
    await cache.put(
      '/pending/image',
      new Response(upload, { headers: { 'content-type': upload.type || 'application/octet-stream' } })
    );
  } else {
    await cache.delete('/pending/image');
  }
}

async function waitForClient(clientId) {
  if (!clientId) return null;
  const deadline = Date.now() + CLIENT_WAIT_MS;
  while (Date.now() < deadline) {
    const client = await self.clients.get(clientId);
    if (client) return client;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

async function moveClient(clientId, url) {
  let client = await waitForClient(clientId);
  if (client) {
    // The page asks for its result on load (share-ready) in case every
    // push below reaches it too early.
    results.set(client.id, url);
    // A very quick upload can finish before the window has committed the
    // progress page, and navigate() refuses until it has. A few tries.
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await client.navigate(url);
        results.delete(client.id);
        return;
      } catch (err) {
        if (attempt === 5) console.warn('[sw] client.navigate failed, messaging instead', err);
        await new Promise((r) => setTimeout(r, 250));
        client = (await self.clients.get(clientId)) || client;
      }
    }
    client.postMessage({ type: 'share-result', url });
    return;
  }
  // No handle on the window: tell every progress page there is.
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of all) {
    if (new URL(c.url).pathname === SHARE_PATH) c.postMessage({ type: 'share-result', url });
  }
}

async function shrink(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Canvas unavailable');
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
}

// The page shown while the upload and the model run. Self-contained: no
// app CSS or JS is needed, and it must render before the network answers.
function progressPage() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0A0A0A">
<title>Capturing… · ATNX</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { background: #0A0A0A; color: #F0F0F0; font-family: 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace;
         display: flex; align-items: center; justify-content: center; text-align: center; padding: 24px; box-sizing: border-box; }
  .wrap { max-width: 320px; }
  .mark { font-weight: 700; letter-spacing: 0.2em; font-size: 14px; color: #F0F0F0; margin-bottom: 28px; }
  .ring { width: 56px; height: 56px; margin: 0 auto 22px; border-radius: 50%;
          border: 3px solid #1E1E1E; border-top-color: #FF00E5; border-right-color: #00D4FF; border-bottom-color: #FFE500;
          animation: spin 1s linear infinite; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { font-size: 13px; color: #999; margin: 0; line-height: 1.5; }
  .late { margin-top: 26px; font-size: 12px; opacity: 0; transition: opacity .3s; }
  .late.show { opacity: 1; }
  a { color: #00D4FF; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .ring { animation: none; border-top-color: #FF00E5; } }
</style></head>
<body><div class="wrap">
  <div class="mark">ATNX</div>
  <div class="ring" aria-hidden="true"></div>
  <h1>Capturing…</h1>
  <p>Working out what this is and finding its market.</p>
  <p class="late" id="late">Taking longer than usual. <a href="/app">Open Markets</a> and check back.</p>
</div>
<script>
  (function () {
    function go(url) { location.replace(url); }
    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'share-result' && typeof e.data.url === 'string') go(e.data.url);
      });
      var ask = function () {
        if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'share-ready' });
      };
      ask();
      navigator.serviceWorker.ready.then(ask);
    }
    setTimeout(function () { document.getElementById('late').className = 'late show'; }, 45000);
  })();
</script>
</body></html>`;
}
