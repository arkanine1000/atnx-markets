chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'crop-image') {
    cropImage(msg.dataUrl, msg.rect).then(sendResponse);
    return true; // Keep message channel open for async response
  }
});

async function cropImage(dataUrl, rect) {
  const img = new Image();

  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = dataUrl;
  });

  const dpr = rect.devicePixelRatio || 1;

  const canvas = document.createElement('canvas');
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(
    img,
    rect.x * dpr,
    rect.y * dpr,
    rect.width * dpr,
    rect.height * dpr,
    0,
    0,
    rect.width * dpr,
    rect.height * dpr
  );

  // Return base64 without the data:image/png;base64, prefix
  const croppedDataUrl = canvas.toDataURL('image/png');
  const base64 = croppedDataUrl.replace(/^data:image\/png;base64,/, '');
  return { base64 };
}
