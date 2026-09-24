-- 015_waitlist.sql
--
-- The landing page's Join Waitlist button collects an email. One row per
-- address, lowercased and trimmed by the server before insert; the unique
-- index makes a second signup a no-op rather than a duplicate. Inserts go
-- through the service role from /api/waitlist, so no insert policy is
-- needed; admins read the list on /admin.
--
-- Idempotent.

create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  -- Where the signup came from: 'landing' for now.
  source text not null default 'landing',
  created_at timestamptz not null default now()
);

create unique index if not exists waitlist_email_key
  on public.waitlist (lower(btrim(email)));

alter table public.waitlist enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'waitlist' and policyname = 'waitlist_admin_read') then
    create policy waitlist_admin_read on public.waitlist
      for select to public
      using (is_admin());
  end if;
end $$;

comment on table public.waitlist is
  'Landing-page waitlist signups. Written by the server (service role) via /api/waitlist; admin-readable.';
