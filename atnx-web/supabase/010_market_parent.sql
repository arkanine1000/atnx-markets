-- 010_market_parent.sql
--
-- A market can record the subject it is about. "Donald Trump Mugshot" is a
-- meme about the person "Donald Trump"; "Cursed Trollface" is a variant of
-- the meme "Trollface". The pointer is one level deep: a parent never has
-- a parent of its own, and a market with children cannot be given one.
--
-- Display only. The market page shows the parent on the child and the
-- children on the parent; nothing in scoring, trading, fees, dedup or
-- retrieval reads the column. It is set by the admin action below and,
-- once the review step lands, by its commit path from the subject candidate
-- the server offered. Never by the model directly.
--
-- A soft-deleted parent leaves the pointer in place; reads filter deleted
-- parents out, and a hard delete nulls it through the foreign key.
--
-- Idempotent.

alter table public.markets
  add column if not exists parent_market_id uuid references public.markets(id) on delete set null;

comment on column public.markets.parent_market_id is
  'The market this one is about (a meme about a person, a variant of a meme). One level deep. Display only: nothing reads it to move a price.';

create index if not exists markets_parent_market_id_idx
  on public.markets (parent_market_id)
  where parent_market_id is not null;

-- Admin action. parent_id null clears the pointer. Mirrors
-- admin_edit_market_name in chunk4.sql: the admin check is here, the
-- server action only requires a signed-in user.
create or replace function public.admin_set_parent_market(
  market_id uuid,
  parent_id uuid,
  reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_user uuid := auth.uid();
  old_parent uuid;
  parent_row public.markets%rowtype;
  child_count int;
begin
  if not public.is_admin() then
    raise exception 'Not authorized';
  end if;

  select parent_market_id into old_parent
    from public.markets where id = market_id and deleted_at is null;
  if not found then
    raise exception 'Market not found';
  end if;

  if parent_id is not null then
    if parent_id = market_id then
      raise exception 'A market cannot be its own parent';
    end if;

    select * into parent_row
      from public.markets where id = parent_id and deleted_at is null;
    if not found then
      raise exception 'Parent market not found';
    end if;
    if parent_row.parent_market_id is not null then
      raise exception 'Parent already has a parent; the pointer is one level deep';
    end if;

    select count(*) into child_count
      from public.markets where parent_market_id = market_id and deleted_at is null;
    if child_count > 0 then
      raise exception 'Market has children of its own; the pointer is one level deep';
    end if;
  end if;

  update public.markets
    set parent_market_id = parent_id
    where id = market_id;

  insert into public.moderation_log (admin_user_id, action, target_type, target_id, reason, metadata)
    values (acting_user, 'set_parent_market', 'market', market_id, reason,
            jsonb_build_object('old_parent_id', old_parent, 'new_parent_id', parent_id));
end;
$$;

revoke all on function public.admin_set_parent_market(uuid, uuid, text) from public;
grant execute on function public.admin_set_parent_market(uuid, uuid, text) to authenticated;
