-- 019_purge_with_trades.sql
--
-- admin_purge_market() gains with_trades. Without it nothing changes: a
-- market with trades on record is refused (supabase/013). With it the
-- market's trades go too, and every account is put back as if they had
-- never happened, so balances, the leaderboard and the treasury stay
-- consistent with the positions that remain:
--
--   trader    open position:   + size + fee   (the stake and fee back)
--             closed position: + fee − pnl    (a win taken back, a loss
--                                              and a liquidation refunded)
--             total_pnl_realized − pnl, fees_paid_usd − fee,
--             total_trades − 1 per position
--   creator   − creator share of each fee, from balance_usd and
--             fees_earned_usd
--   treasury  − treasury share of each fee, fee_count − 1 per fee
--
-- A balance can end below zero where someone already spent winnings or
-- creator income from this market elsewhere; it is left as it falls.
--
-- Lock order as in supabase/009: market row, then balance rows (in user_id
-- order), then positions. Holding the market row keeps close_position()
-- and the liquidation trigger off this market until the purge commits.
--
-- The old two-argument function is dropped: with the defaults, a call
-- naming only market_id and reason would match both. Callers that do not
-- pass with_trades are unaffected.
--
-- Idempotent.

drop function if exists public.admin_purge_market(uuid, text);

create or replace function public.admin_purge_market(
  market_id uuid,
  reason text default null,
  with_trades boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_user uuid := auth.uid();
  m public.markets%rowtype;
  trades int;
  traders int := 0;
  image_urls jsonb;
  capture_count int;
begin
  if not public.is_admin() then
    raise exception 'Not authorized';
  end if;

  select * into m from public.markets where id = market_id for update;
  if not found then
    raise exception 'Market not found';
  end if;
  if m.deleted_at is null then
    raise exception 'Only a soft-deleted market can be purged';
  end if;

  select count(*), count(distinct user_id) into trades, traders
    from public.positions where positions.market_id = m.id;
  if trades > 0 and not with_trades then
    raise exception 'Market has % trade(s) on record; it stays soft-deleted', trades;
  end if;

  if trades > 0 then
    perform 1 from public.sim_balances
      where user_id in (
        select p.user_id from public.positions p where p.market_id = m.id
        union
        select f.creator_user_id from public.fee_events f
          where f.market_id = m.id and f.creator_user_id is not null
      )
      order by user_id
      for update;

    update public.sim_balances b
      set balance_usd = b.balance_usd + t.refund,
          total_pnl_realized = b.total_pnl_realized - t.pnl,
          fees_paid_usd = b.fees_paid_usd - t.fees,
          total_trades = greatest(b.total_trades - t.n, 0),
          updated_at = now()
      from (
        select p.user_id,
               sum(case when p.status = 'open'
                        then p.size_usd + p.fee_usd
                        else p.fee_usd - coalesce(p.realized_pnl, 0) end) as refund,
               sum(case when p.status = 'open' then 0 else coalesce(p.realized_pnl, 0) end) as pnl,
               sum(p.fee_usd) as fees,
               count(*) as n
          from public.positions p
          where p.market_id = m.id
          group by p.user_id
      ) t
      where b.user_id = t.user_id;

    update public.sim_balances b
      set balance_usd = b.balance_usd - c.earned,
          fees_earned_usd = b.fees_earned_usd - c.earned,
          updated_at = now()
      from (
        select f.creator_user_id, sum(f.creator_usd) as earned
          from public.fee_events f
          where f.market_id = m.id and f.creator_user_id is not null
          group by f.creator_user_id
      ) c
      where b.user_id = c.creator_user_id;

    update public.sim_treasury s
      set balance_usd = s.balance_usd - f.taken,
          fee_count = greatest(s.fee_count - f.n, 0),
          updated_at = now()
      from (
        select coalesce(sum(treasury_usd), 0) as taken, count(*) as n
          from public.fee_events where fee_events.market_id = m.id
      ) f
      where s.id = 1 and f.n > 0;

    -- fee_events cascade from positions.
    delete from public.positions where positions.market_id = m.id;
  end if;

  select coalesce(jsonb_agg(image_url), '[]'::jsonb), count(*)
    into image_urls, capture_count
    from public.captures
   where captures.market_id = m.id and image_url is not null;

  delete from public.captures where captures.market_id = m.id;
  delete from public.markets where id = m.id;

  insert into public.moderation_log (admin_user_id, action, target_type, target_id, reason, metadata)
    values (acting_user, 'purge_market', 'market', m.id, reason,
            jsonb_build_object('entity_name', m.entity_name, 'captures', capture_count,
                               'trades', trades, 'traders', traders,
                               'soft_deleted_at', m.deleted_at));

  return jsonb_build_object(
    'entity_name', m.entity_name,
    'captures', capture_count,
    'trades', trades,
    'image_urls', image_urls,
    'thumbnail_url', m.thumbnail_url
  );
end;
$$;

revoke all on function public.admin_purge_market(uuid, text, boolean) from public, anon;
grant execute on function public.admin_purge_market(uuid, text, boolean) to authenticated;
