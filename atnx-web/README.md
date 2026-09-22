# atnx-web

The ATNX web app: markets for internet culture, fed by screenshots, links and
text that people submit. Next.js App Router on Vercel, Supabase for the
database, auth and storage, and the Vercel AI Gateway for the vision model
and embeddings.

Read `AGENTS.md` before touching Next.js code. This version has breaking
changes; the docs that match it are in `node_modules/next/dist/docs/`.

## Run it

```bash
npm install
cp .env.local.example .env.local   # fill in the values
npm run dev
```

Environment variables are documented in `.env.local.example`. On Vercel the
gateway authenticates with OIDC, so `AI_GATEWAY_API_KEY` is only needed
locally.

## Database

Schema lives in `supabase/` as numbered SQL files, applied by hand in the
Supabase SQL editor, in order:

| File | What it does |
|---|---|
| `chunk4.sql` | Trigram matcher, `is_admin()`, admin RPCs. Already applied; do not re-run (its index name differs from the live one). |
| `000_baseline.sql` | Snapshot of the live schema as of 2026-09-20. Idempotent; a no-op on the live project. |
| `001_dedup_and_embedding.sql` | `captures.content_hash` with a unique index (exact dedup), `markets.embedding vector(512)`, retrieval functions. |
| `002_taxonomy_and_audit.sql` | `markets.category`, `aliases`, `wikidata_qid`; unique normalised name; `submission_decisions` audit table. Check for duplicate names first (query in the file header). |
| `003_alias_matching.sql` | Name retrieval also scores each market's aliases. |
| `004_vi_components.sql` | `markets.vi_components` (per-source VI breakdown) and `vi_history.raw_vi`. |
| `005_vi_history_series.sql` | `vi_history_series()`: bucketed, median-per-bucket VI history packed as JSON per market, for the portfolio chart's 1D/1W/1M/ALL ranges. Until it is applied the endpoint falls back to the newest 1,000 raw rows per market. |

After a migration, update `lib/supabase/database.ts` by hand to match. After
`001`, run `npm run backfill:embeddings` once so markets that predate it get a
vector; without one, cosine retrieval cannot find them.

## How a submission is handled

`lib/capture.ts` is the pipeline. Both `/api/captures` (extension, web
form) and `/share` (Android share target) call it.

1. Hash the submission (image bytes, normalised URL, or normalised text).
   A hit in `captures.content_hash` returns the earlier answer with no model
   call.
2. Embed the page title and any text (`lib/embed.ts`), retrieve the nearest
   markets by cosine and by trigram on the name (`lib/retrieve.ts`).
3. One model call through the gateway with those candidates
   (`lib/vlm.ts`). Gemini Flash for images, Flash-Lite for text. The output is
   validated against a schema: admit or reject with a reason, match a shown
   candidate, or propose a new market with a name, type, category and
   aliases.
4. If the model proposed a new market, embed its name and description and
   check again, name and aliases against names and aliases. A close enough
   neighbour is linked instead of created. In the band below that, one
   text-only model call is shown the candidates and decides.
5. Route (`lib/route.ts`): rejected, matched, linked, created, or created
   with a review flag when the model's confidence was low. Every decision is
   written to `submission_decisions`. The capture is saved and the response
   goes out here, with `viPending: true`.
6. After the response (`after()` from `next/server`): a low-confidence
   create gets one retry with a wider candidate list, then the market is
   scored from every VI source (`lib/signals.ts`) and one `vi_history`
   point is recorded. If this is cut off, the five-minute refresh scores
   the market on its next pass.

Model ids and link thresholds can be overridden per environment; see
`.env.local.example`. Thinking is turned off with Gemini's own provider
option, not the SDK's portable `reasoning` setting, which the gateway
ignores for Gemini 3.x (measured: 18 s and truncated JSON versus 2.6 s).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` / `lint` | The usual. |
| `npm run eval:capture` | Posts the fixtures in `scripts/fixtures/` through the real route and checks each expected outcome, then resubmits to check dedup. Needs `EVAL_*` variables in `.env.local` and a running server. Run after any change to the pipeline. |
| `npm run fixtures:render` | Regenerates the fixture images from `scripts/fixtures/manifest.json`. |
| `npm run backfill:embeddings` | Embeds every live market without a vector. Run once after migration `001` and after any bulk seed. |
| `npm run seed:trending` | Seeds a fresh database with a hand-curated set of markets. |

## Layout

- `app/` routes. `app/app/` is the signed-in product; `app/app/submit/` is
  the web entry form; `app/admin/` is the moderation dashboard.
- `lib/` server code. `capture.ts`, `vlm.ts`, `embed.ts`, `retrieve.ts`,
  `route.ts`, `store.ts` are the submission path; `signals.ts` and `vi/`
  compute the virality index.
- `components/` shared UI. `supabase/` schema. `scripts/` eval and seeding.
- `../atnx-extension/` is the Chrome extension that posts to `/api/captures`.
