-- 022_description_checked.sql
--
-- Every market gets a description, not only the highlighted ones the
-- image job curates. lib/describe.ts fills markets.description for the
-- rest from the market's own Wikipedia article, its Know Your Meme entry,
-- a capture's reference page, or, failing those, one line from the text
-- model (description_source 'model', which an admin may overwrite; a
-- reference page found later replaces it, 'manual' is never touched).
-- This column records the last look, so a market with nothing to say is
-- retried weekly rather than every hour.
--
-- Idempotent.

alter table public.markets
  add column if not exists description_checked_at timestamptz;

comment on column public.markets.description_checked_at is
  'When lib/describe.ts last looked for a description; retried weekly while none is found.';
