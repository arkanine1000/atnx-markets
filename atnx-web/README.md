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
in the Supabase SQL editor or with `npx supabase db query --linked -f <file>`.
The simulated-trading tables (`positions`, `sim_balances`, `sim_treasury`,
`fee_events`) and the functions from 006, 007, 009 and 019 are legacy:
trading moved on-chain in the hackathon build; see the repository README.
The app no longer reads them, apart from the sign-in callback creating a
`sim_balances` row and the admin purge RPC.

| File | What it does |
|---|---|
| `chunk4.sql` | Trigram matcher, `is_admin()`, admin RPCs. Already applied; do not re-run (its index name differs from the live one). |
| `000_baseline.sql` | Snapshot of the live schema as of 2026-09-20. Idempotent; a no-op on the live project. |
| `001_dedup_and_embedding.sql` | `captures.content_hash` with a unique index (exact dedup), `markets.embedding vector(512)`, retrieval functions. |
| `002_taxonomy_and_audit.sql` | `markets.category`, `aliases`, `wikidata_qid`; unique normalised name; `submission_decisions` audit table. Check for duplicate names first (query in the file header). |
| `003_alias_matching.sql` | Name retrieval also scores each market's aliases. |
| `004_vi_components.sql` | `markets.vi_components` (per-source VI breakdown) and `vi_history.raw_vi`. |
| `005_vi_history_series.sql` | `vi_history_series()`: bucketed, median-per-bucket VI history packed as JSON per market, for the charts' 1D/1W/1M/ALL ranges. Until it is applied the endpoint falls back to the newest 1,000 raw rows per market. |
| `006_trading_integrity.sql` | Trading and profile hardening: `open_position()` / `close_position()` do the accounting atomically and validate size and leverage; users can no longer write `positions` or `sim_balances` directly; `user_profiles.role` changes need an admin; profiles are readable by their owner and admins only. |
| `007_trade_volume.sql` | Trade volume: `open_position()` / `close_position()` add each trade's size to `markets.total_volume_usd` (every open and every close counts once, at size), and the column is backfilled from `positions`. |
| `008_market_thumbnails.sql` | Curated market images: adds `markets.thumbnail_source` and `thumbnail_checked_at` beside the baseline's unused `thumbnail_url`, which the hourly slow refresh now fills for highlighted markets (`lib/thumbnails.ts`). Cards fall back to the newest capture until it is set, so nothing breaks before this file is applied except the curation pass itself. |
| `009_fees_and_liquidation.sql` | Liquidation and trading fees. Realized PnL is floored at −size and a position whose mark reaches that floor is closed by a trigger on `markets.current_vi` (`positions.liquidated`), so a balance can no longer go negative. Every open pays a 1% fee on its size, split half to the market's creator (`markets.created_by`, backfilled from each market's first capture; totalled in `sim_balances.fees_earned_usd`) and half to the one-row `sim_treasury`; `fee_events` is the ledger. |
| `010_market_parent.sql` | `markets.parent_market_id`: the subject a market is about (a meme about a person, a variant of a meme), one level deep. Display only: the market page shows the parent on the child and the children on the parent, and nothing in scoring or trading reads it. Set from the admin dashboard's About button (`admin_set_parent_market`); the review step will set it from the subject candidate it offered. **The market page and the admin dashboard select the column and require this migration.** |
| `011_submission_drafts.sql` | The review step's drafts: one row per proposed submission, holding the model's analysis, the candidates, the routing decision and the bounded choices the submitter may pick from; the parked image lives under `{user}/pending/` in the `captures` bucket. Expired drafts are marked and their images dropped by the hourly refresh. Server-only (RLS on, no policies). **`/api/captures/propose`, `/commit` and `/recrop` require this migration.** |
| `012_market_description.sql` | `markets.description` and `description_source`: the market's own summary, filled by the thumbnail job from the same place it took the image (the Wikipedia intro, the reference page's summary). The hero and the market page header show it instead of the newest capture's description, which describes that post rather than the subject. `manual` is never overwritten. **The hero and market page select the column and require this migration.** |
| `013_purge_market.sql` | `admin_purge_market()`: permanent deletion of a soft-deleted market from the admin dashboard (the Purge button on deleted rows). Removes the market, its captures and VI history and returns the image URLs so the server action can delete the files; refuses a live market or one with trades on record, since positions and fees cascade. |
| `014_handles_fixed.sql` | Handles are fixed: one trigger guards both `role` and `handle` on `user_profiles` (replaces the 006 role guard), so a self-edit of the handle is refused at the table; the settings page shows it read-only. Admins may still change one from the SQL editor. |
| `015_waitlist.sql` | `waitlist`: the landing page's signups, one row per lowercased address, written by the server from `/api/waitlist`, read by admins. |
| `016_vi_samples.sql` | `vi_samples`: per-source raw readings over time (YouTube view totals hourly; later the X and TikTok series), from which `lib/vi/youtube.ts` derives momentum between samples of the same video set. Service-role only. **The YouTube source writes to it on every hourly run and requires this migration; without it the source still reports a level but never a momentum.** |
| `017_market_handles.sql` | `market_handles`: a creator market's own platform accounts, one row per platform, resolved automatically (`lib/creators/resolve.ts`, `store.ts`); only `verified` rows feed the creator-reach reading (`lib/creators/channel.ts`). Admins read it and decide review candidates on the dashboard's Handles tab. **Applied 2026-09-25.** |
| `018_vi_state.sql` | `markets.vi_state` (`scoring` / `live`) and `vi_scoring_since`: a new market is `scoring` until its first full pass over every source (right after the commit, else the next slow refresh, at most two hours), shown as "Scoring…" with no trading; a trigger on `positions` refuses an open on a scoring market. Existing rows are `live`. **`lib/store.ts` selects the column, so apply this before deploying code that reads it.** |
| `020_vi_component_history.sql` | `vi_component_history`: one snapshot per market per hourly run of the per-source breakdown, raw and smoothed score, pruned after sixty days, so a calibration can be refitted on any past hour (`npm run vi:calibrate`, `vi:compare`). The writer tolerates a missing table. **Applied 2026-09-27.** |
| `022_description_checked.sql` | `markets.description_checked_at`: when `lib/describe.ts` last looked for a description, so a market with nothing to say is retried weekly rather than hourly. **Applied 2026-09-29.** |
| `021_blocked_terms.sql` | `blocked_terms`: names an admin retired (the dashboard's Retire button) may not become markets again; `lib/blocklist.ts` rejects a matching proposal. Seeded with "November 2026". **Applied 2026-09-28.** |
| `019_purge_with_trades.sql` | `admin_purge_market()` takes `with_trades`: the dashboard's Purge asks, when a market has trades on record, whether to delete them too. The trades are unwound from every account as if they never happened (open stakes and fees refunded, realized PnL reversed, creator and treasury fee shares taken back) before the positions and `fee_events` rows go. Replaces the two-argument function from 013; a plain purge works with or without it. **Applied 2026-09-25.** |

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
   aliases. A subject whose canonical name is an everyday word or shared
   with other well-known things is named with a qualifier, "Cars (2006
   film)", "Wednesday (TV series)", with the bare name among the aliases;
   the sources then search the aliases and Trends its topic, never the
   bare word.
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
| `npm run vi:audit [--json]` | Read-only audit of every live market's VI: score and tier, each source's stored level, momentum and age, `vi_history` coverage and ranges over 24 h and 7 d, the largest one-hour moves, aliases and the Wikipedia title behind the generic-term guard, cron health per hour over 48 h, and the tier spread. `--json` for a diff against an earlier run. |
| `npm run vi:jumps [threshold]` | Moves larger than the threshold (default 200) within one hour over the last 7 days, smoothed and raw, with each market's first point and peak. Steps cluster at calculation changes and slow-refresh writes. |
| `npm run vi:report [since]` | What the last slow run (or any run since a given time) did: per-source coverage, tier spread, GDELT health, X and TikTok spend from `vi_samples`, and the top and notable markets with breakdowns. `VI_REPORT_NOTABLE` overrides the notable list. |
| `npm run vi:probe "term"` | Reads every source for a term now and prints the breakdown and the combined score, without writing anything. |
| `npm run vi:calibrate [--apply] [--anchors=file] [--q=]` | Fits the calibration constants (worth per unit, points per decade, zero point) against the hand anchors in `scripts/vi-anchors.ts` or a saved snapshot, and prints each market's current, fitted and target score. `--apply` writes the constants into `lib/vi/score.ts`. |
| `npm run vi:compare -- <iso time> [hours]` | Measures a change: each market's score before and after the given time, anchor RMSE and rank correlation, the largest moves. |
| `npm run vi:titles -- "Market"` | Runs the YouTube title relevance filter on a market's stored video set and prints what it keeps and drops. |
| `npm run jev:backtest` | Replays past create proposals and the blocklist's synthetic generics through the Jev admission gate and prints the verdicts, thresholds and latencies. |
| `npm run jev:adjudicate [--titles] [--tweets] [--live=15] [--sample=600] [--out=dir]` | Has a stronger model on the gateway label the Jev shadows: the title disagreements the YouTube shadow stored, a sample of the posts the X shadow dropped or kept unsure, and one fresh X page per busy market judged with full text. Reports each judge's agreement with the adjudicator and, for posts, drop precision and lost views at every keep threshold; writes a 30-item spot check. Ran 2026-09-29 to set `JEV_TWEET_KEEP_AT`. |
| `npm run vi:topic-shift -- <isoBoundary>` | What a change to the search phrases or the Trends topic did, before the smoothing: scores each market's last hourly snapshot before the boundary and its live breakdown with the same formula and prints the Trends ratio and share before and after, the raw change, the rank correlation and the tier moves. |
| `npm run jev:simulate-x [--hours=24]` | The board with the X post filter on, from the counterfactual impressions the shadow recorded on every read, at the current calibration: rank correlation, tier changes and the largest moves. |
| `npm run test:vi` | The pure-math tests under `lib/vi/`, `lib/creators/` and `lib/` (node:test through tsx). Run after any change to scoring. |
| `npm run creators:resolve` | Runs the creator handle resolver over person and brand markets now, the pass the hourly run does a few markets at a time. |
| `npm run aliases:backfill` | Fills aliases on markets that have none, one text-model call each. |

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
  and commits from its side panel. Trading moved on-chain in the hackathon
  build; see the repository README.
