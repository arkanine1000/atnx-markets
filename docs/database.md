# Database (Supabase)

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

## RPCs (used via `supabase.rpc(...)`)

`match_markets_by_embedding`, `match_markets_by_name`, `vi_history_series`, `open_position`, `close_position`, `is_admin`, `admin_soft_delete_market`, `admin_restore_market`, `admin_purge_market`, `admin_edit_market_name`, `admin_set_parent_market`, `admin_soft_delete_capture`, `admin_reassign_capture`. (`find_similar_market` still exists but is no longer called.)

Schema changes are numbered SQL files in `atnx-web/supabase/`, applied by hand in order; see that README for the list.

Storage: the `captures` bucket (public) holds capture images under `{user_id}/`, review drafts' parked images under `{user_id}/pending/` (removed on commit or expiry), and curated market images under `markets/{id}/`; public URLs are stored on the rows. Text-only submissions have no image.
