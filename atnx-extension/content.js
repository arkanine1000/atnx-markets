let isSelecting = false;
let startX, startY;
let overlay, selectionBox, tooltip;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'activate-capture') {
    activateSelection();
  }
});

function activateSelection() {
  if (overlay) return; // Already active

  isSelecting = false;

  // Create overlay
  overlay = document.createElement('div');
  overlay.className = 'atnx-overlay';

  // Create selection box
  selectionBox = document.createElement('div');
  selectionBox.className = 'atnx-selection';
  selectionBox.style.display = 'none';

  // Create tooltip
  tooltip = document.createElement('div');
  tooltip.className = 'atnx-tooltip';
  tooltip.textContent = 'Drag to select area';

  document.body.appendChild(overlay);
  document.body.appendChild(selectionBox);
  document.body.appendChild(tooltip);

  overlay.addEventListener('mousedown', onMouseDown);
  overlay.addEventListener('mousemove', onMouseMove);
  overlay.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keydown', onKeyDown);
}

function onMouseDown(e) {
  e.preventDefault();
  e.stopPropagation();
  isSelecting = true;
  startX = e.clientX;
  startY = e.clientY;
  selectionBox.style.left = startX + 'px';
  selectionBox.style.top = startY + 'px';
  selectionBox.style.width = '0px';
  selectionBox.style.height = '0px';
  selectionBox.style.display = 'block';
}

function onMouseMove(e) {
  e.preventDefault();
  e.stopPropagation();

  // Update tooltip position
  tooltip.style.left = (e.clientX + 15) + 'px';
  tooltip.style.top = (e.clientY + 15) + 'px';

  if (!isSelecting) return;

  const currentX = e.clientX;
  const currentY = e.clientY;

  const x = Math.min(startX, currentX);
  const y = Math.min(startY, currentY);
  const width = Math.abs(currentX - startX);
  const height = Math.abs(currentY - startY);

  selectionBox.style.left = x + 'px';
  selectionBox.style.top = y + 'px';
  selectionBox.style.width = width + 'px';
  selectionBox.style.height = height + 'px';

  tooltip.textContent = `${width} × ${height}`;
}

function onMouseUp(e) {
  e.preventDefault();
  e.stopPropagation();

  if (!isSelecting) return;
  isSelecting = false;

  const endX = e.clientX;
  const endY = e.clientY;

  const x = Math.min(startX, endX);
  const y = Math.min(startY, endY);
  const width = Math.abs(endX - startX);
  const height = Math.abs(endY - startY);

  cleanup();

  // Minimum selection size check
  if (width < 20 || height < 20) return;

  sendSelection({ x, y, width, height });
}

function onKeyDown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    isSelecting = false;
    cleanup();
  }
}

function cleanup() {
  if (overlay) {
    overlay.removeEventListener('mousedown', onMouseDown);
    overlay.removeEventListener('mousemove', onMouseMove);
    overlay.removeEventListener('mouseup', onMouseUp);
    overlay.remove();
    overlay = null;
  }
  if (selectionBox) {
    selectionBox.remove();
    selectionBox = null;
  }
  if (tooltip) {
    tooltip.remove();
    tooltip = null;
  }
  document.removeEventListener('keydown', onKeyDown);
}

function sendSelection(rect) {
  chrome.runtime.sendMessage({
    action: 'capture-region',
    rect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      devicePixelRatio: window.devicePixelRatio || 1
    },
    pageUrl: window.location.href,
    pageTitle: document.title
  });
}
