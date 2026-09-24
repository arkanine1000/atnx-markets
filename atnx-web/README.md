# atnx-web

The ATNX web app: markets for internet culture, fed by screenshots, links and
text that people submit. Next.js App Router on Vercel, Supabase for the
database, auth and storage, and the Vercel AI Gateway for the vision model
and embeddings.

Read `AGENTS.md` before touching Next.js code. 

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

Schema lives in `supabase/` as numbered SQL files, applied by hand in order,
in the Supabase SQL editor or with `npx supabase db query --linked -f <file>`:

| File | What it does |
|---|---|
| `chunk4.sql` | Trigram matcher, `is_admin()`, admin RPCs. Already applied; do not re-run (its index name differs from the live one). |
| `000_baseline.sql` | Snapshot of the live schema as of 2026-09-20. Idempotent; a no-op on the live project. |
| `001_dedup_and_embedding.sql` | `captures.content_hash` with a unique index (exact dedup), `markets.embedding vector(512)`, retrieval functions. |
| `002_taxonomy_and_audit.sql` | `markets.category`, `aliases`, `wikidata_qid`; unique normalised name; `submission_decisions` audit table. Check for duplicate names first (query in the file header). |
| `003_alias_matching.sql` | Name retrieval also scores each market's aliases. |
| `004_vi_components.sql` | `markets.vi_components` (per-source VI breakdown) and `vi_history.raw_vi`. |
| `005_vi_history_series.sql` | `vi_history_series()`: bucketed, median-per-bucket VI history packed as JSON per market, for the portfolio chart's 1D/1W/1M/ALL ranges. Until it is applied the endpoint falls back to the newest 1,000 raw rows per market. |
| `006_trading_integrity.sql` | Trading and profile hardening: `open_position()` / `close_position()` do the accounting atomically and validate size and leverage; users can no longer write `positions` or `sim_balances` directly; `user_profiles.role` changes need an admin; profiles are readable by their owner and admins only. **The trading actions require this migration.** |
| `007_trade_volume.sql` | Trade volume: `open_position()` / `close_position()` add each trade's size to `markets.total_volume_usd` (every open and every close counts once, at size), and the column is backfilled from `positions`. The market page and the leaderboard aggregate `positions` themselves, so they show volume with or without this file. |
| `008_market_thumbnails.sql` | Curated market images: adds `markets.thumbnail_source` and `thumbnail_checked_at` beside the baseline's unused `thumbnail_url`, which the hourly slow refresh now fills for highlighted markets (`lib/thumbnails.ts`). Cards fall back to the newest capture until it is set, so nothing breaks before this file is applied except the curation pass itself. |
| `009_fees_and_liquidation.sql` | Liquidation and trading fees. Realized PnL is floored at −size and a position whose mark reaches that floor is closed by a trigger on `markets.current_vi` (`positions.liquidated`), so a balance can no longer go negative. Every open pays a 1% fee on its size, split half to the market's creator (`markets.created_by`, backfilled from each market's first capture; totalled in `sim_balances.fees_earned_usd`) and half to the one-row `sim_treasury`; `fee_events` is the ledger. **The trading actions, portfolio, leaderboard and market page read the new columns and require this migration.** |
| `010_market_parent.sql` | `markets.parent_market_id`: the subject a market is about (a meme about a person, a variant of a meme), one level deep. Display only: the market page shows the parent on the child and the children on the parent, and nothing in scoring or trading reads it. Set from the admin dashboard's About button (`admin_set_parent_market`); the review step will set it from the subject candidate it offered. **The market page and the admin dashboard select the column and require this migration.** |
| `011_submission_drafts.sql` | The review step's drafts: one row per proposed submission, holding the model's analysis, the candidates, the routing decision and the bounded choices the submitter may pick from; the parked image lives under `{user}/pending/` in the `captures` bucket. Expired drafts are marked and their images dropped by the hourly refresh. Server-only (RLS on, no policies). **`/api/captures/propose`, `/commit` and `/recrop` require this migration.** |
| `012_market_description.sql` | `markets.description` and `description_source`: the market's own summary, filled by the thumbnail job from the same place it took the image (the Wikipedia intro, the reference page's summary). The hero and the market page header show it instead of the newest capture's description, which describes that post rather than the subject. `manual` is never overwritten. **The hero and market page select the column and require this migration.** |
| `013_purge_market.sql` | `admin_purge_market()`: permanent deletion of a soft-deleted market from the admin dashboard (the Purge button on deleted rows). Removes the market, its captures and VI history and returns the image URLs so the server action can delete the files; refuses a live market or one with trades on record, since positions and fees cascade. |
| `014_handles_fixed.sql` | Handles are fixed: one trigger guards both `role` and `handle` on `user_profiles` (replaces the 006 role guard), so a self-edit of the handle is refused at the table; the settings page shows it read-only. Admins may still change one from the SQL editor. |
| `016_vi_samples.sql` | `vi_samples`: per-source raw readings over time (YouTube view totals hourly; later the X and TikTok series), from which `lib/vi/youtube.ts` derives momentum between samples of the same video set. Service-role only. **The YouTube source writes to it on every hourly run and requires this migration; without it the source still reports a level but never a momentum.** |

After a migration, update `lib/supabase/database.ts` by hand to match. After
`001`, run `npm run backfill:embeddings` once so markets that predate it get a
vector; without one, cosine retrieval cannot find them.

## How a submission is handled

`lib/capture.ts` is the pipeline, in two halves. **Propose** runs steps 1
to 5 below and, instead of saving anything, stores a draft
(`submission_drafts`, `lib/review.ts`) and parks the image. The submitter
then sees the review screen: `/app/submit/review/<draft>` on the web (the
form and the Android share target both land there) or the compact version
in the extension's side panel. **Commit** takes the draft and the person's
choice, validated against what the draft offered, and runs the tail:
attach or create, upload, audit, then the VI scoring after the response.
Drafts expire after fifteen minutes.

The review screen nudges toward existing markets. A strong match (the
pipeline would have linked on its own) is the default with "this is
something else" as a quiet override, audited and closed to accounts under
a day old. When the model names the *subject* the content is about (a
mugshot meme is about the person, a fan edit is about the show) and that
subject has a market, adding to it is the default; creating the meme's own
market is the secondary option and may mark it as about the subject
(`markets.parent_market_id`). In the band below the link thresholds the
close markets are shown and the person picks. Nothing on the screen is free
text: the name comes from the model's proposal and up to two alternates,
type and category from the fixed enums, aliases can only be dropped, and
the crop is a rectangle the server applies to its own copy of the image
(two re-crops per draft, each one more model call). Market creation is
capped per account per day (`MARKET_CREATE_DAILY_LIMIT`, default 10; admins and
moderators are exempt, as is any account listed in `MARKET_CREATE_LIMIT_EXEMPT`).

`/api/captures` (POST) is the one-shot path: propose and commit the
default choice in one call, with the confirm call of step 4 kept there. The
eval script uses it. `scripts/review-probe.ts` walks the review endpoints
against a running app.

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
   neighbour is linked instead of created. In the band below that, the
   reviewer sees the candidates (on the one-shot path, one text-only model
   call is shown them and decides instead). The model also names the
   subject the content is about, which is resolved against existing
   markets by name.
5. Route (`lib/route.ts`): rejected, matched, linked, created, or created
   with a review flag when the model's confidence was low. Rejections are
   final and skip review; everything else becomes a draft here. On commit
   the decision is written to `submission_decisions` (an override of a
   strong match lands as `created_review` with the overridden market in
   `model_response`), the capture is saved and the response goes out with
   `viPending: true`.
6. After the response (`after()` from `next/server`): on the one-shot path a
   low-confidence create gets one retry with a wider candidate list, then the market is
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
| `npm run eval:capture` | Posts the fixtures in `scripts/fixtures/` through the one-shot route and checks each expected outcome, then resubmits to check dedup; then the review cases (manifest `review`) through `/api/captures/propose`, checking the nudge tier, the markets offered, the default choice and the create options, plus one re-crop. Review drafts are never committed. `--review-only`, `--no-review`, `--cleanup`. Needs `EVAL_*` variables in `.env.local` and a running server. Run after any change to the pipeline, the prompt or the thresholds. |
| `npm run fixtures:render` | Regenerates the fixture images from `scripts/fixtures/manifest.json`. |
| `npm run backfill:embeddings` | Embeds every live market without a vector. Run once after migration `001` and after any bulk seed. |
| `npm run categories:backfill [--dry-run]` | Files every live market without a `category` into one of the ten enum values with one text-model call each. Run after any seed that inserts markets without one; `--dry-run` prints the proposals. |
| `npm run seed:trending` | Seeds a fresh database with a hand-curated set of markets. |
| `npm run thumbs:backfill [n] [--redo]` | Curates images for up to `n` (default 100) highlighted markets now, the same pass the hourly slow refresh runs a dozen at a time. `--redo` also replaces images an earlier pass chose (never one marked `manual`). Needs migration `008`. |

## Layout

- `app/` routes. `app/app/` is the signed-in product; `app/app/submit/` is
  the web entry form; `app/admin/` is the moderation dashboard.
- `lib/` server code. `capture.ts`, `capture-request.ts`, `vlm.ts`,
  `embed.ts`, `retrieve.ts`, `route.ts`, `review.ts`, `store.ts` are the
  submission path; `signals.ts` and `vi/` compute the virality index;
  `thumbnails.ts` curates images and descriptions; `waitlist.ts` takes the
  landing page's signups.
- `components/` shared UI. `supabase/` schema. `scripts/` eval and seeding.
- `../atnx-extension/` is the Chrome extension that posts to `/api/captures/propose`
  and commits from its side panel.
