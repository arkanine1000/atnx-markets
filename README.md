# ATNX — Attention Exchange

**Live at [atnx.app](https://atnx.app).**

A Chrome extension + Next.js web app for capturing any content on the internet, analyzing it with Claude, and trading a simulated Virality Index (VI) on what you capture. Your friends' screenshots become markets; markets have a live VI; you can go long or short.

```
Ctrl+Shift+X → drag a selection → Claude identifies it → a market spawns
                → VI updates every 5 min → trade long / short on it
```

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
          ┌────────────────────┐
          │  Chrome extension  │  screenshots + Claude vision
          │  (atnx.app default)│
          └──────────┬─────────┘
                     │ POST /api/captures  (Supabase cookie)
                     ▼
          ┌────────────────────┐        ┌──────────────────────┐
          │  Next.js @ atnx.app│───────▶│ Supabase (Postgres,  │
          │  App Router + SSR  │        │ Auth, Storage, RLS)  │
          └─────┬──────────────┘        └──────────────────────┘
                │
                │ composeVi = max(Trends, Wikipedia, LLM baseline)
                ▼
          Google Trends · Wikipedia · LLM analysis metrics
                ▲
                │ /api/markets/refresh every 5 min (Vercel Cron)
```

---

## Web app (`atnx-web/`)

### Routes

| Path | Guest? | What it does |
| --- | --- | --- |
| `/` | ✅ | Landing splash with "Launch App" |
| `/app` | ✅ | Dashboard — every market as a card, sorted by VI / newest / category, refreshes every 5s |
| `/app/markets/[id]` | ✅ | Market detail — hero card, 7-day VI sparkline, evidence strip of all captures, Trade button |
| `/app/portfolio` | ❌ | Open + closed positions, realized PnL, sim balance |
| `/app/settings` | ❌ | Profile management (handle, email) |
| `/admin` | admins only | Moderation: markets, captures in review, audit log |
| `/auth/callback` | — | OAuth return path; exchanges code → session, ensures `user_profiles` / `sim_balances` rows |

### API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/captures` | Extension ingest: normalize name, run `composeVi`, upload screenshot, resolve/create market, record VI |
| `GET /api/captures` | Dashboard feed (grouped by market, latest first) |
| `GET /api/markets/refresh` | Cron-only; re-runs `composeVi` for every live market, applies ±1.5% jitter, appends `vi_history` |

### Key libraries (`atnx-web/lib/`)

- **`signals.ts`** — `composeVi({ term, analysis })` runs Trends + Wikipedia + LLM baseline in parallel, returns the highest score and which source won.
- **`trends.ts`** — Google Trends (7d interest), virality score = 0.35 × current + 0.30 × momentum + 0.20 × spike + 0.15 × consistency, all × 10. `normalizeSearchTerm` strips separators so titles like `Foo / Bar` don't tank queries.
- **`wikipedia.ts`** — OpenSearch → per-article-daily pageviews (30d, 2-day lag). Score = `log10(peak + 10) × 200 − 200`. User-Agent required by Wikimedia. 1h cache.
- **`llm-baseline.ts`** — Deterministic floor from the analysis payload: parses `metrics_detected` (supports `16,374`, `2.3M`, `500K`, `1.2B`), counts `platforms_detected`, scans `virality_signals` for keyword hits.
- **`store.ts`** — `addCapture`, `resolveOrCreateMarket` (trigram similarity via `find_similar_market` RPC), `recordVi`, `getCaptures`, `getMarketDetail`.
- **`trends-cache.ts`** — 5 min in-memory cache keyed by lowercased term.
- **`capture-view.ts`** — UI helpers (`timeAgo`, `sentimentColor`, deterministic 24h % ticker).
- **`supabase/cookie-options.ts`** — Forces `SameSite=None; Secure` so the extension can attach the auth cookie on cross-origin fetches.

### React context + components

- **`AuthContext`** — `user`, `loading`, `openLoginModal`, `signInWithGoogle`. Subscribes to `onAuthStateChange` and auto-closes the modal when a session appears.
- **`DemoContext`** — `positions`, `balance`, `openPosition`, `closePosition`. Refreshes when auth state flips.
- **`LoginModal`** — Google-only right now. Backdrop-blurred. Escape-to-close.
- **`Nav`** — Logo + ATNX wordmark, UserMenu, theme toggle on the far right.
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

VI is a composite 0-1000 score. Every source is independent, we take the max — a viral Wikipedia article shouldn't be dragged down because Google Trends is quiet for that term.

| Source | Fires when | Scoring |
| --- | --- | --- |
| Google Trends | `term.length > 1` | Weighted blend of current interest, momentum, spike, consistency |
| Wikipedia | `term.length > 1` | `log10(peak daily views + 10) × 200 − 200` |
| LLM baseline | Always (if analysis present) | `max(metricsScore, platformsScore, signalsScore)` |

Cron every 5 minutes re-runs `composeVi` for every live market in batches of 4. If all sources return 0 the market keeps its last known VI instead of being zeroed.

---

## Database (Supabase)

| Table | Purpose |
| --- | --- |
| `markets` | One row per identified entity. `current_vi`, `total_captures`, `vi_last_updated`, `deleted_at`. |
| `captures` | Raw screenshots + AI analysis. FK to `markets`. `resolution_status` (`resolved` / `review` / `new_entity`), `confidence_score`, `deleted_at`. |
| `vi_history` | Append-only time series of `(market_id, vi, recorded_at)` powering the sparklines. |
| `user_profiles` | `id` (= auth.uid), `handle`, `email`, `role` (`user` / `moderator` / `admin`). |
| `sim_balances` | Per-user simulated USD balance, realized PnL, trade count. |
| `positions` | Open + closed trades: `direction`, `size_usd`, `entry_vi`, `exit_vi`, `realized_pnl`, `status`. |
| `moderation_log` | Admin audit trail. |

### RPCs (used via `supabase.rpc(...)`)

`find_similar_market`, `is_admin`, `admin_soft_delete_market`, `admin_restore_market`, `admin_edit_market_name`, `admin_soft_delete_capture`, `admin_reassign_capture`.

Storage: the `screenshots` bucket holds capture images; public URLs are stored on the capture row.

---

## Chrome extension (`atnx-extension/`)

Manifest V3, vanilla JS. Four moving parts:

- **`background.js`** (service worker) — Owns the capture pipeline. On `Ctrl+Shift+X` or the popup button it injects `content.js` if needed, receives the selected rect, crops via an offscreen document, calls the Claude API directly, then POSTs the result to `${webAppUrl}/api/captures` with `credentials: 'include'`.
- **`content.js` + `content.css`** — Injects the drag-to-select overlay and inline toast notifications on any page.
- **`popup.html` + `popup.js`** — Settings surface. Inputs for the Anthropic API key and the Web App URL (default `https://atnx.app`; override for local dev). Capture button, status dot, dashboard link.
- **`offscreen.html` + `offscreen.js`** — MV3 workaround for canvas-based cropping (service workers can't touch `<canvas>`).

Defaults & config (`chrome.storage.local`):
- `webAppUrl` — default `https://atnx.app`, editable from the popup
- `apiKey` — user's Anthropic API key (required for vision analysis)
- `captureStatus`, `captureCount` — UI feedback bookkeeping

Error copy surfaces the real issue: `401 → "Sign in at atnx.app first"`, network failure → `"Web app unreachable — check URL in popup"`.

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
| `CRON_SECRET` | server only | Bearer token Vercel sends to `/api/markets/refresh` |

### Extension

1. `chrome://extensions` → enable **Developer Mode** → **Load unpacked** → select `atnx-extension/`.
2. Open the popup, paste your **Anthropic API key**, and set **Web App URL** to `http://localhost:3000` while developing locally.
3. Sign in at your web app URL first so the Supabase auth cookie exists. Then `Ctrl+Shift+X` / `Cmd+Shift+X` to capture.

Change the hotkey at `chrome://extensions/shortcuts`.

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
| Signals | `google-trends-api`, Wikipedia REST (opensearch + per-article-daily), deterministic LLM baseline |
| Extension | Manifest V3, offscreen document for canvas cropping, `chrome.storage.local` for config |
| Vision | Claude (Anthropic) via direct extension-side API call — the key never leaves the user's browser |

---

## Known rough edges

- Extension API key lives in `chrome.storage.local`; production should proxy Claude calls through the server.
- `trends-cache.ts` is in-memory — in a multi-region Vercel deployment it's per-instance.
- No automated tests yet; verification is manual (see each feature's PR notes).
- Google Trends has no official API. Rate-limit hiccups surface as `score === 0` and the refresh cron quietly skips the market.
