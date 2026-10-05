-- bm/002_rounds.sql
--
-- Rolling VI rounds (the second iteration of the hackathon build, on
-- Solana devnet). A subject's rounds run back to back: while round N
-- trades, round N+1 takes presale commits. Each round asks whether the
-- subject's VI, averaged over the last minutes of the round, ends at or
-- above the VI at the round's open.
--
--   bm.series  one row per subject, chain and speed (daily or the fast
--              hourly demo): the on-chain series account, who started it
--              (the finder), the round length, the settlement window and
--              the ante the keeper commits on an empty side.
--   bm.rounds  one row per round of a series: presale, opening, live,
--              settling, settled or void, with the target VI at the open,
--              the settlement average and the winner.
--
-- Like 001, this is the registry, not the ledger: commits, shares and
-- payouts are accounts in the `vi_rounds` program. The keeper moves a row
-- through its states with compare-and-set updates; `opening` and
-- `settling` mark a transaction in flight, and the next tick reconciles
-- them from the chain if a run dies in between. No foreign key to
-- public.markets (see 001's header).
--
-- Also: keeper_log rows can point at a series and a round, and
-- bm.markets gets the opened_by_wallet column the live database already
-- has but no migration created.
--
-- Idempotent.

create table if not exists bm.series (
  id                  uuid primary key default gen_random_uuid(),
  -- public.markets.id, kept as a plain uuid on purpose.
  atnx_market_id      uuid not null,
  chain               text not null default 'solana:devnet',
  program_id          text not null,
  -- The 32-byte series reference, hex. Seeds the series PDA.
  reference           text not null,
  series_pubkey       text,
  -- The wallet that started the series; it earns the finder's share of
  -- the fees. finder_user_id is the atnx user behind the market, if any.
  finder_wallet       text not null,
  finder_user_id      uuid,
  round_secs          integer not null default 86400 check (round_secs > 0),
  settle_window_secs  integer not null default 1800 check (settle_window_secs > 0),
  first_presale_secs  integer not null default 3600 check (first_presale_secs >= 0),
  fee_bps             integer not null default 100 check (fee_bps between 0 and 10000),
  finder_bps          integer not null default 2000 check (finder_bps between 0 and 10000),
  ante_usdg           numeric not null default 10 check (ante_usdg >= 0),
  -- The hourly demo series, labelled as such everywhere.
  fast                boolean not null default false,
  state               text not null default 'pending'
                      check (state in ('pending', 'active', 'paused', 'ended', 'failed')),
  create_tx           text,
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (settle_window_secs < round_secs)
);

-- One running series per atnx market, chain and speed.
create unique index if not exists bm_series_one_active
  on bm.series (atnx_market_id, chain, fast)
  where state in ('pending', 'active', 'paused');
create index if not exists bm_series_state_idx on bm.series (state);
create index if not exists bm_series_atnx_idx on bm.series (atnx_market_id);

create table if not exists bm.rounds (
  id                  uuid primary key default gen_random_uuid(),
  series_id           uuid not null references bm.series(id) on delete cascade,
  -- The on-chain round index, from 1.
  idx                 integer not null check (idx > 0),
  round_pubkey        text,
  state               text not null default 'presale'
                      check (state in ('presale', 'opening', 'live', 'settling', 'settled', 'void', 'failed')),
  -- When the keeper may open the round (the previous round's close, or
  -- the series start plus the first presale).
  opens_at            timestamptz not null,
  opened_at           timestamptz,
  close_at            timestamptz,
  -- Trading stops a settlement window before the close.
  trade_until         timestamptz,
  target_vi           numeric,
  settle_vi           numeric,
  settle_prints       integer,
  winner              text check (winner in ('up', 'down')),
  presale_up_usdg     numeric,
  presale_down_usdg   numeric,
  -- The keeper's own commit on an empty side (both, when nobody came).
  ante_side           text check (ante_side in ('up', 'down', 'both')),
  ante_usdg           numeric,
  open_tx             text,
  settle_tx           text,
  void_tx             text,
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (series_id, idx)
);

-- One round in flight or live per series, one presale per series.
create unique index if not exists bm_rounds_one_live
  on bm.rounds (series_id)
  where state in ('opening', 'live', 'settling');
create unique index if not exists bm_rounds_one_presale
  on bm.rounds (series_id)
  where state = 'presale';
create index if not exists bm_rounds_due on bm.rounds (state, close_at);

alter table bm.keeper_log add column if not exists series_id uuid references bm.series(id) on delete cascade;
alter table bm.keeper_log add column if not exists round_id uuid references bm.rounds(id) on delete cascade;
create index if not exists bm_keeper_log_series_idx on bm.keeper_log (series_id);

alter table bm.markets add column if not exists opened_by_wallet text;

-- Everyone may read; only the service role writes.
alter table bm.series enable row level security;
alter table bm.rounds enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'bm' and tablename = 'series' and policyname = 'bm_series_public_read') then
    create policy bm_series_public_read on bm.series for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'bm' and tablename = 'rounds' and policyname = 'bm_rounds_public_read') then
    create policy bm_rounds_public_read on bm.rounds for select to anon, authenticated using (true);
  end if;
end $$;

grant select on bm.series, bm.rounds to anon, authenticated;
grant all on bm.series, bm.rounds to service_role;

notify pgrst, 'reload schema';
