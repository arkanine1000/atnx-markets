-- bm/001_schema.sql
--
-- Bounded VI markets (the hackathon build). Everything this build stores
-- lives in its own schema, `bm`, next to the production tables it reads
-- (markets.current_vi, vi_history). Nothing here touches `public`: no
-- foreign key to public.markets (an admin purge on atnx.app must never be
-- blocked by a hackathon row; the registry keeps the uuid and resolves
-- the name at read time), no trigger on public.markets (resolution is the
-- keeper's job, since the VI has to be posted on-chain anyway).
--
-- Positions are not here. They are wallet balances in the contract. This
-- schema is the registry of which atnx market has which on-chain market,
-- with what bounds, in which state, plus the keeper's log.
--
-- The schema must be listed under "Exposed schemas" in the project's API
-- settings before supabase-js can read it (.schema('bm')); without that
-- every call fails with PGRST106.
--
-- Idempotent.

create schema if not exists bm;
grant usage on schema bm to anon, authenticated, service_role;

create table if not exists bm.markets (
  id                 uuid primary key default gen_random_uuid(),
  -- public.markets.id, kept as a plain uuid on purpose (see header).
  atnx_market_id     uuid not null,
  -- CAIP-2 style: 'eip155:46630' (Robinhood Testnet), 'eip155:421614'
  -- (Arbitrum Sepolia), later 'solana:devnet'.
  chain              text not null,
  contract_address   text not null,
  -- uint256 as decimal text on EVM; a pubkey on Solana.
  onchain_market_id  text,
  start_vi           numeric not null,
  lower_bound        numeric not null,
  upper_bound        numeric not null,
  seed_usdg          numeric not null,
  initial_up_bps     integer not null default 5000,
  state              text not null default 'pending'
                     check (state in ('pending', 'open', 'resolving', 'resolved', 'failed')),
  resolved_side      text check (resolved_side in ('up', 'down')),
  resolved_vi        numeric,
  resolved_at        timestamptz,
  create_tx          text,
  created_block      bigint,
  resolve_tx         text,
  -- Keeper state: the last vi_history.id consumed, and the current run of
  -- consecutive prints past one bound.
  keeper_cursor      bigint not null default 0,
  streak_side        text check (streak_side in ('up', 'down')),
  streak_count       integer not null default 0,
  -- Who pressed "open" (auth.users.id), null when the keeper rolled it.
  opened_by          uuid,
  -- The resolved market this one was rolled from, when auto-roll opened it.
  rolled_from        uuid references bm.markets(id) on delete set null,
  roll               integer not null default 0,
  error              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One live bounded market per atnx market per chain.
create unique index if not exists bm_markets_one_live
  on bm.markets (atnx_market_id, chain)
  where state in ('pending', 'open', 'resolving');
create index if not exists bm_markets_state_idx on bm.markets (state);
create index if not exists bm_markets_atnx_idx on bm.markets (atnx_market_id);

create table if not exists bm.keeper_log (
  id            bigint generated always as identity primary key,
  run_id        uuid not null,
  bm_market_id  uuid references bm.markets(id) on delete cascade,
  action        text not null,
  detail        jsonb,
  error         text,
  tx_hash       text,
  created_at    timestamptz not null default now()
);
create index if not exists bm_keeper_log_created_idx on bm.keeper_log (created_at desc);
create index if not exists bm_keeper_log_market_idx on bm.keeper_log (bm_market_id);

-- Everyone may read; only the service role writes (no insert/update/delete
-- policies exist, so authenticated and anon cannot write through RLS).
alter table bm.markets enable row level security;
alter table bm.keeper_log enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'bm' and tablename = 'markets' and policyname = 'bm_markets_public_read') then
    create policy bm_markets_public_read on bm.markets for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'bm' and tablename = 'keeper_log' and policyname = 'bm_keeper_log_public_read') then
    create policy bm_keeper_log_public_read on bm.keeper_log for select to anon, authenticated using (true);
  end if;
end $$;

grant select on all tables in schema bm to anon, authenticated;
grant all on all tables in schema bm to service_role;
grant usage, select on all sequences in schema bm to service_role;
alter default privileges in schema bm grant select on tables to anon, authenticated;
alter default privileges in schema bm grant all on tables to service_role;

notify pgrst, 'reload schema';
