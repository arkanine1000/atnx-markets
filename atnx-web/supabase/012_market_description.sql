-- 012_market_description.sql
--
-- A market's own one-paragraph description, to caption the curated image.
-- Cards and the hero used to show the newest capture's description, which
-- describes that post ("a Google Search knowledge panel showing...") and
-- reads wrong under the company's logo. The thumbnail job (lib/thumbnails.ts)
-- fills this from the same place it took the image: the Wikipedia article's
-- intro for a brand, person or subject article, the reference page's own
-- summary for a Know Your Meme or wiki entry. The hero prefers it when set;
-- captures keep their own descriptions on the market page's Pulse list.
--
-- description_source names where it came from ('wikipedia',
-- 'page:<host>'); 'manual' marks one written by hand, which the job never
-- overwrites.
--
-- Idempotent.

alter table public.markets
  add column if not exists description text,
  add column if not exists description_source text;

comment on column public.markets.description is
  'The market''s own summary, shown under the curated image. Filled by lib/thumbnails.ts; manual when description_source is manual.';
comment on column public.markets.description_source is
  'Where description came from: wikipedia, page:<host>, or manual (never overwritten).';
