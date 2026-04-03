const WEB_APP_URL = 'http://localhost:3000';

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

async function handleCapture(msg, tab) {
  try {
    updateStatus('capturing');

    // 1. Capture visible tab
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });

    // 2. Crop to selection using offscreen document
    const croppedBase64 = await cropImageOffscreen(dataUrl, msg.rect);

    updateStatus('analyzing');

    // 3. Send to AI
    const analysis = await analyzeWithAI(croppedBase64, msg.pageUrl, msg.pageTitle);

    // 4. Build result
    const result = {
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      screenshot: croppedBase64,
      pageUrl: msg.pageUrl,
      pageTitle: msg.pageTitle,
      analysis: analysis
    };

    // 5. Store in chrome.storage.local
    const { captures = [] } = await chrome.storage.local.get('captures');
    captures.unshift(result);
    // Keep only last 50 captures to avoid storage limits
    const trimmed = captures.slice(0, 50);
    await chrome.storage.local.set({
      captures: trimmed,
      captureCount: trimmed.length
    });

    // 6. POST to web app
    try {
      await fetch(`${WEB_APP_URL}/api/captures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result)
      });
    } catch (e) {
      console.warn('Could not send to web app:', e.message);
    }

    updateStatus('done');
    setTimeout(() => updateStatus('ready'), 3000);
  } catch (err) {
    console.error('Capture error:', err);
    updateStatus('error');
    setTimeout(() => updateStatus('ready'), 5000);
  }
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

async function analyzeWithAI(base64Image, pageUrl, pageTitle) {
  const { apiKey } = await chrome.storage.local.get('apiKey');

  if (!apiKey) {
    return { error: 'No API key configured. Open the extension popup to set your Anthropic API key.' };
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: base64Image
            }
          },
          {
            type: 'text',
            text: `Analyze this screenshot captured from ${pageUrl} (${pageTitle}).

Identify the main subject/content and extract the following information. Respond ONLY in valid JSON with these fields:

{
  "type": "meme" | "trend" | "person" | "brand" | "event" | "other",
  "name": "The primary name/identifier of the subject",
  "description": "Brief 1-2 sentence description of what this is",
  "category": "e.g. crypto, politics, entertainment, tech, sports, culture",
  "platforms_detected": ["list of any social platforms visible in the screenshot"],
  "metrics_detected": {
    "any visible numbers like views, likes, followers, subscribers etc"
  },
  "sentiment": "positive" | "negative" | "neutral" | "mixed",
  "virality_signals": "Brief assessment of any virality indicators visible",
  "raw_text": "Any readable text extracted from the image"
}`
          }
        ]
      }]
    })
  });

  const data = await response.json();

  if (data.error) {
    return { error: data.error.message || 'API error', raw_response: JSON.stringify(data.error) };
  }

  const textContent = data.content.find(c => c.type === 'text')?.text;
  try {
    return JSON.parse(textContent.replace(/```json|```/g, '').trim());
  } catch {
    return { raw_response: textContent, parse_error: true };
  }
}

function updateStatus(status) {
  chrome.storage.local.set({ captureStatus: status });
}
