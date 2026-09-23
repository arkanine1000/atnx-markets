-- 013_purge_market.sql
--
-- Permanent deletion of a soft-deleted market from the admin dashboard,
-- to keep the markets list from filling with rows nobody will restore.
--
-- Only a market that is already soft-deleted can be purged, and only when
-- nothing was ever traded on it: positions and fee_events cascade from
-- markets, and erasing them would rewrite people's trade history and the
-- fee ledger. A market with trades stays soft-deleted.
--
-- What goes: the market row, its captures (the audit rows in
-- submission_decisions and submission_drafts keep their content and lose
-- the market reference through their foreign keys), its vi_history
-- (cascade), and any child's parent pointer (set null). The function
-- returns the storage URLs of the images it orphaned so the caller can
-- remove the files; storage is not reachable from SQL.
--
-- Idempotent.

create or replace function public.admin_purge_market(
  market_id uuid,
  reason text default null
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
  image_urls jsonb;
  capture_count int;
begin
  if not public.is_admin() then
    raise exception 'Not authorized';
  end if;

  select * into m from public.markets where id = market_id;
  if not found then
    raise exception 'Market not found';
  end if;
  if m.deleted_at is null then
    raise exception 'Only a soft-deleted market can be purged';
  end if;

  select count(*) into trades from public.positions where positions.market_id = m.id;
  if trades > 0 then
    raise exception 'Market has % trade(s) on record; it stays soft-deleted', trades;
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
                               'soft_deleted_at', m.deleted_at));

  return jsonb_build_object(
    'entity_name', m.entity_name,
    'captures', capture_count,
    'image_urls', image_urls,
    'thumbnail_url', m.thumbnail_url
  );
end;
$$;

revoke all on function public.admin_purge_market(uuid, text) from public;
grant execute on function public.admin_purge_market(uuid, text) to authenticated;
