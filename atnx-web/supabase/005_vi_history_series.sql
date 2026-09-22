-- 005_vi_history_series.sql
--
-- Bucketed VI history for the portfolio chart. The fast refresh appends a
-- point per live market every five minutes, so a month of one market is
-- ~8,600 rows and PostgREST's 1,000-row cap silently truncates a plain
-- select. This function reduces each market to one median per bucket and
-- returns a single row per market with the points packed as JSON, so the
-- row cap never applies and one call covers every open position.
--
-- points: [[epoch_ms, vi], ...] ordered by time, bucket start as the time.
-- The median (not the mean) is what a single stray sample cannot move.
--
-- Idempotent.

create or replace function public.vi_history_series(
  market_ids uuid[],
  since timestamptz,
  bucket_seconds int
)
returns table (market_id uuid, points jsonb)
language sql
stable
security invoker
set search_path = public
as $$
  select
    b.market_id,
    jsonb_agg(jsonb_build_array(b.t, round(b.vi::numeric, 2)) order by b.t) as points
  from (
    select
      h.market_id,
      (floor(extract(epoch from h.recorded_at) / greatest(bucket_seconds, 1))
        * greatest(bucket_seconds, 1))::bigint * 1000 as t,
      percentile_cont(0.5) within group (order by h.vi::double precision) as vi
    from public.vi_history h
    where h.market_id = any(market_ids)
      and h.recorded_at >= since
    group by h.market_id, 2
  ) b
  group by b.market_id;
$$;
