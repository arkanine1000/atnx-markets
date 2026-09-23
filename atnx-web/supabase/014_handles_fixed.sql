-- 014_handles_fixed.sql
--
-- Handles are fixed. The leaderboard, the trade log and the fee ledger
-- name people by handle, so a change would let a record walk away from
-- its owner. The settings page no longer offers the edit; this guard
-- refuses the update at the table too, since profiles are self-editable
-- under RLS. Admins may still change one from the SQL editor.
--
-- Replaces the role guard from 006 with one trigger for both fields.
--
-- Idempotent.

create or replace function public.guard_profile_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role and not public.is_admin() then
    raise exception 'Not authorized to change role';
  end if;
  if new.handle is distinct from old.handle and not public.is_admin() then
    raise exception 'Handles cannot be changed';
  end if;
  return new;
end;
$$;

drop trigger if exists user_profiles_guard_role on public.user_profiles;
drop trigger if exists user_profiles_guard_fields on public.user_profiles;
create trigger user_profiles_guard_fields
  before update on public.user_profiles
  for each row execute function public.guard_profile_fields();
