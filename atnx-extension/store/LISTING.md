# Chrome Web Store listing — ATNX Capture

Everything below is ready to paste into the Developer Dashboard. Build the
upload with `node package.mjs` (writes `dist/atnx-capture-v<version>.zip`).

## Submission checklist

1. Developer account: https://chrome.google.com/webstore/devconsole (one-time
   $5 registration). Verify the publisher email; it is shown on the listing.
2. **Deploy the web app first.** The privacy policy lives at
   https://atnx.app/privacy and the reviewer will open it.
3. `node package.mjs` → upload `dist/atnx-capture-v1.7.0.zip`.
4. Store listing tab: paste the text below; upload `store/screenshot-*.png`
   (1280×800) and `store/promo-small.png` (440×280).
5. Privacy tab: single purpose, permission justifications, data disclosures,
   and the privacy policy URL — all below.
6. Distribution: Public, all regions. Submit for review. Typical turnaround is
   one to three business days; the listing goes live automatically on approval
   unless you tick "publish manually".

Bump `version` in `manifest.json` for every later upload; the store rejects a
zip whose version is not higher than the published one.

## Store listing

**Name**
ATNX Capture

**Summary** (132 chars max)
Capture any part of a page, let AI identify it, and trade its Virality Index on ATNX.

**Category**
Productivity › Tools (alternatively Social & Communication)

**Language**
English

**Detailed description**

See something blowing up? Capture it.

ATNX Capture turns any piece of the web into a market. Press Ctrl+Shift+X
(⌘+Shift+X on Mac), drag a box around a post, a meme, a product, a headline —
anything — and ATNX identifies what it is, scores its Virality Index (VI), and
opens a market you can go long or short on with simulated funds.

WHAT YOU GET

• One-shortcut capture on any page. Drag to select; the crop is uploaded, not
  the whole screen.
• AI identification. Claude vision names the subject, reads the visible
  metrics, and files it under the right market.
• A side panel that stays out of the way: your portfolio value with a 7-day
  chart, open positions, and the five hottest markets right now, ranked by VI.
• Trade without leaving the page: open a long or short on any of the top
  five from the panel, and close a position from the portfolio list.
• Deep links back into atnx.app for every market and position.

HOW IT WORKS

1. Sign in at atnx.app (Google).
2. Click the ATNX icon to open the side panel, or just press the shortcut on
   any page.
3. Drag a selection. A toast tells you what was identified.
4. Trade it, or watch its VI move as more people capture it.

PRIVACY

The extension only sends the region you select, plus the page URL and title,
to atnx.app. It does not run on pages in the background, does not read your
browsing history, and asks for access to atnx.app only. Full policy:
https://atnx.app/privacy

Trading on ATNX is simulated. No real money is involved.

**Official URL / Homepage**
https://atnx.app

**Support URL**
https://atnx.app (or a mailto: for support@atnx.app)

## Privacy tab

**Single purpose description**

Lets the user capture a selected region of the current page and send it to
their ATNX account, where it is identified and turned into a tradable
attention market. The side panel shows that account's portfolio and the
current top markets, and lets the user open or close a simulated position
on them.

**Permission justifications**

| Permission | Justification |
| --- | --- |
| `activeTab` | Granted per tab when the user presses the shortcut or clicks the toolbar icon. Needed to take the screenshot (`tabs.captureVisibleTab`) and to inject the selection overlay into that one tab. |
| `scripting` | Injects the drag-to-select overlay (`content.js`) into the active tab on demand. The extension declares no content scripts that run automatically. |
| `storage` | Stores the user's web app URL, the side panel's expanded/collapsed state, and the last capture status. No browsing data is stored. |
| `sidePanel` | The extension's UI is a side panel (portfolio, top markets, capture button) rather than a popup. |
| Host permission `https://*.atnx.app/*` | The extension posts the captured image to www.atnx.app, reads the user's portfolio and the market list from it, and sends the user's own open and close orders to it. Host access lets the user's atnx.app sign-in cookie accompany those requests even when third-party cookies are blocked. The pattern covers the apex domain and the www host the site serves from; no other subdomains exist. |
| Optional host permissions `http://*/*`, `https://*/*` | Only used if the user enters a self-hosted or local ATNX instance URL in settings. At that moment the extension requests access to that single origin (for example `http://localhost:3000/*`) via `permissions.request`; it never requests access to all sites. |

**Remote code**
No. All code ships in the package. The extension makes network requests to
the user's ATNX instance for data only.

**Data usage disclosures** (tick these)

- [x] **User activity** — no. (Clicks and browsing are not collected.)
- [x] **Website content** — yes: the screenshot region the user selects, and
  the page URL and title, sent to atnx.app for identification and stored with
  the user's account.
- [x] **Authentication information** — yes: the atnx.app session cookie is
  sent with requests so captures are attributed to the signed-in user. The
  extension never handles passwords.
- [ ] Personally identifiable information — no (the account itself lives at
  atnx.app; the extension only carries the session cookie).
- [ ] Health, financial, location, personal communications — no.

Certifications:
- [x] I do not sell or transfer user data to third parties, outside of the
  approved use cases.
- [x] I do not use or transfer user data for purposes unrelated to the item's
  single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for
  lending purposes.

**Privacy policy URL**
https://atnx.app/privacy

## Assets in this folder

| File | Size | Use |
| --- | --- | --- |
| `screenshot-1-capture.png` | 1280×800 | Capture in progress on a page, panel alongside |
| `screenshot-2-identified.png` | 1280×800 | Identification toast, portfolio expanded |
| `screenshot-3-markets.png` | 1280×800 | Portfolio chart tooltip and top markets |
| `promo-small.png` | 440×280 | Small promo tile (required) |

Regenerate with `node ../../scripts/store-assets.mjs` from a checkout that has
Playwright available (see README).
