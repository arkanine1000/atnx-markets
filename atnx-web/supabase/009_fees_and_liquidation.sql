-- 009_fees_and_liquidation.sql
--
-- Two changes to the simulated exchange, both in the database functions
-- that are the only write path for trading (supabase/006):
--
--   1. Liquidation. PnL was size × (vi/entry − 1) × leverage with no floor,
--      so at 10× a 10% move against a position wiped it and anything past
--      that pushed the balance below zero when it closed. A position now
--      loses at most what was put in: realized PnL is floored at −size, and
--      a position whose mark reaches that floor is closed automatically the
--      moment the market's VI is written (trigger below), recorded with
--      liquidated = true. close_position() applies the same floor, so a
--      balance can no longer go negative through trading.
--
--   2. A 1% trading fee, charged on the size of every open and split in
--      half: 0.5% to the account that created the market (the first
--      capture that spawned it) and 0.5% to a simulated treasury. The fee
--      is debited with the size, so an open needs size × 1.01 in balance.
--      A market with no known creator sends the whole fee to the treasury.
--      Creator income lands in balance_usd (so it counts in equity and on
--      the leaderboard) and is totalled in sim_balances.fees_earned_usd for
--      the portfolio; every fee is also a row in fee_events.
--
-- Volume is unchanged: each leg counts once at size, fee and leverage not
-- multiplied in.
--
-- Idempotent.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
alter table public.markets
  add column if not exists created_by uuid references auth.users(id) on delete set null;
comment on column public.markets.created_by is
  'Account whose capture spawned this market; receives half of every trading fee on it.';

-- Backfill: the earliest capture on each market names its creator. Deleted
-- captures still count (the market exists because of them).
update public.markets m
  set created_by = c.user_id
  from (
    select distinct on (market_id) market_id, user_id
      from public.captures
      where market_id is not null and user_id is not null
      order by market_id, created_at asc
  ) c
  where c.market_id = m.id and m.created_by is null;

alter table public.positions
  add column if not exists fee_usd numeric not null default 0,
  add column if not exists liquidated boolean not null default false;
comment on column public.positions.fee_usd is 'Trading fee charged at open: 1% of size_usd.';
comment on column public.positions.liquidated is
  'Closed by the exchange because the loss reached the size put in (realized_pnl = -size_usd).';

alter table public.sim_balances
  add column if not exists fees_earned_usd numeric not null default 0,
  add column if not exists fees_paid_usd numeric not null default 0;
comment on column public.sim_balances.fees_earned_usd is
  'Creator share of trading fees on markets this account created. Already included in balance_usd.';
comment on column public.sim_balances.fees_paid_usd is 'Trading fees this account has paid on its opens.';

-- ---------------------------------------------------------------------------
-- 2. Treasury: one row, readable by everyone, written only by the functions.
-- ---------------------------------------------------------------------------
create table if not exists public.sim_treasury (
  id            smallint primary key default 1 check (id = 1),
  balance_usd   numeric not null default 0,
  fee_count     integer not null default 0,
  updated_at    timestamptz not null default now()
);
insert into public.sim_treasury (id) values (1) on conflict (id) do nothing;

alter table public.sim_treasury enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sim_treasury' and policyname = 'treasury_public_read') then
    create policy treasury_public_read on public.sim_treasury
      for select to public
      using (true);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Fee ledger. Payer and creator read their own rows; admins read all.
-- ---------------------------------------------------------------------------
create table if not exists public.fee_events (
  id               bigint generated always as identity primary key,
  position_id      uuid not null references public.positions(id) on delete cascade,
  market_id        uuid not null references public.markets(id) on delete cascade,
  payer_user_id    uuid not null references auth.users(id) on delete cascade,
  creator_user_id  uuid references auth.users(id) on delete set null,
  fee_usd          numeric not null,
  creator_usd      numeric not null,
  treasury_usd     numeric not null,
  created_at       timestamptz not null default now()
);
create index if not exists fee_events_market_idx on public.fee_events (market_id);
create index if not exists fee_events_creator_idx on public.fee_events (creator_user_id);
create index if not exists fee_events_payer_idx on public.fee_events (payer_user_id);

alter table public.fee_events enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'fee_events' and policyname = 'fee_events_party_read') then
    create policy fee_events_party_read on public.fee_events
      for select to public
      using (auth.uid() = payer_user_id or auth.uid() = creator_user_id or public.is_admin());
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Lock order, everywhere below: market row, then balance row(s), then the
-- position. The liquidation trigger runs inside the VI refresh's update of
-- the market row, so it already holds the market when it reaches for a
-- balance; open() and close() therefore take the market first too (the
-- volume update doubles as that lock) rather than last as 007 did.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4. Atomic open with the fee. Returns the new position id.
-- ---------------------------------------------------------------------------
create or replace function public.open_position(
  p_market_id uuid,
  p_direction text,
  p_size_usd numeric,
  p_leverage numeric default 1
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_vi numeric;
  v_creator uuid;
  v_balance numeric;
  v_fee numeric;
  v_creator_fee numeric := 0;
  v_treasury_fee numeric;
  v_id uuid;
begin
  if v_user is null then
    raise exception 'Not signed in';
  end if;
  if p_direction not in ('long', 'short') then
    raise exception 'Invalid direction';
  end if;
  if p_size_usd is null or p_size_usd <= 0 or p_size_usd > 1e9 then
    raise exception 'Invalid size';
  end if;
  if p_leverage is null or p_leverage < 1 or p_leverage > 10 then
    raise exception 'Invalid leverage';
  end if;

  -- Locks the market row (see lock order above) and counts the open leg
  -- towards volume; a raise further down rolls that back with the rest.
  update public.markets
    set total_volume_usd = coalesce(total_volume_usd, 0) + p_size_usd
    where id = p_market_id and deleted_at is null
    returning current_vi, created_by into v_vi, v_creator;
  if not found then
    raise exception 'Market not found';
  end if;
  if v_vi is null or v_vi <= 0 then
    raise exception 'Market has no score yet';
  end if;

  -- 1% of size, split in half. Whole cents; the treasury takes the odd cent.
  v_fee := round(p_size_usd * 0.01, 2);

  -- Lock the payer's balance row, and the creator's when it is someone
  -- else, in user_id order so two opens on each other's markets cannot
  -- deadlock. A creator without a balance row (or a market with no
  -- creator) sends the whole fee to the treasury.
  if v_creator is not null and v_creator <> v_user then
    perform 1 from public.sim_balances
      where user_id in (v_user, v_creator)
      order by user_id
      for update;
    if exists (select 1 from public.sim_balances where user_id = v_creator) then
      v_creator_fee := round(v_fee / 2, 2);
    end if;
  elsif v_creator = v_user then
    v_creator_fee := round(v_fee / 2, 2);
  end if;
  v_treasury_fee := v_fee - v_creator_fee;

  select balance_usd into v_balance
    from public.sim_balances
    where user_id = v_user
    for update;
  if not found then
    raise exception 'No balance row';
  end if;
  if v_balance < p_size_usd + v_fee then
    raise exception 'Insufficient balance (size plus 1%% fee)';
  end if;

  insert into public.positions
    (user_id, market_id, direction, size_usd, entry_vi, entry_price, leverage, fee_usd, network, status)
  values
    (v_user, p_market_id, p_direction, p_size_usd, v_vi, v_vi, p_leverage, v_fee, 'simulated', 'open')
  returning id into v_id;

  update public.sim_balances
    set balance_usd = balance_usd - p_size_usd - v_fee,
        fees_paid_usd = fees_paid_usd + v_fee,
        total_trades = total_trades + 1,
        updated_at = now()
    where user_id = v_user;

  if v_creator_fee > 0 then
    update public.sim_balances
      set balance_usd = balance_usd + v_creator_fee,
          fees_earned_usd = fees_earned_usd + v_creator_fee,
          updated_at = now()
      where user_id = v_creator;
  end if;

  update public.sim_treasury
    set balance_usd = balance_usd + v_treasury_fee,
        fee_count = fee_count + 1,
        updated_at = now()
    where id = 1;

  insert into public.fee_events
    (position_id, market_id, payer_user_id, creator_user_id, fee_usd, creator_usd, treasury_usd)
  values
    (v_id, p_market_id, v_user, case when v_creator_fee > 0 then v_creator else null end,
     v_fee, v_creator_fee, v_treasury_fee);

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Atomic close, PnL floored at −size. Returns {realized_pnl, exit_vi,
--    liquidated}. A second close finds no open row and raises.
-- ---------------------------------------------------------------------------
create or replace function public.close_position(p_position_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_market uuid;
  v_size numeric;
  v_pos public.positions%rowtype;
  v_exit numeric;
  v_ratio numeric;
  v_pnl numeric;
  v_liquidated boolean;
begin
  if v_user is null then
    raise exception 'Not signed in';
  end if;

  -- Which market, without locking the position yet (lock order above).
  select market_id, size_usd into v_market, v_size
    from public.positions
    where id = p_position_id and user_id = v_user and status = 'open';
  if not found then
    raise exception 'Position not found';
  end if;

  -- Market lock plus the close leg's volume. Deleted markets are still
  -- read here (security definer bypasses the public-read policy), so a
  -- retired market closes at its last score rather than silently at entry.
  update public.markets
    set total_volume_usd = coalesce(total_volume_usd, 0) + v_size
    where id = v_market
    returning current_vi into v_exit;

  perform 1 from public.sim_balances where user_id = v_user for update;
  if not found then
    raise exception 'No balance row';
  end if;

  -- Re-checked under lock: the trigger may have liquidated it meanwhile.
  select * into v_pos
    from public.positions
    where id = p_position_id and user_id = v_user and status = 'open'
    for update;
  if not found then
    raise exception 'Position not found';
  end if;

  v_exit := coalesce(v_exit, v_pos.entry_vi);

  v_ratio := case when v_pos.entry_price = 0 then 1 else v_exit / v_pos.entry_price end;
  v_pnl := v_pos.size_usd
         * (case when v_pos.direction = 'long' then v_ratio - 1 else 1 - v_ratio end)
         * coalesce(v_pos.leverage, 1);
  v_pnl := round(v_pnl, 2);

  -- A position cannot lose more than was put in.
  v_liquidated := v_pnl <= -v_pos.size_usd;
  if v_liquidated then
    v_pnl := -v_pos.size_usd;
  end if;

  update public.positions
    set status = 'closed',
        closed_at = now(),
        exit_vi = v_exit,
        exit_price = v_exit,
        realized_pnl = v_pnl,
        liquidated = v_liquidated
    where id = v_pos.id;

  update public.sim_balances
    set balance_usd = balance_usd + v_pos.size_usd + v_pnl,
        total_pnl_realized = total_pnl_realized + v_pnl,
        updated_at = now()
    where user_id = v_user;

  return jsonb_build_object('realized_pnl', v_pnl, 'exit_vi', v_exit, 'liquidated', v_liquidated);
end;
$$;

revoke all on function public.open_position(uuid, text, numeric, numeric) from public, anon;
revoke all on function public.close_position(uuid) from public, anon;
grant execute on function public.open_position(uuid, text, numeric, numeric) to authenticated;
grant execute on function public.close_position(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Liquidation. Runs whenever a market's current_vi changes (the VI
--    refresh writes it every few minutes through the service role) and
--    closes every open position on that market whose loss at the new score
--    has reached its size. Nothing is credited back: the size is gone, and
--    realized PnL records −size. Candidates are found without a lock, then
--    each is re-checked under the balance-then-position lock order the
--    other two functions use (the market row is already held by the
--    update that fired the trigger).
-- ---------------------------------------------------------------------------
create or replace function public.liquidate_positions(p_market_id uuid, p_vi numeric)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pos record;
  v_count integer := 0;
  v_volume numeric := 0;
begin
  if p_vi is null then
    return 0;
  end if;

  for v_pos in
    select id, user_id, size_usd
      from public.positions
      where market_id = p_market_id
        and status = 'open'
        and entry_price > 0
        and (case when direction = 'long' then p_vi / entry_price - 1 else 1 - p_vi / entry_price end)
            * coalesce(leverage, 1) <= -1
  loop
    perform 1 from public.sim_balances where user_id = v_pos.user_id for update;

    update public.positions
      set status = 'closed',
          closed_at = now(),
          exit_vi = p_vi,
          exit_price = p_vi,
          realized_pnl = -size_usd,
          liquidated = true
      where id = v_pos.id and status = 'open';
    if not found then
      continue;  -- closed by its owner in the meantime
    end if;

    update public.sim_balances
      set total_pnl_realized = total_pnl_realized - v_pos.size_usd,
          updated_at = now()
      where user_id = v_pos.user_id;

    v_count := v_count + 1;
    v_volume := v_volume + v_pos.size_usd;
  end loop;

  -- One close leg per liquidation, at size, like any other close. This
  -- update does not touch current_vi, so the trigger below does not re-fire.
  if v_count > 0 then
    update public.markets
      set total_volume_usd = coalesce(total_volume_usd, 0) + v_volume
      where id = p_market_id;
  end if;

  return v_count;
end;
$$;

create or replace function public.liquidate_on_vi_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.liquidate_positions(new.id, new.current_vi);
  return null;
end;
$$;

drop trigger if exists markets_liquidate_on_vi on public.markets;
create trigger markets_liquidate_on_vi
  after update of current_vi on public.markets
  for each row
  when (old.current_vi is distinct from new.current_vi)
  execute function public.liquidate_on_vi_change();

revoke all on function public.liquidate_positions(uuid, numeric) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Sweep once now for positions already past the floor at today's scores,
--    so nothing carries a loss deeper than its size into the new rules.
-- ---------------------------------------------------------------------------
do $$
declare
  m record;
begin
  for m in
    select distinct p.market_id, mk.current_vi
      from public.positions p
      join public.markets mk on mk.id = p.market_id
      where p.status = 'open'
  loop
    perform public.liquidate_positions(m.market_id, m.current_vi);
  end loop;
end $$;
