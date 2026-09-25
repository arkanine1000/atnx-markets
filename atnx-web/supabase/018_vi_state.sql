-- 018_vi_state.sql
--
-- A new market's first score used to be written from whichever sources
-- answered within a minute of its creation (TikTok, GDELT and creator
-- channels only arrive with the hourly refresh) and then drift for hours
-- as the rest came in, so the first number anyone saw was the least
-- reliable one, and it was tradable. A market is now `scoring` from its
-- creation until one full pass over every source has run (right after
-- the commit; else the next hourly refresh; at most two hours), and
-- `live` after. While scoring the page shows "Scoring..." instead of a
-- number, and no position can be opened; closing is never blocked.
--
-- Existing rows are live (the column default). lib/store.ts createMarket
-- inserts `scoring`.
--
-- Idempotent.

alter table public.markets
  add column if not exists vi_state text not null default 'live',
  add column if not exists vi_scoring_since timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'markets_vi_state_check') then
    alter table public.markets add constraint markets_vi_state_check check (vi_state in ('scoring', 'live'));
  end if;
end $$;

-- No new position on a market that is still being scored. A trigger on
-- positions rather than a change to open_position (supabase/009), so the
-- trading function stays as it is; the raise rolls back the whole open.
create or replace function public.positions_require_live_market()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.markets where id = new.market_id and vi_state = 'scoring') then
    raise exception 'Market is still being scored';
  end if;
  return new;
end $$;

drop trigger if exists positions_require_live_market on public.positions;
create trigger positions_require_live_market
  before insert on public.positions
  for each row execute function public.positions_require_live_market();

comment on column public.markets.vi_state is
  'scoring until a first full pass over every VI source has run (at most two hours), then live; no positions open while scoring';
