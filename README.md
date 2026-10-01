# ATNX — Attention Exchange

**Live at [atnx.app](https://atnx.app).**

A Chrome extension + Next.js web app for capturing any content on the internet, identifying it with a vision model, and trading a simulated Virality Index (VI) on what you capture. Your friends' screenshots become markets; markets have a live VI; you can go long or short.

```
Ctrl+Shift+X → drag a selection → the model identifies it → you review: add to a market, or create one
                → VI updates every 5 min → trade long / short on it
```

Three ways in, one pipeline: the extension, the web form at `/app/submit` (screenshot, link, or text), and the Android share sheet. Every one of them stops at a review step before anything lands: the model's proposal, the existing markets it could belong to, and the choices the submitter may make, all bounded (no free text). A repeat of something captured before is answered outright.

---

## Hackathon build: bounded UP/DOWN markets on the VI

This repository is the hackathon fork of ATNX for the **Arbitrum / Robinhood Chain Open House (Singapore)** and the **Colosseum Crypto World's Fair**. It replaces the simulated long/short trading with on-chain two-outcome markets on the Virality Index, and keeps everything upstream of trading (capture, identification, the VI pipeline) as it was.

**Prior work disclosure.** Everything up to the tag [`pre-hackathon-2026-10-01`](https://github.com/arkanine1000/atnx-markets/releases/tag/pre-hackathon-2026-10-01) is the pre-existing ATNX product (private upstream `gptdnd/atnx`). The hackathon work is exactly this diff: [compare `pre-hackathon-2026-10-01...main`](https://github.com/arkanine1000/atnx-markets/compare/pre-hackathon-2026-10-01...main).

| | |
|---|---|
| Live app | https://markets.atnx.app (production ATNX stays at https://atnx.app) |
| Contracts | `contracts/` (Foundry). Addresses below once deployed. |
| Design doc | "ATNX devnet market design: bounded VI markets", 2026-09-30 (summarised in *How it works*) |
| Status | _updated every step; see **Built / not built** below_ |

### Deployed contracts

| Chain | BoundedVIMarkets | MockUSDG | Explorer |
|---|---|---|---|
| Robinhood Testnet (46630) | _pending_ | _pending_ | https://explorer.testnet.chain.robinhood.com |
| Arbitrum Sepolia (421614) | _pending_ | _pending_ | https://sepolia.arbiscan.io |

### How it works

Each market is a two-outcome market on one subject's VI, with an **upper and a lower bound** fixed from the VI at opening (`atnx-web/lib/bm/bounds.ts`):

`m = min(5, max(1.2, 1 + 4·(100/VI)^1.25))`, upper = VI·m, lower = VI/m (two significant figures; a lower bound under 5 is 0).

| Start VI | Lower | Upper |
|---|---|---|
| 10 | 0 | 50 |
| 100 | 20 | 500 |
| 300 | 150 | 600 |
| 1000 | 820 | 1200 |

- **UP** and **DOWN** shares. One UP plus one DOWN always costs 1 mock USDG; the split is set by a fixed-product market maker seeded by the treasury (1,000 mock USDG per market, 50/50 start).
- **Resolution** only when the VI touches a bound: three consecutive VI prints at or past a bound (the VI is written every five minutes, so about fifteen minutes). UP pays 1 USDG per share at the upper bound, DOWN at the lower. No end date otherwise: holders sell to take profit or cut losses.
- **Auto-roll**: when a market resolves, the keeper opens a new one from the new VI. Winners redeem by hand; nothing moves their funds.
- **Oracle**: the keeper wallet (a Vercel cron every five minutes) reads the VI history that production ATNX writes and posts resolutions. Centralised by design for the testnet build.
- **Fee**: 1% on buys and sells, accrued per market.
- **No leverage, no liquidation, no house counterparty.** Every market is fully funded by its own shares.

### Built / not built

_Updated as the build progresses._

- [x] Fork, tag, registry schema (`atnx-web/supabase/bm/`), bounds function with tests
- [x] Contracts with Foundry tests (`contracts/`, 19 tests incl. fuzz and invariants)
- [ ] Contracts deployed on both chains (needs testnet gas on the keeper wallet)
- [x] Keeper (resolution + auto-roll) and the open-market flow (`atnx-web/lib/bm/`, `/api/bm/keeper`)
- [x] Web: wallet, UP/DOWN ticket, bounds on the chart, pool price, activity from chain events
- [x] On-chain portfolio (`/app/portfolio`)
- [x] Extension fork (`atnx-extension/`, unpublished; rows deep-link to the market page since a side panel cannot reach an injected wallet)
- [ ] End-to-end on Robinhood Testnet and Arbitrum Sepolia
- [ ] Solana program (Colosseum Solana track)

Known limits: centralised oracle; the VI itself is computed by production ATNX; the "deemed dead" rule for markets with a lower bound of 0 is not implemented; the treasury seed is not recovered; the 50/50 opening price is a product choice (the design doc illustrates a linear price).

### Demo script (3 minutes)

_To be finalised with the deployed addresses._

### Operations

- Env vars: see `atnx-web/.env.local.example` plus `CRON_SECRET`, `BM_KEEPER_PRIVATE_KEY`, `NEXT_PUBLIC_BM_DEFAULT_CHAIN`, `BM_SEED_USDG`, `BM_TOUCH_PRINTS`, `BM_MAX_VI_AGE_MIN`, `BM_AUTO_ROLL`.
- Run the keeper by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://markets.atnx.app/api/bm/keeper?dry=1`.
- Tests: `cd contracts && forge test`; `cd atnx-web && npm run test:bm`.

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
                   │ Vercel AI Gateway: Gemini Flash (vision), Cohere Embed v4 (text),
                   │                    Jev (typed yes/no verdicts: X post filter on, gate in shadow)
                   │
                   │ VI = total attention across sources, one log, × momentum
                   ▼
   Google Trends · Bluesky · Wikipedia · GDELT · YouTube · Hacker News · X · TikTok
   + the market's own YouTube channel and X account, when verified
                   ▲
                   │ /api/markets/refresh every 5 min, /api/markets/refresh-slow hourly (Vercel Cron)
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
| `/admin` | admins only | Moderation: markets (rename, soft-delete, restore, purge a soft-deleted one for good, retire with the name blocked and optionally its aliases, set what a market is about; each row shows where its description came from), captures in review (low-confidence creates and overrides), audit log, waitlist signups (with a copy-all for invites), and the trading book: treasury, fees paid to creators, and every trader's equity, realized and unrealized result, trade counts and volume (the public leaderboard shows only rank, fees and PnL) |
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
| `GET /api/markets/refresh-slow` | Cron-only, hourly at :07; runs the GDELT count on BigQuery, then the slow sources (GDELT, Wikipedia, YouTube, HN, X, TikTok; X and TikTok read each market every three hours), snapshots every market's breakdown into `vi_component_history`. Then the creator resolvers (a few markets a run) and the own-account reads (YouTube channels hourly, X accounts every six hours), expires review drafts nobody committed, prunes old snapshots, curates images and descriptions for up to a dozen highlighted markets (see `thumbnails.ts`) and describes up to a dozen markets that still have no description (`describe.ts`) |

### Key libraries (`atnx-web/lib/`)

- **`capture.ts`** — The submission pipeline in two halves. `proposeCapture` hashes the input, retrieves candidates, calls the model, checks the proposal against existing markets, resolves the subject the content is about, routes, and stores a draft with the image parked. `commitDraft` takes the reviewer's validated choice and runs the tail: attach or create, upload, audit, VI scoring after the response. `recropDraft` applies a rectangle and re-analyses. `processCapture` is the one-shot wrapper.
- **`review.ts`** — The review step's shape: the nudge (strong match, subject, ambiguous, none) and the bounded choices, `validateChoice`, the daily create cap and its exemptions, the draft table and the parked images, the sweep. **`capture-request.ts`** reads the multipart body the capture routes share.
- **`vlm.ts`** — The one model call, through Vercel AI Gateway (Gemini Flash for images, Flash-Lite for text, thinking off). Output validated against a per-request zod schema: admit / reject reason, matched candidate id, or a new market with name, up to two alternate names, type, category (ten fixed values) and aliases, plus the subject the content is about (a candidate id, or a name and type the server resolves against existing markets).
- **`embed.ts`**, **`retrieve.ts`** — Cohere Embed v4 text embeddings (512 dims) and the two retrieval queries (cosine on `markets.embedding`, trigram on names and aliases).
- **`route.ts`** — Deterministic routing table on the model output and retrieval scores; writes `submission_decisions`.
- **`signals.ts`** — `scoreTerms(requests, cadence)` reads the sources due at this cadence for each market (a market with no stored breakdown reads every source), merges them with the stored breakdown, and combines them with `vi/score.ts` (see the VI section below). Some sources only cover part of the world and are asked by category: Hacker News for tech and crypto, TikTok for memes, people, music, film and TV, gaming and other, GDELT for everything but memes, DexScreener for crypto tokens. Search phrases are the name plus its multi-word aliases; a one-word alias joins only once the Wikipedia reading vouches that it redirects to the market's own article (`searchableAliases`). The bare name itself is dropped from the search phrases, and from the TikTok hashtag candidates, when it is an everyday word naming a work: a film, show, game or song whose Wikipedia article is a qualified title like "Cars (film)", or any market the model named with a qualifier, "Cars (2006 film)" (`searchTerms`, `tiktokAliases`). Wikipedia keeps the bare name, which is how it finds the article, and a new market resolves Wikipedia before its first pass so this applies from the number it goes live with.
- **`vi/`** — One file per source (`trends`, `bluesky`, `wikipedia`, `gdelt` with `bigquery`, `youtube`, `hn`, `x`, `tiktok`, `dex`), the pure scoring math in `score.ts` (calibration constants, `combine`, tiers, smoothing), `samples.ts` for the per-source raw series, `relevance.ts` (the YouTube title filter) and the two Jev shadows `relevance-jev.ts` and `relevance-x-jev.ts`. `npm run vi:probe "term"` prints a breakdown.
- **`creators/`** — A market's own accounts: `resolve.ts` and `resolve-x.ts` find the YouTube channel and the X account automatically (capture evidence, Wikidata, guessed handles), `store.ts` keeps them in `market_handles`, `channel.ts` and `x-account.ts` read the verified ones' own audience for the score.
- **`blocklist.ts`**, **`admission-jev.ts`**, **`jev.ts`** — The two guards between "the model proposed a market" and "a market exists": generic calendar phrases are rejected, and names an admin retired (`blocked_terms`) cannot return; a retirement for wording blocks only the exact name, so the subject can come back under a better one. Jev, TypeSafe AI's typed-decision model on the gateway, answers yes/no questions with a probability: it filters X posts for the score (`JEV_TWEETS=on`, keep at `JEV_TWEET_KEEP_AT`, default 0.4), gives a shadow opinion on the admission gate (`JEV_GATE`), and lost the YouTube title comparison to Gemini (`JEV_TITLES=off` in production). Each flag is `off | shadow | on`.
- **`describe.ts`** — Every market gets a description, not only the highlighted ones the image job curates: the market's own Wikipedia article when the stored reading says it owns one, else its Know Your Meme entry, else a capture's reference page, else one line from the text model (source `model`, tagged in the admin table). A dozen markets per hourly run, a new market right after its first score, retried weekly while none is found (`description_checked_at`); an existing description is never revisited, and a reference page found later replaces a model line.
- **`trends.ts`** — The Google Trends interest series for the market page's seed sparkline; `normalizeSearchTerm` strips separators so titles like `Foo / Bar` don't tank queries. Scoring reads Trends through `vi/trends.ts`.
- **`pnl.ts`**, **`trading.ts`**, **`treasury.ts`** — Position accounting shared by every view (PnL is linear in the VI against the entry, floored at the size; `liquidationVi`), the open and close calls the ticket and the extension share, and the fee treasury.
- **`store.ts`** — `createMarket` (unique normalised name; re-selects on conflict; takes the parent pointer), `addCapture`, `recordVi`, `getCaptures`, `getMarketDetail` (with the market's parent and children). Captures display their market's category and description, not their own analysis's.
- **`thumbnails.ts`** — The hybrid between pump.fun's user-chosen art and Polymarket's curated images. Every card starts with the newest user capture. For highlighted markets (top 24 by VI, or ≥ $1,000 traded) the hourly slow refresh finds a canonical image after the fact, copies it into the `captures` bucket under `markets/`, and writes `markets.thumbnail_url`; cards, list rows and the featured hero prefer it, the market page keeps showing the captures. The source follows the entity type: brands take the logo from Wikidata (the article must be about a company or product, so "Apple" finds "Apple Inc." and not the fruit), people the Wikipedia portrait (only when Wikidata says the article is about a human, and never for a name whose article is a disambiguation page), memes and everything else the preview image of the reference page a capture came from (Know Your Meme, fandom wikis, Wikipedia), then the Know Your Meme entry guessed from the name (its slugs are the title), then the Wikipedia lead image unless the article is about an ordinary thing sharing the name or, for a meme, not about internet culture. A page counts only when it is titled with the market's own name (a site's home or search page hands out its logo), a Wikipedia alias match never does, and an image several markets share is a placeholder and is dropped for the screenshot. Logos are drawn whole on a tile whose shade the card picks from the mark itself (`components/LogoImage.tsx`), and portraits are cropped near the top. A market with no image is retried weekly. Never overwrites a `thumbnail_url` whose source is `manual`. The same pass takes the market's description from the same place as the image (the Wikipedia intro, the reference page's summary) into `markets.description`, which the hero and the market page show instead of the newest capture's description of a post; markets outside the highlighted set get theirs from `describe.ts`. `npm run thumbs:backfill` runs a pass now; `--redo` replaces images an earlier pass chose.
- **`og.ts`** — Fetches a link's preview image and title for URL submissions and the share target: YouTube thumbnails directly, TikTok via oEmbed or the page's hydration JSON, everything else from `og:image` with a browser user agent first and Facebook's crawler user agent second (Facebook, Instagram and Threads are tried crawler-first). Login walls and placeholder logos count as no image.
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

The score is total attention. Each source's raw reading is converted to YouTube-view-equivalents a week (`CALIBRATION` in `lib/vi/score.ts`: a fitted worth per unit, with passive views entering sub-linearly), the terms are summed over the sources that answered, and one log maps the total to the level: about 391 points per tenfold, floor 0, no ceiling. 1000 is where the giants sit (Google, Halloween in season), not the top of the scale. Momentum, each source's current window against the market's own 7–14 day baseline, scales the level from 0.65x at a collapse to 1.35x at a 10x spike. Six tiers label the result (Minimal, Moderate, Trending, Viral, Highly viral, Mega-viral from 851). The written score is smoothed with a two-hour half-life, and the liquidation trigger fires on every write, so a method change lands through the smoothing rather than a ramp (`RAMP_MS` is 0 while the platform is unpublished). Nothing read off a screenshot feeds the score, so resubmitting the same image cannot move it. A source that answers "unknown" is left out of the sum; a known zero counts as an answer; a market whose sources all answer unknown keeps its last value.

| Source | Cadence | Reading |
| --- | --- | --- |
| Google Trends | every 5 min | Ratio to a benchmark keyword (`VI_TRENDS_BENCHMARK`) so terms compare across markets; unofficial scraper, quantises small terms. Asks for the subject's **topic** rather than the words when the Wikipedia reading found its id on Wikidata (the Freebase id for entities known before 2016, the Google Knowledge Graph id for newer ones): Google's own disambiguation, so "Cars" the film reads 0.5x the benchmark instead of 8x for the vehicles. A topic Trends does not know reads nothing and falls back to the words in the same pass, remembered as `topic_dead` |
| Bluesky | every 5 min | Posts a day; needs `BLUESKY_IDENTIFIER` and `BLUESKY_APP_PASSWORD` |
| Wikipedia | hourly | Daily pageviews (14-day median, two-day lag). A section redirect under the market's own name counts on the redirect's own views. Also the guard that lets a one-word alias into the other searches, the reading that says whether the bare name is the subject (a qualified match means it is not), and the source of the Trends topic id. For memes, no article reads as unknown rather than zero |
| GDELT | hourly | Share of the day's news stories naming the market, from the Global Knowledge Graph on BigQuery (syndicated copies merged); not the `memes` category; needs `GCP_SA_KEY_B64` |
| YouTube | views hourly, search every 1–3 days | Views in the last 7 days on the videos a name search found, after a title relevance filter (Gemini Flash-Lite, `YT_TITLE_FILTER=0` turns it off); or the verified own channel's views with Shorts discounted, whichever is larger. Needs `YOUTUBE_API_KEY`; search.list has its own bucket of 100 calls a day, so discovery is rationed per market |
| Hacker News | hourly | Hits a day (Algolia); tech and crypto only |
| X | every 3 h per market | Impressions a day on posts about the name: one hour of posts, read two hours later once views have matured, the day's median over reads; or the verified own account's posts' impressions times the own-channel factor, whichever is larger. twitterapi.io, paid per tweet, `X_DAILY_TWEET_BUDGET` per UTC day |
| TikTok | every 3 h per market | Views a day gained under the market's hashtag (Apify hashtag stats; the tag is mapped from the name and aliases and re-checked weekly), a robust trend with a spike gate so vendor noise does not read as a spike; `TIKTOK_DAILY_HASHTAG_BUDGET`, `APIFY_USD_PER_HASHTAG` for the spend estimate |
| DexScreener | hourly | Crypto tokens only; read but not calibrated, so not in the sum |

**Own accounts.** Every source above counts other people talking about a name; a creator's audience is the views on their own uploads, which rarely carry it. `market_handles` holds a market's YouTube channel and X account, resolved automatically and read only once verified; the admin dashboard's Handles tab reviews the rest.

**Scoring state.** A new market is `scoring` (shown as "Scoring…", no trading) until its first full pass over every source, right after the commit or on the next hourly run, at most two hours, then `live`. The go-live write is the reading itself; smoothing starts from there, so nobody sees a number climbing from zero.

**A new market's first day.** The level is a log of the summed attention, so a source that has not answered yet understates the level by its eventual share, and a source without a momentum yet is left out of the momentum average rather than counted as flat.

| After the commit | What lands |
| --- | --- |
| 15–30 s | Wikipedia first, on its own, so the search phrases and the Trends topic are settled before anything else reads; then the first full pass, and the market goes live at that reading. Trends, Bluesky and Wikipedia arrive with level and momentum (their APIs return history); YouTube with its 7-day search views; X with one hour of posts through the Jev filter; GDELT with today's news count; Hacker News for tech and crypto. TikTok gets its hashtag mapped, from the aliases when the bare name is an everyday word, no level yet. The description is written in the same pass, and the YouTube channel resolver runs for people and brands. |
| next hourly run | GDELT backfills 14 days, so its momentum works. A verified own channel is read for the first time. The X account resolver runs a few markets per hour. |
| ~1 h | TikTok's level, from its second read of the hashtag: a young market's mapped tag is read again by whichever pass runs first once an hour has passed, instead of waiting for the three-hour slot. |
| ~4 h | YouTube momentum (three prior hourly deltas). |
| ~12 h | X momentum (four prior three-hourly reads). |
| ~36 h | TikTok momentum: four reads in the last 12 h against four in the same 12 h a day earlier. |

For a person or brand the go-live level is usually within a few points of where it settles. For a meme, TikTok can be half the total, so the level sits about a hundred points low for the first hour. The gap that can matter is a creator whose name nobody writes: the market reads near zero until the own channel or account is verified, automatically when the capture evidence and Wikidata agree, otherwise after the admin decides on the Handles tab.

**Records.** `vi_history` keeps the smoothed and raw score per write, `vi_samples` the per-source raw series the momentum needs (YouTube view totals, X and TikTok reads, own-account reads, the Jev shadow rows), `vi_component_history` a snapshot of each market's breakdown per hourly pass for sixty days, so a calibration can be refitted on any past hour.

**Jev.** TypeSafe AI's Jev answers typed yes/no questions on the gateway with a probability. Since 2026-09-29 it filters X posts for the score (`JEV_TWEETS=on`): only posts it keeps at `JEV_TWEET_KEEP_AT` (default 0.4) count toward the rate and views, a capped read's rate scales by the kept share, and a filtered read compares itself only with filtered samples for the day's median and the momentum baseline. Media-only posts are not judged and stay in; a failed call keeps every post. The threshold came from an adjudication of the shadow data by a stronger model (`npm run jev:adjudicate`): at 0.4 no post about the subject was dropped on 294 live posts. On YouTube titles Jev lost to Gemini (right on 25 % of their disagreements), so `JEV_TITLES` is off in production and Gemini stays the title judge. The admission gate (`JEV_GATE`) stays in shadow: too few creations a day to judge. Each flag is `off | shadow | on`.

**Tuning.** `VI_CALIBRATION_JSON` overrides any calibration constant without a deploy. `npm run vi:calibrate` fits the constants against the hand anchors in `scripts/vi-anchors.ts` or a saved snapshot; `vi:compare` measures a change against the hour before it; `vi:report`, `vi:audit` and `vi:jumps` are the read-only checks (see the app README). `npm run test:vi` runs the pure-math tests.

---

## Database (Supabase)

| Table | Purpose |
| --- | --- |
| `markets` | One row per identified entity. `entity_type`, `category` (ten enum values), `aliases`, `embedding vector(512)`, `current_vi`, `vi_components` (the per-source breakdown), `vi_state` (`scoring` / `live`) and `vi_scoring_since`, `total_captures`, `total_volume_usd`, `thumbnail_url` + source, `description` + source and `description_checked_at`, `parent_market_id` (the subject a meme is about, one level, display only), `created_by` (earns half of every fee), `deleted_at`. Unique on the normalised name among live rows. |
| `captures` | Screenshots + model analysis. FK to `markets`. `content_hash` (unique among live rows: exact dedup), `resolution_status` (`resolved` / `review`), `confidence_score`, `deleted_at`. |
| `submission_drafts` | The review step: one row per proposed submission with the analysis, candidates, routing decision, nudge and the bounded choices; the parked image path; status pending / committed / expired. Server-only. |
| `submission_decisions` | Audit: one row per committed or rejected submission with outcome, market, candidates shown, similarity scores, model confidence, reject reason, latency and the full model response. Admin-readable. |
| `vi_history` | Append-only time series of `(market_id, vi, raw_vi, recorded_at)` powering the sparklines. |
| `vi_samples` | Per-source raw readings over time (`market_id, source, sampled_at, value, meta`): YouTube view totals, X and TikTok reads, own-account reads, the Jev shadow rows. Momentum for those sources is derived from it. Service-role only. |
| `vi_component_history` | One snapshot of a market's breakdown, raw and smoothed score per hourly pass, kept sixty days, for refits and replays. |
| `market_handles` | A market's own platform accounts, one row per platform, with how they were found and whether they are verified; only verified rows feed the score. |
| `blocked_terms` | Names that may not become markets again, filled when an admin retires a market; the capture pipeline rejects a matching proposal. |
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

Permissions: `activeTab`, `scripting`, `storage`, `sidePanel`, host access to `https://*.atnx.app/*` only. A local dev server (`http://localhost`, `http://127.0.0.1`, any port) is an `optional_host_permission`, granted from the panel when an admin saves that URL; no other origins can be used. Host access to the web app keeps the Supabase auth cookie flowing even when third-party cookies are blocked.

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
npm run test:vi                      # the VI math, node:test
npm run vi:report                    # what the last hourly run did: coverage, spend, notable markets
npm run vi:audit                     # every live market's score, breakdown, history coverage and cron health
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
2. Click the toolbar icon to open the side panel, open the gear, and set **Web App URL** to `http://localhost:3000` while developing locally. Chrome will ask to grant the extension access to that origin — accept, or captures can't attach the auth cookie. The field shows only to admins and moderators, so sign in at www.atnx.app with a staff account first (once a local URL is saved it stays visible). Only `*.atnx.app` and `localhost` / `127.0.0.1` are accepted.
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

- The per-source caches and the X and TikTok daily ledgers are in-memory per instance; the ledgers re-read `vi_samples` every few minutes, so a multi-instance deployment overspends by at most that window.
- Tests cover the VI math (`npm run test:vi`, node:test through tsx). `npm run eval:capture` is the regression check for the submission pipeline and the review step; the rest is manual.
- Google Trends has no official API. Rate-limit hiccups surface as an unknown reading and the refresh keeps the market's last value.
- Each free source has a hard ceiling (YouTube's 100 searches a day, Apify's plan limit, the X tweet budget); when one runs out the source goes dark until its window resets and the stored reading stands in for up to two days.
