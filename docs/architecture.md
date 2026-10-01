# Architecture at a glance

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

How a submission is decided, stage by stage, is in [`atnx-web/README.md`](../atnx-web/README.md).

# Tech stack

| | |
| --- | --- |
| Framework | Next.js 16.2.2 (App Router, Server Actions, `proxy.ts` — renamed from `middleware.ts` in 16) |
| UI | React 19.2, Tailwind v4, `next-themes`, `recharts` for sparklines |
| Auth + DB | Supabase (Postgres + RLS + Storage + Google + X OAuth), `@supabase/ssr` 0.10 |
| Signals | `google-trends-api`, Wikipedia REST (opensearch + per-article-daily) |
| Extension | Manifest V3, in-worker `OffscreenCanvas` cropping, Shadow DOM + Popover API overlay, `chrome.storage.local` for config |
| Models | Vercel AI SDK + AI Gateway: Gemini Flash / Flash-Lite for vision and text, Cohere Embed v4 for embeddings. The extension only ships the cropped image |
| Images | `sharp` for the review step's server-side crop |
