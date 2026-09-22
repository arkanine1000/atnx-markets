-- 007_trade_volume.sql
--
-- Trade volume. markets.total_volume_usd has been in the schema since the
-- baseline but nothing wrote it. From here on open_position() and
-- close_position() add the trade's size to it, so a market's volume is the
-- sum of every open and every close on it (each leg of a round trip is a
-- trade, the way an exchange counts volume; leverage is not multiplied
-- in). The backfill at the end derives the same figure from the positions
-- already on record, so it is safe to run on a live database.
--
-- The app reads volume by aggregating positions (lib/store.ts,
-- lib/leaderboard.ts), so the pages are right whether or not this file has
-- been applied; the column is kept current for the admin view and for
-- anything that wants it without a scan.
--
-- Idempotent.

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
  v_balance numeric;
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

  select current_vi into v_vi
    from public.markets
    where id = p_market_id and deleted_at is null;
  if not found then
    raise exception 'Market not found';
  end if;
  if v_vi is null or v_vi <= 0 then
    raise exception 'Market has no score yet';
  end if;

  -- Lock the balance row for the rest of the transaction so a concurrent
  -- open waits here and sees the debited balance.
  select balance_usd into v_balance
    from public.sim_balances
    where user_id = v_user
    for update;
  if not found then
    raise exception 'No balance row';
  end if;
  if v_balance < p_size_usd then
    raise exception 'Insufficient balance';
  end if;

  insert into public.positions
    (user_id, market_id, direction, size_usd, entry_vi, entry_price, leverage, network, status)
  values
    (v_user, p_market_id, p_direction, p_size_usd, v_vi, v_vi, p_leverage, 'simulated', 'open')
  returning id into v_id;

  update public.sim_balances
    set balance_usd = balance_usd - p_size_usd,
        total_trades = total_trades + 1,
        updated_at = now()
    where user_id = v_user;

  update public.markets
    set total_volume_usd = coalesce(total_volume_usd, 0) + p_size_usd
    where id = p_market_id;

  return v_id;
end;
$$;

create or replace function public.close_position(p_position_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_pos public.positions%rowtype;
  v_exit numeric;
  v_ratio numeric;
  v_pnl numeric;
begin
  if v_user is null then
    raise exception 'Not signed in';
  end if;

  -- Lock the balance first, then the position, in the same order as open()
  -- so the two cannot deadlock.
  perform 1 from public.sim_balances where user_id = v_user for update;
  if not found then
    raise exception 'No balance row';
  end if;

  select * into v_pos
    from public.positions
    where id = p_position_id and user_id = v_user and status = 'open'
    for update;
  if not found then
    raise exception 'Position not found';
  end if;

  -- Deleted markets are still read here (security definer bypasses the
  -- public-read policy), so a retired market closes at its last score
  -- rather than silently at entry.
  select current_vi into v_exit from public.markets where id = v_pos.market_id;
  v_exit := coalesce(v_exit, v_pos.entry_vi);

  v_ratio := case when v_pos.entry_price = 0 then 1 else v_exit / v_pos.entry_price end;
  v_pnl := v_pos.size_usd
         * (case when v_pos.direction = 'long' then v_ratio - 1 else 1 - v_ratio end)
         * coalesce(v_pos.leverage, 1);
  v_pnl := round(v_pnl, 2);

  update public.positions
    set status = 'closed',
        closed_at = now(),
        exit_vi = v_exit,
        exit_price = v_exit,
        realized_pnl = v_pnl
    where id = v_pos.id;

  update public.sim_balances
    set balance_usd = balance_usd + v_pos.size_usd + v_pnl,
        total_pnl_realized = total_pnl_realized + v_pnl,
        updated_at = now()
    where user_id = v_user;

  update public.markets
    set total_volume_usd = coalesce(total_volume_usd, 0) + v_pos.size_usd
    where id = v_pos.market_id;

  return jsonb_build_object('realized_pnl', v_pnl, 'exit_vi', v_exit);
end;
$$;

revoke all on function public.open_position(uuid, text, numeric, numeric) from public, anon;
revoke all on function public.close_position(uuid) from public, anon;
grant execute on function public.open_position(uuid, text, numeric, numeric) to authenticated;
grant execute on function public.close_position(uuid) to authenticated;

-- Backfill from the positions on record: one leg for every position, a
-- second for every closed one. Markets with no trades go to zero.
update public.markets m
  set total_volume_usd = coalesce(v.volume, 0)
  from (
    select p.market_id,
           sum(p.size_usd) + sum(case when p.status = 'closed' then p.size_usd else 0 end) as volume
      from public.positions p
      group by p.market_id
  ) v
  where v.market_id = m.id;

update public.markets
  set total_volume_usd = 0
  where id not in (select distinct market_id from public.positions);
