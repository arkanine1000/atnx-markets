-- 017_market_handles.sql
--
-- A creator market's own accounts on video platforms. Every VI source
-- counts other people talking about a name; a creator's audience is on
-- their own uploads, which rarely carry their name, so a mid-tier creator
-- read zero everywhere. lib/creators/resolve.ts finds the channel
-- automatically from the capture, Wikidata and handle lookups; only a
-- `verified` row feeds the score (lib/creators/channel.ts). A `candidate`
-- worth a look (big enough to be the real channel) waits in the admin
-- dashboard; admins can verify or reject it there. Nobody types a handle
-- in by hand.
--
-- One row per market and platform. Written by the service role (the
-- resolver, the admin actions); admins can read it.
--
-- Idempotent.

create table if not exists public.market_handles (
  market_id uuid not null references public.markets(id) on delete cascade,
  platform text not null check (platform in ('youtube', 'tiktok', 'x')),
  handle text,
  platform_id text,
  status text not null check (status in ('candidate', 'verified', 'rejected')),
  review boolean not null default false,
  confidence text,
  evidence jsonb,
  audience bigint,
  verified_at timestamptz,
  checked_at timestamptz not null default now(),
  primary key (market_id, platform)
);

create index if not exists market_handles_status_idx on public.market_handles (platform, status);

alter table public.market_handles enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'market_handles' and policyname = 'market_handles_admin_read') then
    create policy market_handles_admin_read on public.market_handles
      for select to authenticated
      using (is_admin());
  end if;
end $$;

comment on table public.market_handles is
  'Creator markets'' own platform accounts, resolved automatically; verified rows feed the VI creator-reach reading';
