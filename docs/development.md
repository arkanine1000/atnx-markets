# Local development

## Web app

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

Rolling rounds on Solana devnet ([rounds.md](rounds.md)). None of these are in `.env.local.example` yet:

| Name | Where | Notes |
| --- | --- | --- |
| `BM_ROUNDS_ENABLED` | server only | `1` runs the rounds step of the keeper tick; anything else skips it |
| `BM_SOL_KEEPER_SECRET` | server only | The keeper's Solana key: a JSON array of 64 numbers (`solana-keygen` format) or the same bytes in base58. On devnet it is also the program's authority and treasury |
| `NEXT_PUBLIC_BM_SOL_PROGRAM` | client + server | Program id; defaults to the deployed `vi_rounds` |
| `NEXT_PUBLIC_BM_SOL_USDG` | client + server | The mock USDG mint. Without it the ticket says rounds are not live and the portfolio hides the rounds section |
| `NEXT_PUBLIC_BM_SOL_RPC` | client + server | Devnet RPC; defaults to `https://api.devnet.solana.com` (rate-limited, a keyed provider is better) |
| `NEXT_PUBLIC_BM_MOCK_SOL_WALLET` | client, outside production | A base58 address the ticket treats as connected, read-only, for screenshots without a wallet extension |
| `BM_ROUND_SECS`, `BM_SETTLE_WINDOW_SECS`, `BM_FIRST_PRESALE_SECS` | server only | Daily series: 86400, 1800, 3600 |
| `BM_FAST_ROUND_SECS`, `BM_FAST_SETTLE_WINDOW_SECS`, `BM_FAST_FIRST_PRESALE_SECS` | server only | Fast demo series: 3600, 900, 600 |
| `BM_ANTE_USDG` | server only | The keeper's commit on an empty side, default 10 |
| `BM_SETTLE_DELAY_SECS` | server only | How long after a round's close the keeper settles, default 300 |
| `BM_AUTO_ROLL` | server only | `0` stops the bounded-market keeper from rolling new bounded markets (the first iteration); resolution goes on |

The other bounded-market variables are listed in [bounded-markets.md](bounded-markets.md#operations); `BM_MAX_VI_AGE_MIN` (default 30) is shared: neither a bounded market nor a round opens on an older VI.

## Checking the pipeline

```bash
npm run eval:capture -- --cleanup   # 25 fixtures through the one-shot route, resubmits, then the review cases; needs a running dev server
npm run test:vi                      # the VI math, node:test
npm run vi:report                    # what the last hourly run did: coverage, spend, notable markets
npm run vi:audit                     # every live market's score, breakdown, history coverage and cron health
```

## Checking the markets

```bash
npm run test:bm                      # the pari-mutuel maths (dpm.ts), the settlement rule, the bounded-market tests
npm run rounds:sol -- e2e            # a full rounds series on devnet against the deployed program; no .env.local needed
npm run rounds:start                 # the ten liveliest markets; -- "Name" starts daily rounds, -- <uuid> --fast the demo series
BM_ROUNDS_ENABLED=1 npm run rounds:tick   # one keeper tick, dry (the rounds step runs only with the variable); add -- --live for a real one
npm run bm:keeper:dry                # the same tick as the cron, dry; -- --live for real
```

`cargo test -p vi_rounds --lib` runs the program's math tests on a plain Rust toolchain; CI runs it on every push under `programs/`.

## Seeding trending markets

A fresh database renders the empty state until someone captures something. To fill it with a curated set of currently-trending memes and moments:

```bash
npm run seed:trending              # creates ~10 markets (needs SUPABASE_SERVICE_ROLE_KEY in .env.local)
npm run seed:trending -- --dry-run # fetches the images and writes previews to .seed-preview/, touches nothing
npm run seed:trending -- --user <auth uuid>   # attribute the captures to a user instead of leaving user_id null
```

Each item becomes a `markets` row, one `captures` row (image is the source page's og:image, uploaded to the `captures` bucket, with a generated card as fallback) and a 7-day `vi_history` series shaped to its trend. Markets whose name already exists are skipped, so re-running is safe. The VI refresh cron takes over scoring from there. The list lives in `scripts/seed-trending.mjs`; edit `TRENDING` to swap in whatever is hot.

## Extension

1. `chrome://extensions` → enable **Developer Mode** → **Load unpacked** → select `atnx-extension/`.
2. Click the toolbar icon to open the side panel, open the gear, and set **Web App URL** to `http://localhost:3000` while developing locally. Chrome will ask to grant the extension access to that origin — accept, or captures can't attach the auth cookie. The field shows only to admins and moderators, so sign in at www.atnx.app with a staff account first (once a local URL is saved it stays visible). Only `*.atnx.app` and `localhost` / `127.0.0.1` are accepted.
3. Sign in at your web app URL first so the Supabase auth cookie exists. Then `Ctrl+Shift+X` / `Cmd+Shift+X` to capture.

Change the hotkey at `chrome://extensions/shortcuts`.

## Releasing the extension to the Chrome Web Store

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

# Deployment

- Hosted on **Vercel**, project `atnx-markets`, domain `markets.atnx.app`, Root Directory `atnx-web`. The GitHub integration builds every push: a pull request gets a preview, a push to `main` deploys production. (Until 2026-10-02 the root directory was `.` and only CLI deploys from inside `atnx-web` worked; a `vercel deploy` from inside `atnx-web` now fails, so link at the repository root if a CLI deploy is ever needed.)
- `vercel.json` schedules `/api/bm/keeper` every 5 min (bounded markets, then rounds when `BM_ROUNDS_ENABLED=1`); the VI refresh crons stay on production ATNX, whose history this build reads.
- Solana programs are built on GitHub Actions, never locally: `.github/workflows/solana-build.yml` runs `cargo test -p vi_rounds --lib` on the host toolchain, then `anchor build` for `bounded_vi` and `vi_rounds` with Agave pinned to 4.3.0, and uploads one artifact per program. Deploy from the laptop with `programs/deploy.sh vi_rounds` (needs `gh` and the Solana CLI; pays from `~/.config/solana/devnet.json` unless `PAYER` is set); it deploys the latest green artifact with the committed keypair in `keys/` and copies the IDL and types to `atnx-web/lib/bm/idl/`. Then `npm run rounds:sol -- e2e` checks the deploy, and a commit of the new IDL plus a push to `main` ships it to the site. Details in [programs/README.md](../programs/README.md).
- `next.config.ts` is intentionally empty — all routing/CORS lives in `proxy.ts` and route handlers.
- The extension defaults to `https://atnx.app`; no rebuild needed to switch friends between prod and local.

# Known rough edges

- The per-source caches and the X, TikTok and post-read daily ledgers are in-memory per instance; the ledgers re-read `vi_samples` every few minutes, so a multi-instance deployment overspends by at most that window.
- Tests cover the VI math (`npm run test:vi`, node:test through tsx) and the market maths (`npm run test:bm`, `cargo test -p vi_rounds --lib`). `npm run eval:capture` is the regression check for the submission pipeline and the review step; the rest is manual.
- Google Trends has no official API. Rate-limit hiccups surface as an unknown reading and the refresh keeps the market's last value.
- The local Rust compiler crashes, so nothing on the Solana side builds on the laptop; a program change means a push and a CI round trip before it can be deployed.
- Rounds: the keeper is the oracle and the only key that opens and settles; the faucet and starting a series are open to anyone on devnet; a rollover lands in round N+2; pausing a series ends it. More in [rounds.md](rounds.md#known-limits).
- Each free source has a hard ceiling (YouTube's 100 searches a day, Apify's plan limit, the X tweet budget); when one runs out the source goes dark until its window resets and the stored reading stands in for up to two days.
