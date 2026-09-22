-- 006_trading_integrity.sql
--
-- Closes the holes a signed-in user could reach with the anon key and their
-- own session, straight against PostgREST, past every check in the app:
--
--   1. user_profiles.role was self-editable (profiles_self_update has no
--      column restriction), so anyone could make themselves admin.
--   2. user_profiles was readable by everyone, email and wallet included.
--   3. sim_balances and positions were writable by their owner with no
--      constraint on the values, so balances and PnL could be forged; and
--      the server actions that did the real accounting were a check-then-
--      write across several statements, so two concurrent opens overdrew
--      and a double close credited twice.
--
-- After this file, trading writes go through open_position() and
-- close_position(): one transaction each, balance row locked, size and
-- leverage validated in the database. Nothing else can write those tables
-- as a user. Roles change only by an admin. Profiles are readable by their
-- owner (and admins); public reads of handles go through the service role
-- in lib/store.ts and lib/leaderboard.ts already.
--
-- Idempotent.

-- ---------------------------------------------------------------------------
-- 1. Role changes need an admin.
-- ---------------------------------------------------------------------------
create or replace function public.guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role and not public.is_admin() then
    raise exception 'Not authorized to change role';
  end if;
  return new;
end;
$$;

drop trigger if exists user_profiles_guard_role on public.user_profiles;
create trigger user_profiles_guard_role
  before update on public.user_profiles
  for each row execute function public.guard_profile_role();

-- ---------------------------------------------------------------------------
-- 2. Profiles: owner and admins read; the public does not.
-- ---------------------------------------------------------------------------
drop policy if exists profiles_public_read on public.user_profiles;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_profiles' and policyname = 'profiles_self_read') then
    create policy profiles_self_read on public.user_profiles
      for select to public
      using (auth.uid() = id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_profiles' and policyname = 'profiles_admin_read') then
    create policy profiles_admin_read on public.user_profiles
      for select to public
      using (public.is_admin());
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Balances and positions: no direct writes by users.
-- ---------------------------------------------------------------------------
drop policy if exists balances_self_update on public.sim_balances;
drop policy if exists positions_self_insert on public.positions;
drop policy if exists positions_self_update on public.positions;

-- ---------------------------------------------------------------------------
-- 4. Atomic open. Returns the new position id.
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

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Atomic close. Returns {realized_pnl, exit_vi}. A second close of the
--    same position finds no open row and raises, so it cannot credit twice.
-- ---------------------------------------------------------------------------
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

  return jsonb_build_object('realized_pnl', v_pnl, 'exit_vi', v_exit);
end;
$$;

revoke all on function public.open_position(uuid, text, numeric, numeric) from public, anon;
revoke all on function public.close_position(uuid) from public, anon;
grant execute on function public.open_position(uuid, text, numeric, numeric) to authenticated;
grant execute on function public.close_position(uuid) to authenticated;
