# ATNX — Attention Exchange

Capture anything on your screen, identify it with AI, and track trending content.

ATNX is a Chrome extension + web dashboard that lets you select any area of a webpage, sends it to Claude's vision API for analysis, and displays structured results (type, name, category, sentiment, virality signals, and more) on a live dashboard.

## How It Works

```
Ctrl+Shift+X → Drag to select → AI analyzes screenshot → Results on dashboard
```

1. Press **Ctrl+Shift+X** (or Cmd+Shift+X on Mac) on any webpage
2. Drag a rectangle around the content you want to capture
3. The extension screenshots and crops the selected area
4. The cropped image is sent to Claude (Anthropic's AI) for vision analysis
5. Structured data (content type, name, category, sentiment, metrics, etc.) appears on the web dashboard

## Project Structure

```
atnx/
├── atnx-extension/       # Chrome Extension (Manifest V3)
│   ├── manifest.json      # Extension config & permissions
│   ├── background.js      # Service worker — capture, crop, AI call, POST to web app
│   ├── content.js         # Selection overlay + toast notifications
│   ├── content.css        # Overlay & toast styling
│   ├── offscreen.html/js  # Canvas-based image cropping (MV3 workaround)
│   ├── popup.html/js/css  # Extension popup UI (API key, capture button, status)
│   └── icons/             # Extension icons
│
└── atnx-web/             # Next.js Web App
    ├── app/
    │   ├── page.tsx       # Dashboard — lists all captures as cards
    │   ├── layout.tsx     # Root layout with ATNX branding
    │   ├── globals.css    # Tailwind + ATNX theme colors
    │   └── api/captures/
    │       └── route.ts   # POST: receive captures, GET: return all captures
    └── lib/
        └── store.ts       # In-memory capture store (MVP)
```

## Setup

### 1. Web App

```bash
cd atnx-web
npm install
npm run dev
```

The dashboard runs at [http://localhost:3000](http://localhost:3000).

### 2. Chrome Extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer Mode** (toggle in top right)
3. Click **Load unpacked** and select the `atnx-extension` folder
4. Click the ATNX extension icon in the toolbar
5. Enter your **Anthropic API key** and click Save
6. Navigate to any webpage and press **Ctrl+Shift+X** to test

### 3. Keyboard Shortcut

The default shortcut is `Ctrl+Shift+X` (Windows/Linux) or `Cmd+Shift+X` (Mac). If it conflicts with another extension, you can change it at `chrome://extensions/shortcuts`.

## Usage

1. Make sure the web app is running (`npm run dev` in `atnx-web/`)
2. Go to any webpage with content you want to capture
3. Press **Ctrl+Shift+X** — a crosshair overlay appears
4. Click and drag to select an area (minimum 20x20 pixels)
5. Release the mouse — you'll see toast notifications showing progress:
   - **CAPTURED** — Screenshot taken and being processed
   - **ANALYZING** — AI is identifying the content
   - **DONE** — Analysis complete with the identified name
6. Open the dashboard at [http://localhost:3000](http://localhost:3000) to see results

You can also trigger a capture from the extension popup by clicking the **CAPTURE** button.

## AI Analysis Output

Each capture produces structured JSON with:

| Field | Description |
|-------|-------------|
| `type` | meme, trend, person, brand, event, or other |
| `name` | Primary name/identifier of the subject |
| `description` | Brief 1-2 sentence description |
| `category` | crypto, politics, entertainment, tech, sports, culture, etc. |
| `platforms_detected` | Social platforms visible in the screenshot |
| `metrics_detected` | Any visible numbers (views, likes, followers, etc.) |
| `sentiment` | positive, negative, neutral, or mixed |
| `virality_signals` | Assessment of virality indicators |
| `raw_text` | Readable text extracted from the image |

## Tech Stack

- **Chrome Extension**: Manifest V3, vanilla JavaScript
- **Web App**: Next.js 14+ (App Router)
- **AI**: Anthropic Claude API (claude-sonnet-4-20250514) with vision
- **Styling**: Tailwind CSS with custom ATNX theme
- **Storage**: In-memory (web app), chrome.storage.local (extension)

## Notes

- The API key is stored in `chrome.storage.local`. For production, API calls should go through a backend server.
- The web app uses an in-memory store — captures are lost on server restart. A database would be needed for persistence.
- The extension POSTs results to `http://localhost:3000/api/captures`. Update `WEB_APP_URL` in `background.js` if your web app runs elsewhere.
- Each capture = 1 Claude API call. The dashboard polls for new captures every 5 seconds.
