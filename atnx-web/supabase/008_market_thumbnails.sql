-- 008_market_thumbnails.sql
--
-- Curated market images. Cards show the newest user capture by default;
-- for the markets people see first (top of the board by VI, or with real
-- trade volume) the hourly slow refresh looks up a cleaner image after the
-- fact (lib/thumbnails.ts) and stores it in markets.thumbnail_url, a column
-- the baseline created but nothing wrote. The two columns here record where
-- that image came from and when the market was last looked at, so a market
-- with no image available is retried weekly rather than hourly.
--
-- A thumbnail_url set by hand is never overwritten: set thumbnail_source to
-- 'manual' with it and the job leaves the row alone. Its own values name
-- the strategy that found the image: 'wikidata:logo', 'wikipedia:lead',
-- 'page:<host>' (the reference page a capture came from).
--
-- Idempotent.

alter table public.markets
  add column if not exists thumbnail_source text,
  add column if not exists thumbnail_checked_at timestamptz;

comment on column public.markets.thumbnail_url is
  'Curated image for cards and the featured hero; falls back to the newest capture when null.';
comment on column public.markets.thumbnail_source is
  'Where thumbnail_url came from: wikidata:logo, wikipedia:lead, page:<host>, or manual (never overwritten).';
comment on column public.markets.thumbnail_checked_at is
  'When lib/thumbnails.ts last looked for an image, set or not.';
