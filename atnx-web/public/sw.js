// ATNX service worker. Minimal shell so the app is installable as a PWA.
// Strategy: network-first for navigation, pass-through for everything else.
// We intentionally do NOT cache API responses — market data must stay live.
//
// One exception to pass-through: the Android share target. Sharing a
// screenshot POSTs the original file to /share, and a phone screenshot as
// PNG is often 3 to 8 MB, over the 4.5 MB body limit on Vercel, which
// answers with an error page before the route runs. The worker rewrites
// that POST with the image shrunk to 1080 px on the long edge as a JPEG,
// the same cap the web form and the extension apply before upload.

const SHELL_CACHE = 'atnx-shell-v2';
const SHELL_URLS = ['/app', '/offline'];

const SHARE_PATH = '/share';
const MAX_EDGE = 1080;
const JPEG_QUALITY = 0.85;
// Under this size the file goes as-is when it cannot be decoded here; the
// server-side model gets to try. Above it there is nothing to send.
const MAX_RAW_BYTES = 4 * 1024 * 1024;

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
        Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.method === 'POST' && url.pathname === SHARE_PATH) {
    event.respondWith(handleShare(req));
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

// The share sheet's POST is a navigation, so its redirect mode is 'manual'
// and the response handed back must not be one the worker followed. Every
// fetch here uses redirect: 'manual'; the resulting opaqueredirect response
// makes the browser itself follow the 303 to the market.
async function handleShare(req) {
  let form;
  try {
    form = await req.clone().formData();
  } catch (err) {
    console.warn('[sw] share body unreadable, passing through', err);
    return fetch(req);
  }

  const file = form.get('image');
  if (!(file instanceof File) || file.size === 0) return fetch(req);

  let upload = null;
  try {
    upload = await shrink(file);
  } catch (err) {
    console.warn('[sw] share image could not be decoded', err);
  }

  if (!upload) {
    if (file.size <= MAX_RAW_BYTES) return fetch(req);
    // Too large to send and undecodable: land on the Create form with the
    // reason rather than on a hosting error page.
    const target = new URL('/app/submit', self.location.origin);
    target.searchParams.set(
      'notice',
      'That screenshot could not be read and is too large to send as-is. Take a fresh screenshot and add it here.'
    );
    return Response.redirect(target.toString(), 303);
  }

  const out = new FormData();
  for (const [key, value] of form.entries()) {
    if (key !== 'image') out.append(key, value);
  }
  out.append('image', upload, 'share.jpg');

  console.log('[sw] share image shrunk', { from: file.size, to: upload.size, type: file.type });
  try {
    return await fetch(new URL(SHARE_PATH, self.location.origin).toString(), {
      method: 'POST',
      body: out,
      credentials: 'same-origin',
      redirect: 'manual',
    });
  } catch (err) {
    console.warn('[sw] shrunk share upload failed, passing through', err);
    return fetch(req);
  }
}

async function shrink(file) {
  const probe = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(probe.width, probe.height));
  const w = Math.max(1, Math.round(probe.width * scale));
  const h = Math.max(1, Math.round(probe.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    probe.close();
    throw new Error('Canvas unavailable');
  }
  ctx.drawImage(probe, 0, 0, w, h);
  probe.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
}
