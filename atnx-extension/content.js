// Injected on demand by background.js (activeTab + chrome.scripting), not
// declared in the manifest, so it only ever runs on pages the user captures.
// The guard makes re-injection a no-op.
(() => {
  if (globalThis.__atnxCapture) return;
  globalThis.__atnxCapture = true;

  const MIN_SELECTION = 20;

  // Everything lives inside a closed shadow root, so page CSS can't touch it
  // and none of these rules need `!important`. The host element is promoted
  // to the browser's top layer via the Popover API, which beats any z-index
  // the page can set.
  const STYLES = `
    :host {
      all: initial;
      display: block;
      position: fixed;
      inset: 0;
      width: auto;
      height: auto;
      margin: 0;
      padding: 0;
      border: 0;
      background: transparent;
      overflow: visible;
      pointer-events: none;
      z-index: 2147483647;
      color-scheme: dark;
      font-family: ui-monospace, 'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace;
    }
    /* \`all: initial\` above also wipes the UA rules that hide a closed
       popover and a [hidden] element, so restate the one we rely on. */
    :host([hidden]) { display: none; }
    .overlay {
      position: absolute;
      inset: 0;
      pointer-events: auto;
      cursor: crosshair;
      background: rgba(0, 0, 0, 0.15);
      touch-action: none;
      user-select: none;
    }
    .selection {
      position: absolute;
      border: 2px solid #FF00E5;
      background: rgba(255, 0, 229, 0.08);
      box-shadow: 0 0 20px rgba(255, 0, 229, 0.2), inset 0 0 20px rgba(255, 0, 229, 0.05);
      box-sizing: border-box;
    }
    .selection[hidden] { display: none; }
    .selection::before,
    .selection::after {
      content: '';
      position: absolute;
      width: 12px;
      height: 12px;
      border-color: #FF00E5;
      border-style: solid;
    }
    .selection::before { top: -2px; left: -2px; border-width: 2px 0 0 2px; }
    .selection::after { bottom: -2px; right: -2px; border-width: 0 2px 2px 0; }
    .tooltip {
      position: absolute;
      background: #0A0A0A;
      color: #FF00E5;
      border: 1px solid #FF00E5;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 12px;
      line-height: 1.4;
      white-space: nowrap;
      box-shadow: 0 0 10px rgba(255, 0, 229, 0.2);
    }
    .tooltip[hidden] { display: none; }
    .toast {
      position: absolute;
      bottom: 24px;
      right: 24px;
      max-width: min(360px, calc(100vw - 48px));
      background: #141414;
      border: 1px solid #00D4FF;
      color: #F0F0F0;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.4;
      display: flex;
      align-items: center;
      gap: 10px;
      box-shadow: 0 4px 20px rgba(0, 212, 255, 0.15);
      opacity: 0;
      transform: translateY(12px);
      transition: opacity 0.3s ease, transform 0.3s ease;
    }
    .toast.visible { opacity: 1; transform: translateY(0); }
    .toast.error { border-color: #FF00E5; box-shadow: 0 4px 20px rgba(255, 0, 229, 0.15); }
    .toast.error .title { color: #FF00E5; }
    .toast .icon { font-size: 18px; line-height: 1; flex-shrink: 0; }
    .toast .text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .toast .title { color: #00D4FF; font-weight: 700; font-size: 13px; letter-spacing: 0.5px; }
    .toast .subtitle { color: #999999; font-size: 11px; overflow-wrap: anywhere; }
    .toast .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid #2A2A2A;
      border-top-color: #00D4FF;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      flex-shrink: 0;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .toast { transition: none; }
      .toast .spinner { animation-duration: 2s; }
    }
  `;

  let host = null;
  let root = null;

  function getRoot() {
    if (root) return root;
    host = document.createElement('div');
    host.setAttribute('data-atnx-capture', '');
    host.setAttribute('popover', 'manual');
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLES;
    root.appendChild(style);
    // documentElement, not body: unaffected by body transforms, and present
    // even before/without a <body>.
    document.documentElement.appendChild(host);
    return root;
  }

  function isPopoverOpen() {
    return host.hasAttribute('popover') && host.matches(':popover-open');
  }

  function showHost() {
    getRoot();
    host.hidden = false;
    if (!host.hasAttribute('popover') || isPopoverOpen()) return;
    try {
      host.showPopover();
    } catch {
      // Popover unsupported or the page is in a state that refuses it.
      // Fall back to a plain fixed element; :host already sets z-index.
      host.removeAttribute('popover');
    }
  }

  function hideHost() {
    if (!host) return;
    if (isPopoverOpen()) {
      try { host.hidePopover(); } catch { /* already hidden */ }
    }
    host.hidden = true;
  }

  // Show the host while anything is on screen, hide it otherwise so an idle
  // page is left exactly as we found it.
  function syncHost() {
    if (!host) return;
    if (overlay || toast) showHost();
    else hideHost();
  }

  // --- Selection overlay ---

  let overlay = null;
  let selectionBox = null;
  let tooltip = null;
  let dragging = false;
  let startX = 0;
  let startY = 0;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'activate-capture') activateSelection();
    if (msg.action === 'capture-status') handleStatusUpdate(msg.status, msg.detail);
  });

  function activateSelection() {
    if (overlay) return; // Already active
    const shadow = getRoot();
    dragging = false;

    overlay = document.createElement('div');
    overlay.className = 'overlay';

    selectionBox = document.createElement('div');
    selectionBox.className = 'selection';
    selectionBox.hidden = true;

    tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    tooltip.textContent = 'Drag to select area';
    tooltip.hidden = true; // positioned on first pointer move

    overlay.append(selectionBox, tooltip);
    shadow.appendChild(overlay);

    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    overlay.addEventListener('pointercancel', cancelSelection);
    overlay.addEventListener('contextmenu', preventDefault);
    window.addEventListener('keydown', onKeyDown, true);
    syncHost();
  }

  function preventDefault(e) {
    e.preventDefault();
  }

  function rectFrom(x, y) {
    return {
      x: Math.min(startX, x),
      y: Math.min(startY, y),
      width: Math.abs(x - startX),
      height: Math.abs(y - startY)
    };
  }

  function placeTooltip(x, y) {
    tooltip.hidden = false;
    const pad = 15;
    const w = tooltip.offsetWidth;
    const h = tooltip.offsetHeight;
    const left = x + pad + w > window.innerWidth ? x - pad - w : x + pad;
    const top = y + pad + h > window.innerHeight ? y - pad - h : y + pad;
    tooltip.style.left = `${Math.max(0, left)}px`;
    tooltip.style.top = `${Math.max(0, top)}px`;
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    // Keep receiving moves even if the pointer leaves the window mid-drag.
    overlay.setPointerCapture(e.pointerId);
    Object.assign(selectionBox.style, {
      left: `${startX}px`,
      top: `${startY}px`,
      width: '0px',
      height: '0px'
    });
    selectionBox.hidden = false;
  }

  function onPointerMove(e) {
    e.preventDefault();
    e.stopPropagation();
    placeTooltip(e.clientX, e.clientY);
    if (!dragging) return;

    const r = rectFrom(e.clientX, e.clientY);
    Object.assign(selectionBox.style, {
      left: `${r.x}px`,
      top: `${r.y}px`,
      width: `${r.width}px`,
      height: `${r.height}px`
    });
    tooltip.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
  }

  function onPointerUp(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!dragging) return;
    dragging = false;

    // Clamp the end point to the viewport: pointer capture lets coordinates
    // go negative or past the edge, but the screenshot only covers the
    // viewport. The start point came from a pointerdown on the overlay, so
    // it is already inside.
    const r = rectFrom(
      Math.min(Math.max(0, e.clientX), window.innerWidth),
      Math.min(Math.max(0, e.clientY), window.innerHeight)
    );

    cleanup();
    if (r.width < MIN_SELECTION || r.height < MIN_SELECTION) return;
    sendSelection(r);
  }

  function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cancelSelection();
  }

  function cancelSelection() {
    dragging = false;
    cleanup();
  }

  function cleanup() {
    if (overlay) {
      overlay.remove();
      overlay = null;
      selectionBox = null;
      tooltip = null;
    }
    window.removeEventListener('keydown', onKeyDown, true);
    syncHost();
  }

  // Wait two frames so the overlay is gone from the compositor before the
  // background takes the screenshot.
  function afterPaint() {
    return new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
  }

  async function sendSelection(rect) {
    await afterPaint();
    chrome.runtime.sendMessage({
      action: 'capture-region',
      rect: { ...rect, devicePixelRatio: window.devicePixelRatio || 1 },
      pageUrl: window.location.href,
      pageTitle: document.title
    });
  }

  // --- Toast notifications ---

  let toast = null;
  let toastTimer = null;

  function showToast({ title, subtitle, icon, spinner, isError, duration }) {
    dismissToast(true);
    const shadow = getRoot();

    toast = document.createElement('div');
    toast.className = 'toast' + (isError ? ' error' : '');
    toast.setAttribute('role', 'status');

    if (spinner) {
      const el = document.createElement('div');
      el.className = 'spinner';
      toast.appendChild(el);
    } else if (icon) {
      const el = document.createElement('span');
      el.className = 'icon';
      el.textContent = icon;
      toast.appendChild(el);
    }

    const text = document.createElement('div');
    text.className = 'text';
    const titleEl = document.createElement('div');
    titleEl.className = 'title';
    titleEl.textContent = title;
    text.appendChild(titleEl);
    if (subtitle) {
      const sub = document.createElement('div');
      sub.className = 'subtitle';
      sub.textContent = subtitle;
      text.appendChild(sub);
    }
    toast.appendChild(text);

    const el = toast;
    shadow.appendChild(el);
    syncHost();
    requestAnimationFrame(() => el.classList.add('visible'));

    if (duration) toastTimer = setTimeout(() => dismissToast(), duration);
  }

  function dismissToast(immediate = false) {
    clearTimeout(toastTimer);
    toastTimer = null;
    if (!toast) return;
    const el = toast;
    toast = null;
    if (immediate) {
      el.remove();
      syncHost();
      return;
    }
    el.classList.remove('visible');
    setTimeout(() => {
      el.remove();
      syncHost();
    }, 300);
  }

  // A busy toast only ever goes away when the worker sends the next status.
  // If the worker is torn down mid-capture that message never comes, so the
  // busy toasts fall back to an error on their own (the upload itself gives
  // up at 75 s).
  const BUSY_TOAST_MS = 100_000;
  let busyToastTimer = null;

  function handleStatusUpdate(status, detail) {
    clearTimeout(busyToastTimer);
    busyToastTimer = null;
    switch (status) {
      case 'capturing':
      case 'analyzing':
        showToast(
          status === 'capturing'
            ? { title: 'CAPTURED', subtitle: 'Processing screenshot...', spinner: true }
            : { title: 'ANALYZING', subtitle: 'AI is identifying the content...', spinner: true }
        );
        busyToastTimer = setTimeout(
          () => handleStatusUpdate('error', 'Analysis timed out — try again'),
          BUSY_TOAST_MS
        );
        break;
      case 'review':
        showToast({
          title: 'REVIEW',
          subtitle: detail || 'Check it in the side panel before it lands',
          icon: '?',
          duration: 5000
        });
        break;
      case 'done':
        showToast({
          title: 'DONE',
          subtitle: detail || 'Analysis complete — check the dashboard',
          icon: '✓',
          duration: 4000
        });
        break;
      case 'error':
        showToast({
          title: 'ERROR',
          subtitle: detail || 'Something went wrong',
          icon: '✗',
          isError: true,
          duration: 5000
        });
        break;
    }
  }
})();
