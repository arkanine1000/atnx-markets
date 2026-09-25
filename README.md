# ATNX — Attention Exchange

**Live at [atnx.app](https://atnx.app).**

A Chrome extension + Next.js web app for capturing any content on the internet, identifying it with a vision model, and trading a simulated Virality Index (VI) on what you capture. Your friends' screenshots become markets; markets have a live VI; you can go long or short.

```
Ctrl+Shift+X → drag a selection → the model identifies it → you review: add to a market, or create one
                → VI updates every 5 min → trade long / short on it
```

Three ways in, one pipeline: the extension, the web form at `/app/submit` (screenshot, link, or text), and the Android share sheet. Every one of them stops at a review step before anything lands: the model's proposal, the existing markets it could belong to, and the choices the submitter may make, all bounded (no free text). A repeat of something captured before is answered outright.

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
          │ POST /api/captures/propose (cookie) │ POST /share
          ▼                 ▼                  ▼
   ┌───────────────────────────────────────────────────┐    ┌──────────────────────┐
   │  Next.js @ atnx.app        lib/capture.ts         │───▶│ Supabase (Postgres + │
   │  propose: hash → retrieve → model → route → draft │    │ pgvector, Auth,      │
   │  review:  side panel / /app/submit/review/<draft> │    │ Storage, RLS)        │
   │  commit:  attach or create → upload → audit       │    │                      │
   └───────────────┬───────────────────────────────────┘    └──────────────────────┘
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
| `/` | ✅ | Landing splash: "Join Waitlist" (an email, stored in `waitlist`), "Launch Beta" and the docs link |
| `/app` | ✅ | Dashboard — the intro card (closable on phones, remembered), the featured showcase (swipeable on phones), then every market as a card, sorted by VI / newest / category, 24 a page, refreshes every 30s. `?q=` narrows the listing to markets whose name contains the term (the nav's search box) |
| `/app/markets/[id]` | ✅ | Market detail — hero card, VI chart, pulse / activity / overview tabs, the order ticket in a side column. Share sits with the tabs and the markets before and after this one by virality head the page (no back link: Markets is in the nav). On phones the ticket sits behind Long / Short buttons anchored just above the tab bar (`TradeDock`; a sheet slides up from the bottom edge), and a sideways swipe moves to the neighbouring market |
| `/app/submit` | ❌ | Web entry: drop or paste a screenshot, or give a link or a line of text. Proposes, then hands over to the review page |
| `/app/submit/review/[draftId]` | ❌ | The review step: the image with a crop tool (two re-crops per draft), what the model found, the existing markets it could belong to (a strong match, the *subject* it is about, or a few close ones), and the create form with the proposed name and up to two alternates, type and category from the enums, and aliases that can only be dropped. Drafts expire after fifteen minutes |
| `/app/portfolio` | ❌ | Open + closed positions, realized PnL, sim balance. On phones it is laid out like the extension's side panel: a value tile with a range sparkline from `/api/portfolio`, then a collapsible Balance / Unrealized / Open card whose rows expand to close a position |
| `/app/share/resume` | ❌ | Second half of a share that arrived signed out: the service worker parks the capture in the Cache API and sends the window here; after sign-in the page replays it through `/share` |
| `/app/settings` | ❌ | The account's email and handle, read-only. Handles are fixed: the leaderboard and the trade log know you by them |
| `/admin` | admins only | Moderation: markets (rename, soft-delete, restore, purge a soft-deleted one for good, set what a market is about), captures in review (low-confidence creates and overrides), audit log, waitlist signups (with a copy-all for invites), and the trading book: treasury, fees paid to creators, and every trader's equity, realized and unrealized result, trade counts and volume (the public leaderboard shows only rank, fees and PnL) |
| `/share` | ❌ | Android share-target POST (image, link, or text) → propose → redirect to the review page, or straight to the market with `?shared=<outcome>` for a repeat, which the market page turns into a toast. The service worker (`public/sw.js`) takes the POST over: it answers at once with a "Capturing…" page, shrinks a screenshot to a 1080 px JPEG (raw phone screenshots exceed Vercel's 4.5 MB body limit), uploads with `Accept: application/json` to get the target path back, and moves the window there. A link whose site blocks previews (Facebook, Instagram, TikTok) is tried from its caption, and failing that lands on `/app/submit` prefilled so one screenshot finishes it |
| `/auth/callback` | — | OAuth return path; exchanges code → session, ensures `user_profiles` / `sim_balances` rows |

### API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/captures/propose` | First half of a submission, for the extension, the web form and the share target. Multipart with `image`, `url`, or `text`. Hash dedup → candidate retrieval → one model call → link check → route → a draft for review (or the earlier answer for a repeat). Rejections are 422 with a reason and skip review; X/TikTok/Instagram links that cannot be fetched return `needs_image` |
| `POST /api/captures/commit` | Second half. JSON `{ draftId, choice }`, the choice validated against what the draft offered: attach to an offered market, create with a proposed name, or create the subject's market. Persists the capture and any market, writes the audit row, schedules the VI scoring. Creating is capped per account per day; admins and listed accounts are exempt |
| `POST /api/captures/recrop` | JSON `{ draftId, crop }` in original pixels. The server crops its own copy, runs the model once more and rewrites the draft |
| `POST /api/captures` | The one-shot path: propose and commit the default choice in one call. Kept for the eval script and older clients |
| `GET /api/markets` | One page of the dashboard's listing plus the hero's featured set; takes the page's own `sort`, `page` and `q` parameters |
| `GET /api/captures` | Dashboard feed (grouped by market, latest first); also feeds the extension side panel's top markets |
| `POST /api/waitlist` | Landing-page signup. JSON `{ email }`; the address is checked for shape, lowercased and stored once (a repeat answers `already`). Five per IP per ten minutes; a filled honeypot field is answered as a success and dropped |
| `GET /api/portfolio` | Extension side panel: handle, sim balance, realized/unrealized PnL, total value, open positions (with latest capture thumbnail), and a 7-day portfolio-value series rebuilt from each open position's `vi_history` (401 when signed out) |
| `POST /api/positions` | Extension side panel: opens a position. JSON `{ marketId, direction, sizeUsd, leverage }`, the same checks and database call as the site's own ticket (`lib/trading.ts`); a rule the database refuses (insufficient balance, a market with no score yet) is a 400 with its message, signed out is 401 |
| `POST /api/positions/[id]/close` | Extension side panel: closes one of the caller's open positions and answers `{ realizedPnl, exitVi, liquidated }`; a position that is not the caller's or is already closed is 404 |
| `GET /api/markets/refresh` | Cron-only, every 5 min; re-reads the fast VI sources (Google Trends, Bluesky) for every live market, combines them with the stored slow readings, appends an EMA-smoothed point to `vi_history` |
| `GET /api/markets/refresh-slow` | Cron-only, hourly; runs the GDELT count on BigQuery, then the same for the slow sources (GDELT, Wikipedia, YouTube, HN, X, TikTok). Then expires review drafts nobody committed, and curates images and descriptions for up to a dozen highlighted markets (see `thumbnails.ts`) |

### Key libraries (`atnx-web/lib/`)

- **`capture.ts`** — The submission pipeline in two halves. `proposeCapture` hashes the input, retrieves candidates, calls the model, checks the proposal against existing markets, resolves the subject the content is about, routes, and stores a draft with the image parked. `commitDraft` takes the reviewer's validated choice and runs the tail: attach or create, upload, audit, VI scoring after the response. `recropDraft` applies a rectangle and re-analyses. `processCapture` is the one-shot wrapper.
- **`review.ts`** — The review step's shape: the nudge (strong match, subject, ambiguous, none) and the bounded choices, `validateChoice`, the daily create cap and its exemptions, the draft table and the parked images, the sweep. **`capture-request.ts`** reads the multipart body the capture routes share.
- **`vlm.ts`** — The one model call, through Vercel AI Gateway (Gemini Flash for images, Flash-Lite for text, thinking off). Output validated against a per-request zod schema: admit / reject reason, matched candidate id, or a new market with name, up to two alternate names, type, category (ten fixed values) and aliases, plus the subject the content is about (a candidate id, or a name and type the server resolves against existing markets).
- **`embed.ts`**, **`retrieve.ts`** — Cohere Embed v4 text embeddings (512 dims) and the two retrieval queries (cosine on `markets.embedding`, trigram on names and aliases).
- **`route.ts`** — Deterministic routing table on the model output and retrieval scores; writes `submission_decisions`.
- **`signals.ts`** — `scoreTerms(requests, cadence)` scores markets across four sources (a market with no stored breakdown fetches all four whatever the cadence) and combines them with `vi/score.ts`: each source gives an absolute level (0–1000) and a momentum ratio against the term's own baseline; the composite is the weighted level scaled by momentum (0.65x at a collapse, 1x steady, 1.35x at a 10x spike) over the sources that answered, times a presence multiplier (0.8 for one source up to 1.2 for all four). Sources live in `vi/trends.ts` (co-queried against a benchmark keyword so scores compare across markets), `vi/bluesky.ts`, `vi/gdelt.ts`, `vi/wikipedia.ts`. `npm run vi:probe "term"` prints the breakdown.
- **`trends.ts`** — Google Trends (7d interest), virality score = 0.35 × current + 0.30 × momentum + 0.20 × spike + 0.15 × consistency, all × 10. `normalizeSearchTerm` strips separators so titles like `Foo / Bar` don't tank queries.
- **`wikipedia.ts`** — OpenSearch → per-article-daily pageviews (30d, 2-day lag). Score = `log10(peak + 10) × 200 − 200`. User-Agent required by Wikimedia. 1h cache.
- **`store.ts`** — `createMarket` (unique normalised name; re-selects on conflict; takes the parent pointer), `addCapture`, `recordVi`, `getCaptures`, `getMarketDetail` (with the market's parent and children). Captures display their market's category and description, not their own analysis's.
- **`thumbnails.ts`** — The hybrid between pump.fun's user-chosen art and Polymarket's curated images. Every card starts with the newest user capture. For highlighted markets (top 24 by VI, or ≥ $1,000 traded) the hourly slow refresh finds a canonical image after the fact, copies it into the `captures` bucket under `markets/`, and writes `markets.thumbnail_url`; cards, list rows and the featured hero prefer it, the market page keeps showing the captures. The source follows the entity type: brands take the logo from Wikidata (the article must be about a company or product, so "Apple" finds "Apple Inc." and not the fruit), people the Wikipedia portrait (only when Wikidata says the article is about a human, and never for a name whose article is a disambiguation page), memes and everything else the preview image of the reference page a capture came from (Know Your Meme, fandom wikis, Wikipedia), then the Know Your Meme entry guessed from the name (its slugs are the title), then the Wikipedia lead image unless the article is about an ordinary thing sharing the name or, for a meme, not about internet culture. A page counts only when it is titled with the market's own name (a site's home or search page hands out its logo), a Wikipedia alias match never does, and an image several markets share is a placeholder and is dropped for the screenshot. Logos are drawn whole on a tile whose shade the card picks from the mark itself (`components/LogoImage.tsx`), and portraits are cropped near the top. A market with no image is retried weekly. Never overwrites a `thumbnail_url` whose source is `manual`. The same pass takes the market's description from the same place as the image (the Wikipedia intro, the reference page's summary) into `markets.description`, which the hero and the market page show instead of the newest capture's description of a post. `npm run thumbs:backfill` runs a pass now; `--redo` replaces images an earlier pass chose.
- **`og.ts`** — Fetches a link's preview image and title for URL submissions and the share target: YouTube thumbnails directly, TikTok via oEmbed or the page's hydration JSON, everything else from `og:image` with a browser user agent first and Facebook's crawler user agent second (Facebook, Instagram and Threads are tried crawler-first). Login walls and placeholder logos count as no image.
- **`trends-cache.ts`** — 5 min in-memory cache keyed by lowercased term.
- **`capture-view.ts`** — UI helpers (`timeAgo`, `sentimentColor`, `viChange24h` from the VI history).
- **`supabase/cookie-options.ts`** — Forces `SameSite=None; Secure` so the extension can attach the auth cookie on cross-origin fetches.

### React context + components

- **`AuthContext`** — `user`, `loading`, `openLoginModal`, `signIn(provider)` (Google or X). Subscribes to `onAuthStateChange` and auto-closes the modal when a session appears.
- **`DemoContext`** — `positions`, `balance`, `openPosition`, `closePosition`. Refreshes when auth state flips.
- **`LoginModal`** — Google-only right now. Backdrop-blurred. Escape-to-close.
- **`LiveLogo`** — The brand mark drawn as SVG (the lens, cyan | magenta, black pupil; no light cone). The pupil eases toward the pointer, glances about on its own when nobody is pointing, and the lids blink every few seconds; still under reduced motion. The flat `public/logo_*.png` marks are kept for a revert.
- **`Nav`** — LiveLogo + ATNX wordmark, UserMenu, theme toggle on the far right. From `sm` up Markets, Portfolio and Leaderboard sit in a pill in the header, followed by the market search (`NavSearch`: a magnifying glass that opens into a field; on the markets page the listing follows the text, elsewhere Enter goes there), and Create is a pill beside the avatar with a magenta + and the word; on phones the tabs become a fixed bottom bar (Markets, the +, Portfolio), the search sits beside the account and Leaderboard moves into the UserMenu; a market page stacks its trade dock on top of the bar.
- **`PortfolioMobile`**, **`charts/PortfolioSparkline`** — The phone portfolio: value tile, range tabs, positions card, fed by `/api/portfolio`.
- **`Identicon`** — Generated avatar seeded by the account id: a disc of one ink under blocks of the other two in multiply blend, so overlaps print the secondaries, with a black pupil and a glint set a little off centre per account. Stands in for the handle in the header, on the leaderboard and on the settings page. The extension draws the same face from the same id (`atnx-extension/identicon.js`).
- **`ShareButton`** — Native share sheet on phones (`navigator.share`), clipboard elsewhere; on every market page.
- **`Trading/*`** — `TradeModal`, `ClosePositionModal`, `TrendSparkline` (entry marker), `DemoToast`, `getTrendIndicator`.
- **`ThemeToggle`** — `next-themes`, class-based dark/light.

---

## Auth flow

1. Anyone hits `/` → lands on splash → clicks **Launch Beta** → `/app`.
2. Guests can browse the dashboard and market detail pages. Trade buttons turn into **Login** buttons; `/app/portfolio` shows a login panel.
3. Clicking any Login opens the blurred modal → Google or X OAuth via `supabase.auth.signInWithOAuth`.
4. `/auth/callback` exchanges the code for a session, sets the auth cookie with `SameSite=None; Secure` (via `proxy.ts`), redirects back.
5. `proxy.ts` only protects `/admin` and `/app/settings`. Everything else is open for guests.
6. Because the cookie is `SameSite=None; Secure`, the Chrome extension's `fetch(..., { credentials: 'include' })` attaches it when posting captures — the server can attribute the capture to the signed-in user without a token exchange.

---

## VI (Virality Index) pipeline

VI is a composite 0-1000 score from four sources, each reporting an absolute level and a momentum ratio against the term's own baseline; the composite is the weighted level scaled by momentum over the sources that answered, times a presence multiplier (see `signals.ts` above). Nothing read off the screenshot feeds the score, so resubmitting the same image cannot move it. Each source searches the market's name and its aliases together.

| Source | Cadence | Notes |
| --- | --- | --- |
| Google Trends | every 5 min | Co-queried against a benchmark keyword so scores compare across markets; quantises small terms |
| Bluesky | every 5 min | Post counts over the last day and hour; needs `BLUESKY_*` |
| GDELT | hourly | News coverage from GDELT's Global Knowledge Graph on BigQuery: an hourly job counts, per market and day, distinct stories (syndicated copies merged) whose extracted names or page title contain the name or an alias, as a share of the day's stories. Not the `memes` category. Needs `GCP_SA_KEY_B64` |
| Wikipedia | hourly | Daily pageviews with a two-day lag; also the guard that lets a single-word name count on the fast sources |

A market whose sources all answer "unknown" keeps its last value. A brand-new market is scored right after its commit; if that misses, the next five-minute pass fetches every source for it.

---

## Database (Supabase)

| Table | Purpose |
| --- | --- |
| `markets` | One row per identified entity. `entity_type`, `category` (ten enum values), `aliases`, `embedding vector(512)`, `current_vi`, `vi_components`, `total_captures`, `total_volume_usd`, `thumbnail_url` + source, `description` + source, `parent_market_id` (the subject a meme is about, one level, display only), `created_by` (earns half of every fee), `deleted_at`. Unique on the normalised name among live rows. |
| `captures` | Screenshots + model analysis. FK to `markets`. `content_hash` (unique among live rows: exact dedup), `resolution_status` (`resolved` / `review`), `confidence_score`, `deleted_at`. |
| `submission_drafts` | The review step: one row per proposed submission with the analysis, candidates, routing decision, nudge and the bounded choices; the parked image path; status pending / committed / expired. Server-only. |
| `submission_decisions` | Audit: one row per committed or rejected submission with outcome, market, candidates shown, similarity scores, model confidence, reject reason, latency and the full model response. Admin-readable. |
| `vi_history` | Append-only time series of `(market_id, vi, raw_vi, recorded_at)` powering the sparklines. |
| `user_profiles` | `id` (= auth.uid), `handle` (fixed), `email`, `role` (`user` / `moderator` / `admin`). |
| `sim_balances` | Per-user simulated USD balance, realized PnL, trade count, fees earned and paid. |
| `positions` | Open + closed trades: `direction`, `size_usd`, `leverage`, `entry_vi`, `exit_vi`, `realized_pnl`, `fee_usd`, `liquidated`, `status`. |
| `fee_events`, `sim_treasury` | The fee ledger (1% of every open, half to the market's creator, half to the treasury) and the treasury's one row. |
| `moderation_log` | Admin audit trail. |
| `waitlist` | Landing-page signups: `email` (unique, case-insensitive), `source`, `created_at`. Written by the server, admin-readable. |

### RPCs (used via `supabase.rpc(...)`)

`match_markets_by_embedding`, `match_markets_by_name`, `vi_history_series`, `open_position`, `close_position`, `is_admin`, `admin_soft_delete_market`, `admin_restore_market`, `admin_purge_market`, `admin_edit_market_name`, `admin_set_parent_market`, `admin_soft_delete_capture`, `admin_reassign_capture`. (`find_similar_market` still exists but is no longer called.)

Schema changes are numbered SQL files in `atnx-web/supabase/`, applied by hand in order; see that README for the list.

Storage: the `captures` bucket (public) holds capture images under `{user_id}/`, review drafts' parked images under `{user_id}/pending/` (removed on commit or expiry), and curated market images under `markets/{id}/`; public URLs are stored on the rows. Text-only submissions have no image.

---

## Chrome extension (`atnx-extension/`)

Manifest V3, vanilla JS, no build step. Three moving parts (plus `identicon.js`, the avatar drawing shared in spirit with the web component):

- **`background.js`** (service worker) — Owns the capture pipeline. On `Ctrl+Shift+X` or the side panel's Capture button it injects `content.js` on demand (`activeTab` + `scripting`), receives the selected rect, screenshots the tab, crops it in-worker with `createImageBitmap` + `OffscreenCanvas` (longest edge capped at 1080 px, JPEG at 0.85), then POSTs it as `multipart/form-data` to `${webAppUrl}/api/captures/propose` with `credentials: 'include'`. The draft that comes back is parked in storage for the side panel to review. Status is mirrored on the toolbar badge (`…` / `?` awaiting review / `✓` / `!`).
- **`content.js`** — Drag-to-select overlay and toast notifications, rendered inside a closed Shadow DOM host that is promoted to the browser's top layer via the Popover API, so page CSS and z-index stacking can't interfere. Uses pointer events with pointer capture; Escape cancels. Only injected on pages the user captures.
- **`sidepanel.html` + `sidepanel.js`** — Clicking the toolbar icon opens a Chrome side panel (wallet-style, no popup). Top to bottom: the account's avatar (the same generated face as the site, from the `userId` in `GET /api/portfolio`) and handle; Capture button (which reads CAPTURING… / ANALYZING… while the pipeline runs) with the shortcut beneath; when a capture is waiting for review, a card with what was found and one button per option (add to the market it looks like or is about, create it, track its subject), a link to the full review page for cropping or editing, and Discard; a portfolio-value stat tile (hero number, 7-day delta, SVG sparkline with crosshair tooltip, keyboard-navigable) fed by `GET /api/portfolio`; a collapsible portfolio card (Balance / Unrealized / Open, expands to open positions as thumbnail · name · current value · PnL %, shorts marked with an `S` badge; a position row expands in turn to its entry, current VI, PnL and size, a link to the market, and a Close button that goes through `POST /api/positions/[id]/close` and reports what the close paid under the card); and the top 5 markets by VI (`GET /api/captures`, grouped by market) as thumbnail · name · VI, the thumbnail being the market's curated image when it has one. A market row expands to an order ticket, the site's own in miniature: Long / Short, the amount with $25 / $50 / $100 / $500 and Max, leverage 1× to 10×, the entry VI, exposure, liquidation VI, fee and total against the available balance, and one button that opens the position through `POST /api/positions`; signed out, the button offers sign-in instead. The last ticket's side, size and leverage carry over to the next. Every row still links to `/app/markets/[id]` from inside its expansion. Polls every 30 s while visible; a refresh that lands while a ticket is being typed into keeps the field and the caret. The gear reveals settings: Web App URL (default `https://atnx.app`; override for local dev — saving a custom origin requests an optional host permission for it) and the current shortcut.

Permissions: `activeTab`, `scripting`, `storage`, `sidePanel`, host access to `https://atnx.app/*` only. Other origins are `optional_host_permissions`, granted from the panel when you save a custom URL. Host access to the web app keeps the Supabase auth cookie flowing even when third-party cookies are blocked.

`activeTab` is granted per tab by the hotkey or a toolbar click, so the panel's Capture button only works on the tab the panel was opened from; on another tab it explains to use the shortcut or click the icon again. Icons are the bare eye-and-beam glyph on a transparent background (16/32/48/128), regenerated from `atnx-web/public/app_icon.png`.

Defaults & config (`chrome.storage.local`):
- `webAppUrl` — default `https://atnx.app`, editable from the popup
- `captureStatus`, `captureStatusAt`, `captureCount` — UI feedback bookkeeping
- `pendingReview` — the draft awaiting the person's choice, dropped on commit, discard or expiry

Error copy surfaces the real issue: `401 → "Sign in at atnx.app first"`, `404 → the web app at that URL has no review endpoint yet`, `413 → "Selection too large to upload"`, network failure → `"Web app unreachable — check URL in popup"`.

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

Optional overrides (model ids, link and confirm thresholds, the daily market-creation cap and its exemptions) and the `EVAL_*` variables for the eval script are listed in `atnx-web/.env.local.example`.

### Checking the pipeline

```bash
npm run eval:capture -- --cleanup   # 25 fixtures through the one-shot route, resubmits, then the review cases; needs a running dev server
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
- `vercel.json` schedules `/api/markets/refresh` every 5 min (`*/5 * * * *`) and `/api/markets/refresh-slow` hourly.
- `next.config.ts` is intentionally empty — all routing/CORS lives in `proxy.ts` and route handlers.
- The extension defaults to `https://atnx.app`; no rebuild needed to switch friends between prod and local.

---

## Tech stack

| | |
| --- | --- |
| Framework | Next.js 16.2.2 (App Router, Server Actions, `proxy.ts` — renamed from `middleware.ts` in 16) |
| UI | React 19.2, Tailwind v4, `next-themes`, `recharts` for sparklines |
| Auth + DB | Supabase (Postgres + RLS + Storage + Google + X OAuth), `@supabase/ssr` 0.10 |
| Signals | `google-trends-api`, Wikipedia REST (opensearch + per-article-daily) |
| Extension | Manifest V3, in-worker `OffscreenCanvas` cropping, Shadow DOM + Popover API overlay, `chrome.storage.local` for config |
| Models | Vercel AI SDK + AI Gateway: Gemini Flash / Flash-Lite for vision and text, Cohere Embed v4 for embeddings. The extension only ships the cropped image |
| Images | `sharp` for the review step's server-side crop |

---

## Known rough edges

- `trends-cache.ts` is in-memory — in a multi-region Vercel deployment it's per-instance.
- No test framework. `npm run eval:capture` is the regression check for the submission pipeline and the review step; everything else is manual.
- Google Trends has no official API. Rate-limit hiccups surface as `score === 0` and the refresh cron quietly skips the market.
