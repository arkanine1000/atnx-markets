-- Chunk 4 migrations. Run this once in the Supabase SQL Editor before testing
-- the admin dashboard / trigram matching. These objects cannot be created via
-- the JS client — they must go through the SQL Editor or Supabase CLI.

-- Enable the trigram extension (no-op if already enabled).
create extension if not exists pg_trgm;

-- Optional: index to keep `similarity()` queries fast as markets grows.
create index if not exists markets_entity_name_normalized_trgm_idx
  on public.markets using gin (entity_name_normalized gin_trgm_ops);

-- --------------------------------------------------------------------------
-- 4.1 — Fuzzy market matcher
-- --------------------------------------------------------------------------
create or replace function public.find_similar_market(
  query_name text,
  threshold real default 0.85
)
returns table (id uuid, entity_name text, similarity real)
language sql
stable
as $$
  select
    m.id,
    m.entity_name,
    similarity(m.entity_name_normalized, query_name) as similarity
  from public.markets m
  where
    m.deleted_at is null
    and similarity(m.entity_name_normalized, query_name) > threshold
  order by similarity desc
  limit 1;
$$;

-- --------------------------------------------------------------------------
-- Helper used by every admin_* function. Only invokable inside the DB.
-- --------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1
    from public.user_profiles p
    where p.id = auth.uid()
      and p.role in ('admin', 'moderator')
  );
$$;

-- --------------------------------------------------------------------------
-- 4.5 — Admin mutation RPCs. Each writes to moderation_log in the same txn.
-- --------------------------------------------------------------------------
create or replace function public.admin_soft_delete_market(
  market_id uuid,
  reason text default null
)
returns void
language plpgsql
security definer
as $$
declare
  acting_user uuid := auth.uid();
begin
  if not public.is_admin() then
    raise exception 'Not authorized';
  end if;

  update public.markets
    set deleted_at = now()
    where id = market_id;

  insert into public.moderation_log (admin_user_id, action, target_type, target_id, reason)
    values (acting_user, 'soft_delete_market', 'market', market_id, reason);
end;
$$;

create or replace function public.admin_restore_market(
  market_id uuid,
  reason text default null
)
returns void
language plpgsql
security definer
as $$
declare
  acting_user uuid := auth.uid();
begin
  if not public.is_admin() then
    raise exception 'Not authorized';
  end if;

  update public.markets
    set deleted_at = null
    where id = market_id;

  insert into public.moderation_log (admin_user_id, action, target_type, target_id, reason)
    values (acting_user, 'restore_market', 'market', market_id, reason);
end;
$$;

create or replace function public.admin_edit_market_name(
  market_id uuid,
  new_name text,
  reason text default null
)
returns void
language plpgsql
security definer
as $$
declare
  acting_user uuid := auth.uid();
  old_name text;
begin
  if not public.is_admin() then
    raise exception 'Not authorized';
  end if;

  select entity_name into old_name from public.markets where id = market_id;

  update public.markets
    set entity_name = new_name,
        entity_name_normalized = lower(trim(new_name))
    where id = market_id;

  insert into public.moderation_log (admin_user_id, action, target_type, target_id, reason, metadata)
    values (acting_user, 'edit_market_name', 'market', market_id, reason,
            jsonb_build_object('old_name', old_name, 'new_name', new_name));
end;
$$;

create or replace function public.admin_soft_delete_capture(
  capture_id uuid,
  reason text default null
)
returns void
language plpgsql
security definer
as $$
declare
  acting_user uuid := auth.uid();
begin
  if not public.is_admin() then
    raise exception 'Not authorized';
  end if;

  update public.captures
    set deleted_at = now()
    where id = capture_id;

  insert into public.moderation_log (admin_user_id, action, target_type, target_id, reason)
    values (acting_user, 'soft_delete_capture', 'capture', capture_id, reason);
end;
$$;

create or replace function public.admin_reassign_capture(
  capture_id uuid,
  new_market_id uuid,
  reason text default null
)
returns void
language plpgsql
security definer
as $$
declare
  acting_user uuid := auth.uid();
  old_market_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Not authorized';
  end if;

  select market_id into old_market_id from public.captures where id = capture_id;

  update public.captures
    set market_id = new_market_id,
        resolution_status = 'resolved'
    where id = capture_id;

  insert into public.moderation_log (admin_user_id, action, target_type, target_id, reason, metadata)
    values (acting_user, 'reassign_capture', 'capture', capture_id, reason,
            jsonb_build_object('old_market_id', old_market_id, 'new_market_id', new_market_id));
end;
$$;
