# ATNX — Attention Exchange

**Live at [atnx.app](https://atnx.app).**

A Chrome extension + Next.js web app for capturing any content on the internet, identifying it with a vision model, and trading a simulated Virality Index (VI) on what you capture. Your friends' screenshots become markets; markets have a live VI; you can go long or short.

```
Ctrl+Shift+X → drag a selection → the model identifies it → linked to a market, or a market spawns
                → VI updates every 5 min → trade long / short on it
```

Three ways in, one pipeline: the extension, the web form at `/app/submit` (screenshot, link, or text), and the Android share sheet.

---

## Repo layout

```
atnx/
├── atnx-extension/     Chrome extension (Manifest V3, vanilla JS)
└── atnx-web/           Next.js 16 app (App Router + Server Actions)
```

---

## Architecture at a glance

```
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │  extension   │  │ /app/submit  │  │ Android share│
   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
          │ POST /api/captures (Supabase cookie)│ POST /share
          ▼                 ▼                  ▼
   ┌───────────────────────────────────────────────────┐    ┌──────────────────────┐
   │  Next.js @ atnx.app        lib/capture.ts         │───▶│ Supabase (Postgres + │
   │  hash → retrieve → model → link check → route     │    │ pgvector, Auth,      │
   └───────────────┬───────────────────────────────────┘    │ Storage, RLS)        │
                   │                                        └──────────────────────┘
                   │ Vercel AI Gateway: Gemini Flash (vision), Cohere Embed v4 (text)
                   │
                   │ composeVi = weighted level+momentum, 4 sources
                   ▼
   Google Trends · Bluesky · GDELT · Wikipedia
                   ▲
                   │ /api/markets/refresh every 5 min (Vercel Cron)
```

How a submission is decided, stage by stage, is in [`atnx-web/README.md`](atnx-web/README.md).

---

## Web app (`atnx-web/`)

### Routes

| Path | Guest? | What it does |
| --- | --- | --- |
| `/` | ✅ | Landing splash with "Launch App" |
| `/app` | ✅ | Dashboard — every market as a card, sorted by VI / newest / category, refreshes every 30s |
| `/app/markets/[id]` | ✅ | Market detail — hero card, 7-day VI sparkline, evidence strip of all captures, Trade button |
| `/app/submit` | ❌ | Web entry: drop or paste a screenshot, or give a link or a line of text; shows which market it landed on |
| `/app/portfolio` | ❌ | Open + closed positions, realized PnL, sim balance. On phones it is laid out like the extension's side panel: a value tile with a range sparkline from `/api/portfolio`, then a collapsible Balance / Unrealized / Open card whose rows expand to close a position |
| `/app/share/resume` | ❌ | Second half of a share that arrived signed out: the service worker parks the capture in the Cache API and sends the window here; after sign-in the page replays it through `/share` |
| `/app/settings` | ❌ | Profile management (handle, email) |
| `/admin` | admins only | Moderation: markets, captures in review (low-confidence creates), audit log |
| `/share` | ❌ | Android share-target POST (image, link, or text) → same pipeline → redirect to the market with `?shared=<outcome>`, which the market page turns into a toast. The service worker (`public/sw.js`) takes the POST over: it answers at once with a "Capturing…" page, shrinks a screenshot to a 1080 px JPEG (raw phone screenshots exceed Vercel's 4.5 MB body limit), uploads with `Accept: application/json` to get the target path back, and moves the window there. A link whose site blocks previews (Facebook, Instagram, TikTok) is tried from its caption, and failing that lands on `/app/submit` prefilled so one screenshot finishes it |
| `/auth/callback` | — | OAuth return path; exchanges code → session, ensures `user_profiles` / `sim_balances` rows |

### API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/captures` | Ingest for the extension and the web form. Multipart with `image`, `url`, or `text`. Hash dedup → candidate retrieval → one model call → link check → route (matched / linked / created / rejected) → upload, record VI, write audit row. Rejections are 422 with a reason; X/TikTok/Instagram links that cannot be fetched return `needs_image` |
| `GET /api/captures` | Dashboard feed (grouped by market, latest first); also feeds the extension side panel's top markets |
| `GET /api/portfolio` | Extension side panel: handle, sim balance, realized/unrealized PnL, total value, open positions (with latest capture thumbnail), and a 7-day portfolio-value series rebuilt from each open position's `vi_history` (401 when signed out) |
| `GET /api/markets/refresh` | Cron-only, every 5 min; re-reads the fast VI sources (Google Trends, Bluesky) for every live market, combines them with the stored slow readings, appends an EMA-smoothed point to `vi_history` |
| `GET /api/markets/refresh-slow` | Cron-only, hourly; same for the slow sources (GDELT, Wikipedia) |

### Key libraries (`atnx-web/lib/`)

- **`capture.ts`** — The submission pipeline. `processCapture` hashes the input, retrieves candidates, calls the model, checks the proposal against existing markets, routes, persists, and schedules the low-confidence retry.
- **`vlm.ts`** — The one model call, through Vercel AI Gateway (Gemini Flash for images, Flash-Lite for text, thinking off). Output validated against a per-request zod schema: admit / reject reason, matched candidate id, or a new market with name, type, category (ten fixed values) and aliases.
- **`embed.ts`**, **`retrieve.ts`** — Cohere Embed v4 text embeddings (512 dims) and the two retrieval queries (cosine on `markets.embedding`, trigram on names and aliases).
- **`route.ts`** — Deterministic routing table on the model output and retrieval scores; writes `submission_decisions`.
- **`signals.ts`** — `scoreTerms(requests, cadence)` scores markets across four sources and combines them with `vi/score.ts`: each source gives an absolute level (0–1000) and a momentum ratio against the term's own baseline; the composite is the weighted level scaled by momentum (0.65x at a collapse, 1x steady, 1.35x at a 10x spike) over the sources that answered, times a presence multiplier (0.8 for one source up to 1.2 for all four). Sources live in `vi/trends.ts` (co-queried against a benchmark keyword so scores compare across markets), `vi/bluesky.ts`, `vi/gdelt.ts`, `vi/wikipedia.ts`. `npm run vi:probe "term"` prints the breakdown.
- **`trends.ts`** — Google Trends (7d interest), virality score = 0.35 × current + 0.30 × momentum + 0.20 × spike + 0.15 × consistency, all × 10. `normalizeSearchTerm` strips separators so titles like `Foo / Bar` don't tank queries.
- **`wikipedia.ts`** — OpenSearch → per-article-daily pageviews (30d, 2-day lag). Score = `log10(peak + 10) × 200 − 200`. User-Agent required by Wikimedia. 1h cache.
- **`store.ts`** — `createMarket` (unique normalised name; re-selects on conflict), `addCapture`, `recordVi`, `getCaptures`, `getMarketDetail`.
- **`og.ts`** — Fetches a link's preview image and title for URL submissions and the share target: YouTube thumbnails directly, TikTok via oEmbed or the page's hydration JSON, everything else from `og:image` with a browser user agent first and Facebook's crawler user agent second (Facebook, Instagram and Threads are tried crawler-first). Login walls and placeholder logos count as no image.
- **`trends-cache.ts`** — 5 min in-memory cache keyed by lowercased term.
- **`capture-view.ts`** — UI helpers (`timeAgo`, `sentimentColor`, `viChange24h` from the VI history).
- **`supabase/cookie-options.ts`** — Forces `SameSite=None; Secure` so the extension can attach the auth cookie on cross-origin fetches.

### React context + components

- **`AuthContext`** — `user`, `loading`, `openLoginModal`, `signInWithGoogle`. Subscribes to `onAuthStateChange` and auto-closes the modal when a session appears.
- **`DemoContext`** — `positions`, `balance`, `openPosition`, `closePosition`. Refreshes when auth state flips.
- **`LoginModal`** — Google-only right now. Backdrop-blurred. Escape-to-close.
- **`Nav`** — Logo + ATNX wordmark, UserMenu, theme toggle on the far right. From `sm` up Markets, Portfolio and Leaderboard sit in a pill in the header and Create is a pill beside the avatar with a magenta + and the word; on phones the tabs become a fixed bottom bar (Markets, the +, Leaderboard) and Portfolio moves into the UserMenu.
- **`PortfolioMobile`**, **`charts/PortfolioSparkline`** — The phone portfolio: value tile, range tabs, positions card, fed by `/api/portfolio`.
- **`Identicon`** — Generated avatar seeded by the account id: the ATNX eye, with an iris made of one ink under blocks of the other two in multiply blend, so overlaps print the secondaries; the gaze varies per account. Stands in for the handle in the header, on the leaderboard and on the settings page.
- **`ShareButton`** — Native share sheet on phones (`navigator.share`), clipboard elsewhere; on every market page.
- **`Trading/*`** — `TradeModal`, `ClosePositionModal`, `TrendSparkline` (entry marker), `DemoToast`, `getTrendIndicator`.
- **`ThemeToggle`** — `next-themes`, class-based dark/light.

---

## Auth flow

1. Anyone hits `/` → lands on splash → clicks **Launch App** → `/app`.
2. Guests can browse the dashboard and market detail pages. Trade buttons turn into **Login** buttons; `/app/portfolio` shows a login panel.
3. Clicking any Login opens the blurred modal → Google OAuth via `supabase.auth.signInWithOAuth`.
4. `/auth/callback` exchanges the code for a session, sets the auth cookie with `SameSite=None; Secure` (via `proxy.ts`), redirects back.
5. `proxy.ts` only protects `/admin` and `/app/settings`. Everything else is open for guests.
6. Because the cookie is `SameSite=None; Secure`, the Chrome extension's `fetch(..., { credentials: 'include' })` attaches it when posting captures — the server can attribute the capture to the signed-in user without a token exchange.

---

## VI (Virality Index) pipeline

VI is a composite 0-1000 score. Every source is independent, we take the max — a viral Wikipedia article shouldn't be dragged down because Google Trends is quiet for that term. Nothing read off the screenshot feeds the score, so resubmitting the same image cannot move it.

| Source | Fires when | Scoring |
| --- | --- | --- |
| Google Trends | `term.length > 1` | Weighted blend of current interest, momentum, spike, consistency |
| Wikipedia | `term.length > 1` | `log10(peak daily views + 10) × 200 − 200` |

Cron every 5 minutes re-runs `composeVi` for every live market in batches of 4. If all sources return 0 the market keeps its last known VI instead of being zeroed.

---

## Database (Supabase)

| Table | Purpose |
| --- | --- |
| `markets` | One row per identified entity. `entity_type`, `category`, `aliases`, `embedding vector(512)`, `current_vi`, `total_captures`, `vi_last_updated`, `deleted_at`. Unique on the normalised name among live rows. |
| `captures` | Screenshots + model analysis. FK to `markets`. `content_hash` (unique among live rows: exact dedup), `resolution_status` (`resolved` / `review`), `confidence_score`, `deleted_at`. |
| `submission_decisions` | Audit: one row per routed submission with outcome, market, candidates shown, similarity scores, model confidence, reject reason, latency and the full model response. Admin-readable. |
| `vi_history` | Append-only time series of `(market_id, vi, recorded_at)` powering the sparklines. |
| `user_profiles` | `id` (= auth.uid), `handle`, `email`, `role` (`user` / `moderator` / `admin`). |
| `sim_balances` | Per-user simulated USD balance, realized PnL, trade count. |
| `positions` | Open + closed trades: `direction`, `size_usd`, `entry_vi`, `exit_vi`, `realized_pnl`, `status`. |
| `moderation_log` | Admin audit trail. |

### RPCs (used via `supabase.rpc(...)`)

`match_markets_by_embedding`, `match_markets_by_name`, `is_admin`, `admin_soft_delete_market`, `admin_restore_market`, `admin_edit_market_name`, `admin_soft_delete_capture`, `admin_reassign_capture`. (`find_similar_market` still exists but is no longer called.)

Schema changes are numbered SQL files in `atnx-web/supabase/`, applied by hand in order; see that README for the list.

Storage: the `captures` bucket (public) holds capture images under `{user_id}/`; public URLs are stored on the capture row. Text-only submissions have no image.

---

## Chrome extension (`atnx-extension/`)

Manifest V3, vanilla JS, no build step. Three moving parts:

- **`background.js`** (service worker) — Owns the capture pipeline. On `Ctrl+Shift+X` or the side panel's Capture button it injects `content.js` on demand (`activeTab` + `scripting`), receives the selected rect, screenshots the tab, crops it in-worker with `createImageBitmap` + `OffscreenCanvas` (longest edge capped at 1080 px, JPEG at 0.85), then POSTs it as `multipart/form-data` to `${webAppUrl}/api/captures` with `credentials: 'include'`. Status is mirrored on the toolbar badge (`…` / `✓` / `!`).
- **`content.js`** — Drag-to-select overlay and toast notifications, rendered inside a closed Shadow DOM host that is promoted to the browser's top layer via the Popover API, so page CSS and z-index stacking can't interfere. Uses pointer events with pointer capture; Escape cancels. Only injected on pages the user captures.
- **`sidepanel.html` + `sidepanel.js`** — Clicking the toolbar icon opens a Chrome side panel (wallet-style, no popup). Top to bottom: the signed-in handle; Capture button (which reads CAPTURING… / ANALYZING… while the pipeline runs) with the shortcut beneath; a portfolio-value stat tile (hero number, 7-day delta, SVG sparkline with crosshair tooltip, keyboard-navigable) fed by `GET /api/portfolio`; a collapsible portfolio card (Balance / Unrealized / Open, expands to open positions as thumbnail · name · current value · PnL %, shorts marked with an `S` badge); and the top 5 markets by VI (`GET /api/captures`, grouped by market) as thumbnail · name · VI. Rows deep-link to `/app/markets/[id]`. Polls every 30 s while visible. The gear reveals settings: Web App URL (default `https://atnx.app`; override for local dev — saving a custom origin requests an optional host permission for it) and the current shortcut.

Permissions: `activeTab`, `scripting`, `storage`, `sidePanel`, host access to `https://atnx.app/*` only. Other origins are `optional_host_permissions`, granted from the panel when you save a custom URL. Host access to the web app keeps the Supabase auth cookie flowing even when third-party cookies are blocked.

`activeTab` is granted per tab by the hotkey or a toolbar click, so the panel's Capture button only works on the tab the panel was opened from; on another tab it explains to use the shortcut or click the icon again. Icons are the bare eye-and-beam glyph on a transparent background (16/32/48/128), regenerated from `atnx-web/public/app_icon.png`.

Defaults & config (`chrome.storage.local`):
- `webAppUrl` — default `https://atnx.app`, editable from the popup
- `captureStatus`, `captureStatusAt`, `captureCount` — UI feedback bookkeeping

Error copy surfaces the real issue: `401 → "Sign in at atnx.app first"`, `413 → "Selection too large to upload"`, network failure → `"Web app unreachable — check URL in popup"`.

---

## Local development

### Web app

```bash
cd atnx-web
npm install
cp .env.local.example .env.local   # fill in the Supabase / CRON values below
npm run dev                        # http://localhost:3000
```

Env vars:

| Name | Where | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client + server | Anon key for browser auth |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | Admin client, bypasses RLS |
| `AI_GATEWAY_API_KEY` | server only, local | Vercel AI Gateway. Not needed on Vercel itself (OIDC) |
| `CRON_SECRET` | server only | Bearer token Vercel sends to `/api/markets/refresh` and `/refresh-slow` |
| `CORS_ALLOWED_ORIGINS` | server only | Comma-separated extra origins allowed to call the cookie-authenticated API (the extension's `chrome-extension://<id>`); the app's own hosts are always allowed |
| `BLUESKY_IDENTIFIER` | server only | Bluesky handle for the post-search VI source (source is skipped when unset) |
| `BLUESKY_APP_PASSWORD` | server only | App password for that account |
| `VI_TRENDS_BENCHMARK` | server only | Optional; anchor keyword for Google Trends, default `sudoku` |

Optional overrides (model ids, link and confirm thresholds) and the `EVAL_*` variables for the eval script are listed in `atnx-web/.env.local.example`.

### Checking the pipeline

```bash
npm run eval:capture -- --cleanup   # 25 fixtures through the real route, then resubmits; needs a running dev server
```

### Seeding trending markets

A fresh database renders the empty state until someone captures something. To fill it with a curated set of currently-trending memes and moments:

```bash
npm run seed:trending              # creates ~10 markets (needs SUPABASE_SERVICE_ROLE_KEY in .env.local)
npm run seed:trending -- --dry-run # fetches the images and writes previews to .seed-preview/, touches nothing
npm run seed:trending -- --user <auth uuid>   # attribute the captures to a user instead of leaving user_id null
```

Each item becomes a `markets` row, one `captures` row (image is the source page's og:image, uploaded to the `captures` bucket, with a generated card as fallback) and a 7-day `vi_history` series shaped to its trend. Markets whose name already exists are skipped, so re-running is safe. The VI refresh cron takes over scoring from there. The list lives in `scripts/seed-trending.mjs`; edit `TRENDING` to swap in whatever is hot.

### Extension

1. `chrome://extensions` → enable **Developer Mode** → **Load unpacked** → select `atnx-extension/`.
2. Click the toolbar icon to open the side panel, open the gear, and set **Web App URL** to `http://localhost:3000` while developing locally. Chrome will ask to grant the extension access to that origin — accept, or captures can't attach the auth cookie.
3. Sign in at your web app URL first so the Supabase auth cookie exists. Then `Ctrl+Shift+X` / `Cmd+Shift+X` to capture.

Change the hotkey at `chrome://extensions/shortcuts`.

### Releasing the extension to the Chrome Web Store

```bash
cd atnx-extension
node package.mjs                 # → dist/atnx-capture-v<version>.zip (only the files the manifest needs)
node ../scripts/store-assets.mjs # regenerates store/screenshot-*.png + promo-small.png (needs Playwright)
```

Then follow `atnx-extension/store/LISTING.md`: it has the listing text, the
per-permission justifications, the data-usage disclosures, and the checklist
for the Developer Dashboard. The privacy policy the listing links to is served
by the web app at `/privacy`, so deploy the web app before submitting. Bump
`version` in `manifest.json` for every upload.

---

## Deployment

- Hosted on **Vercel**, domain `atnx.app`.
- `vercel.json` schedules `/api/markets/refresh` every 5 min (`*/5 * * * *`).
- `next.config.ts` is intentionally empty — all routing/CORS lives in `proxy.ts` and route handlers.
- The extension defaults to `https://atnx.app`; no rebuild needed to switch friends between prod and local.

---

## Tech stack

| | |
| --- | --- |
| Framework | Next.js 16.2.2 (App Router, Server Actions, `proxy.ts` — renamed from `middleware.ts` in 16) |
| UI | React 19.2, Tailwind v4, `next-themes`, `recharts` for sparklines |
| Auth + DB | Supabase (Postgres + RLS + Storage + Google OAuth), `@supabase/ssr` 0.10 |
| Signals | `google-trends-api`, Wikipedia REST (opensearch + per-article-daily) |
| Extension | Manifest V3, in-worker `OffscreenCanvas` cropping, Shadow DOM + Popover API overlay, `chrome.storage.local` for config |
| Models | Vercel AI SDK + AI Gateway: Gemini Flash / Flash-Lite for vision and text, Cohere Embed v4 for embeddings. The extension only ships the cropped image |

---

## Known rough edges

- `trends-cache.ts` is in-memory — in a multi-region Vercel deployment it's per-instance.
- No test framework. `npm run eval:capture` is the regression check for the submission pipeline; everything else is manual.
- Google Trends has no official API. Rate-limit hiccups surface as `score === 0` and the refresh cron quietly skips the market.
