-- Virality Index aggregate: persist the per-source breakdown behind each
-- market's score, and keep the unsmoothed reading next to the smoothed one.
-- Both columns are nullable with no default, so this is a catalog-only
-- change with no table rewrite.

alter table public.markets
  add column if not exists vi_components jsonb;

comment on column public.markets.vi_components is
  'Latest per-source VI breakdown: {trends|bluesky|gdelt|wikipedia: {level, momentum, fetchedAt, meta}}';

alter table public.vi_history
  add column if not exists raw_vi numeric;

comment on column public.vi_history.raw_vi is
  'Composite before EMA smoothing; vi is the smoothed value shown on charts';
