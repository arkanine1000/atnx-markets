# Architecture at a glance

```
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │  extension   │  │ /app/submit  │  │ Android share│
   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
          │ POST /api/captures/propose (cookie) │ POST /share
          ▼                 ▼                  ▼
   ┌───────────────────────────────────────────────────┐    ┌──────────────────────┐
   │  Next.js @ markets.atnx.app  lib/capture.ts       │───▶│ Supabase (Postgres + │
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
   + the captured posts themselves (TikTok, Instagram, X)
   + the market's own YouTube channel and X account, when verified
                   ▲
                   │ /api/markets/refresh every 5 min, /api/markets/refresh-slow hourly (Vercel Cron)
```

How a submission is decided, stage by stage, is in [`atnx-web/README.md`](../atnx-web/README.md).

On markets.atnx.app the VI crons are not scheduled: production ATNX (atnx.app) computes the VI and writes `vi_history`, and this build reads it.

# Markets on chain

Trading is on chain; there is no simulated exchange in this build.

```
   production ATNX ── vi_history every 5 min ──┐
                                               ▼
   /api/bm/keeper (Vercel Cron, 5 min) ── lib/bm/keeper-run.ts
      ├─ bounded markets (EVM testnets, first iteration): resolve on a bound touch
      └─ rolling rounds (Solana devnet, vi_rounds): create series, ante, open, settle, void
                                               │
                     registry: bm.markets, bm.series, bm.rounds, bm.keeper_log (Supabase)
                                               │
   browser ── wagmi (EVM) / Solana wallet adapter ── signs trades and claims directly
```

The registry says which on-chain market or series belongs to which ATNX market and where each round stands; the money and the positions live in the contracts and program accounts. Mechanics in [rounds.md](rounds.md) and [bounded-markets.md](bounded-markets.md).

# Tech stack

| | |
| --- | --- |
| Framework | Next.js 16.2.2 (App Router, Server Actions, `proxy.ts` — renamed from `middleware.ts` in 16) |
| UI | React 19.2, Tailwind v4, `next-themes`, `recharts` for sparklines |
| Auth + DB | Supabase (Postgres + RLS + Storage + Google + X OAuth), `@supabase/ssr` 0.10 |
| Signals | `google-trends-api`, Wikipedia REST (opensearch + per-article-daily), YouTube Data API, Bluesky, GDELT on BigQuery, twitterapi.io for X, Apify actors for TikTok hashtags and for TikTok and Instagram posts |
| Extension | Manifest V3, in-worker `OffscreenCanvas` cropping, Shadow DOM + Popover API overlay, `chrome.storage.local` for config |
| Models | Vercel AI SDK + AI Gateway: Gemini Flash / Flash-Lite for vision and text, Cohere Embed v4 for embeddings. The extension only ships the cropped image |
| Images | `sharp` for the review step's server-side crop |
| Chains | Solana devnet: Anchor 0.31.1 programs `vi_rounds` and `bounded_vi`, `@coral-xyz/anchor`, `@solana/web3.js`, `@solana/wallet-adapter-react` (Wallet Standard wallets). EVM testnets: Foundry contracts, wagmi + viem. `@tanstack/react-query` for chain reads |
