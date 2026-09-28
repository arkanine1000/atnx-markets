-- 021_blocked_terms.sql
--
-- Names that may not become markets again. When an admin retires a market
-- (app/admin/actions.ts retireMarket) its name and aliases land here, and
-- the capture pipeline (lib/blocklist.ts) rejects a proposal whose name or
-- alias matches before anything is created. Terms are stored normalised
-- the way market names are compared (lib/retrieve.ts normalizeName: lower
-- case, trimmed, single spaces).
--
-- Seeded with "November 2026": a calendar phrase that people search for
-- calendars, not the meme, so its Trends reading carried 85% of a Viral
-- score. Retired by the user on 2026-09-28.
--
-- Written by the service role and by admins through the dashboard; admins
-- can read it.
--
-- Idempotent.

create table if not exists public.blocked_terms (
  term_normalized   text primary key,
  reason            text,
  source_market_id  uuid references public.markets(id) on delete set null,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now()
);

alter table public.blocked_terms enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'blocked_terms' and policyname = 'blocked_terms_admin_read') then
    create policy blocked_terms_admin_read on public.blocked_terms
      for select to authenticated
      using (is_admin());
  end if;
end $$;

comment on table public.blocked_terms is
  'Normalised names and aliases of retired markets; the capture pipeline rejects a new-market proposal that matches one (lib/blocklist.ts).';

insert into public.blocked_terms (term_normalized, reason, source_market_id)
select t, 'November 2026 retired 2026-09-28: a calendar phrase, not a subject; Trends read the calendar searches', m.id
from (values ('november 2026'), ('remember november 2026 is coming'), ('november 2026 meme'), ('modest mouse polar bear meme')) as v(t)
left join public.markets m on m.entity_name_normalized = 'november 2026'
on conflict (term_normalized) do nothing;
