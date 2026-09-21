-- 002_taxonomy_and_audit.sql
--
-- Phase 3 of the input/taxonomy MVP. Apply after 001_dedup_and_embedding.sql.
--
-- 1. markets gains the flat taxonomy the model emits: one category from a
--    fixed enum, an alias list, and a nullable Wikidata QID for later.
-- 2. A unique index on the normalised name (live rows only) closes the
--    concurrent-creation race; lib/store.ts createMarket re-selects on
--    conflict.
-- 3. submission_decisions is the audit table: one row per routed
--    submission with the evidence the decision was made on.
--
-- Idempotent: safe to run more than once.

-- 1. Taxonomy ---------------------------------------------------------------

alter table public.markets
  add column if not exists category text,
  add column if not exists aliases text[] not null default '{}',
  add column if not exists wikidata_qid text;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'markets_category_check'
  ) then
    alter table public.markets
      add constraint markets_category_check check (
        category is null or category in (
          'memes', 'crypto', 'politics', 'sports', 'music',
          'film_tv', 'gaming', 'tech', 'people', 'other'
        )
      );
  end if;
end $$;

-- 2. One live market per normalised name ------------------------------------
-- Before applying, check for existing duplicates; the index will refuse to
-- build while any exist:
--
--   select entity_name_normalized, count(*) from public.markets
--   where deleted_at is null group by 1 having count(*) > 1;
--
-- Resolve them in the admin dashboard (reassign captures, soft-delete the
-- extra market) and re-run this file.

create unique index if not exists markets_entity_name_normalized_uniq
  on public.markets (entity_name_normalized)
  where deleted_at is null;

-- 3. Audit ------------------------------------------------------------------

create table if not exists public.submission_decisions (
  id               uuid primary key default gen_random_uuid(),
  capture_id       uuid references public.captures (id) on delete set null,
  user_id          uuid references auth.users (id) on delete set null,
  content_hash     text,
  outcome          text not null check (outcome in (
                     'rejected', 'matched', 'linked', 'created',
                     'created_review', 'dedup', 'relinked'
                   )),
  market_id        uuid references public.markets (id) on delete set null,
  candidates       jsonb not null default '[]'::jsonb,
  max_cosine       real,
  max_trigram      real,
  model_confidence text,
  reject_reason    text,
  model            text,
  latency_ms       integer,
  model_response   jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists submission_decisions_created_at_idx
  on public.submission_decisions (created_at desc);
create index if not exists submission_decisions_capture_id_idx
  on public.submission_decisions (capture_id);
create index if not exists submission_decisions_market_id_idx
  on public.submission_decisions (market_id);

alter table public.submission_decisions enable row level security;

-- Written by the server with the service role (bypasses RLS). Readable by
-- admins and moderators only.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'submission_decisions'
      and policyname = 'submission_decisions_admin_read'
  ) then
    create policy submission_decisions_admin_read on public.submission_decisions
      for select to authenticated
      using (is_admin());
  end if;
end $$;
