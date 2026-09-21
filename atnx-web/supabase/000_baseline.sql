-- 000_baseline.sql
--
-- Starting point for the numbered migrations that follow (001_, 002_, ...).
-- Apply files in numeric order, by hand, in the Supabase SQL Editor.
--
-- Generated 2026-09-20 from the live "ATNX Beta" project (lspgjzvgnelustbqhgkl)
-- by querying information_schema and pg_catalog through `supabase db query`.
-- It is not a pg_dump: function bodies are in chunk4.sql and are not
-- repeated here; extensions are listed from what the schema uses.
--
-- Every statement is idempotent, so running it against the live project is a
-- no-op for objects that already exist. It does not alter existing columns.
--
-- Note: chunk4.sql creates markets_entity_name_normalized_trgm_idx, but the
-- live index is named markets_name_trgm_idx. Running chunk4.sql again would
-- add a second, identical trigram index. Do not re-run it.

create extension if not exists pg_trgm;
create extension if not exists vector;   -- captures.embedding_* are pgvector columns

create sequence if not exists public.vi_history_id_seq;
create sequence if not exists public.moderation_log_id_seq;

-- ---------------------------------------------------------------------------
-- markets
-- ---------------------------------------------------------------------------
create table if not exists public.markets (
  id                      uuid not null default gen_random_uuid(),
  canonical_entity_id     text,
  entity_name             text not null,
  entity_name_normalized  text not null,
  entity_type             text,
  thumbnail_url           text,
  current_vi              numeric default 0,
  vi_last_updated         timestamptz,
  phase                   smallint default 1,
  is_graduated            boolean default false,
  total_captures          integer default 0,
  total_volume_usd        numeric default 0,
  network                 text default 'simulated'::text,
  on_chain_pda            text,
  trading_mode            text default 'sim'::text,
  deleted_at              timestamptz,
  created_at              timestamptz default now(),
  constraint markets_pkey PRIMARY KEY (id),
  constraint markets_canonical_entity_id_key UNIQUE (canonical_entity_id),
  constraint markets_network_check CHECK ((network = ANY (ARRAY['simulated'::text, 'devnet'::text, 'mainnet'::text]))),
  constraint markets_trading_mode_check CHECK ((trading_mode = ANY (ARRAY['sim'::text, 'live'::text])))
);

create index if not exists markets_name_trgm_idx ON public.markets USING gin (entity_name_normalized gin_trgm_ops);

alter table public.markets enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'markets' and policyname = 'markets_admin_write') then
    create policy markets_admin_write on public.markets
      for all to public
      using (is_admin());
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'markets' and policyname = 'markets_public_read') then
    create policy markets_public_read on public.markets
      for select to public
      using (((deleted_at IS NULL) OR is_admin()));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- captures
-- ---------------------------------------------------------------------------
create table if not exists public.captures (
  id                      uuid not null default gen_random_uuid(),
  user_id                 uuid,
  market_id               uuid,
  image_url               text,
  ocr_text                text,
  source_url              text,
  raw_ai_response         jsonb,
  embedding_text          vector,
  embedding_image         vector,
  perceptual_hash         bigint,
  confidence_score        numeric,
  resolution_status       text default 'pending'::text,
  deleted_at              timestamptz,
  created_at              timestamptz default now(),
  constraint captures_pkey PRIMARY KEY (id),
  constraint captures_market_id_fkey FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE SET NULL,
  constraint captures_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint captures_resolution_status_check CHECK ((resolution_status = ANY (ARRAY['pending'::text, 'resolved'::text, 'review'::text, 'new_entity'::text])))
);

create index if not exists captures_created_at_idx ON public.captures USING btree (created_at DESC);
create index if not exists captures_market_id_idx ON public.captures USING btree (market_id);
create index if not exists captures_user_id_idx ON public.captures USING btree (user_id);

alter table public.captures enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'captures' and policyname = 'captures_admin_write') then
    create policy captures_admin_write on public.captures
      for all to public
      using (is_admin());
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'captures' and policyname = 'captures_self_insert') then
    create policy captures_self_insert on public.captures
      for insert to public
      with check ((auth.uid() = user_id));
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'captures' and policyname = 'captures_self_read') then
    create policy captures_self_read on public.captures
      for select to public
      using ((((auth.uid() = user_id) AND (deleted_at IS NULL)) OR is_admin()));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- vi_history
-- ---------------------------------------------------------------------------
create table if not exists public.vi_history (
  id                      bigint not null default nextval('vi_history_id_seq'::regclass),
  market_id               uuid not null,
  vi                      numeric not null,
  recorded_at             timestamptz default now(),
  constraint vi_history_pkey PRIMARY KEY (id),
  constraint vi_history_market_id_fkey FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE CASCADE
);

create index if not exists vi_history_market_time_idx ON public.vi_history USING btree (market_id, recorded_at DESC);

alter table public.vi_history enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'vi_history' and policyname = 'vi_history_public_read') then
    create policy vi_history_public_read on public.vi_history
      for select to public
      using (true);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- user_profiles
-- ---------------------------------------------------------------------------
create table if not exists public.user_profiles (
  id                      uuid not null,
  handle                  text not null,
  email                   text,
  avatar_url              text,
  wallet_address          text,
  auth_methods            text[] default ARRAY['google'::text],
  role                    text default 'user'::text,
  created_at              timestamptz default now(),
  updated_at              timestamptz default now(),
  constraint user_profiles_pkey PRIMARY KEY (id),
  constraint user_profiles_handle_key UNIQUE (handle),
  constraint user_profiles_wallet_address_key UNIQUE (wallet_address),
  constraint user_profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint user_profiles_role_check CHECK ((role = ANY (ARRAY['user'::text, 'admin'::text, 'moderator'::text])))
);


alter table public.user_profiles enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_profiles' and policyname = 'profiles_admin_update') then
    create policy profiles_admin_update on public.user_profiles
      for update to public
      using (is_admin());
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_profiles' and policyname = 'profiles_public_read') then
    create policy profiles_public_read on public.user_profiles
      for select to public
      using (true);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_profiles' and policyname = 'profiles_self_update') then
    create policy profiles_self_update on public.user_profiles
      for update to public
      using ((auth.uid() = id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- sim_balances
-- ---------------------------------------------------------------------------
create table if not exists public.sim_balances (
  user_id                 uuid not null,
  balance_usd             numeric default 10000,
  total_pnl_realized      numeric default 0,
  total_trades            integer default 0,
  updated_at              timestamptz default now(),
  constraint sim_balances_pkey PRIMARY KEY (user_id),
  constraint sim_balances_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);


alter table public.sim_balances enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sim_balances' and policyname = 'balances_admin_read') then
    create policy balances_admin_read on public.sim_balances
      for select to public
      using (is_admin());
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sim_balances' and policyname = 'balances_self_read') then
    create policy balances_self_read on public.sim_balances
      for select to public
      using ((auth.uid() = user_id));
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sim_balances' and policyname = 'balances_self_update') then
    create policy balances_self_update on public.sim_balances
      for update to public
      using ((auth.uid() = user_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- positions
-- ---------------------------------------------------------------------------
create table if not exists public.positions (
  id                      uuid not null default gen_random_uuid(),
  user_id                 uuid not null,
  market_id               uuid not null,
  direction               text not null,
  size_usd                numeric not null,
  entry_vi                numeric not null,
  entry_price             numeric not null,
  leverage                numeric default 1,
  network                 text default 'simulated'::text,
  tx_signature            text,
  opened_at               timestamptz default now(),
  closed_at               timestamptz,
  exit_vi                 numeric,
  exit_price              numeric,
  realized_pnl            numeric,
  status                  text default 'open'::text,
  constraint positions_pkey PRIMARY KEY (id),
  constraint positions_market_id_fkey FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE CASCADE,
  constraint positions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint positions_direction_check CHECK ((direction = ANY (ARRAY['long'::text, 'short'::text]))),
  constraint positions_network_check CHECK ((network = ANY (ARRAY['simulated'::text, 'devnet'::text, 'mainnet'::text]))),
  constraint positions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text])))
);

create index if not exists positions_market_idx ON public.positions USING btree (market_id);
create index if not exists positions_network_idx ON public.positions USING btree (network);
create index if not exists positions_user_status_idx ON public.positions USING btree (user_id, status);

alter table public.positions enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'positions' and policyname = 'positions_admin_read') then
    create policy positions_admin_read on public.positions
      for select to public
      using (is_admin());
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'positions' and policyname = 'positions_self_insert') then
    create policy positions_self_insert on public.positions
      for insert to public
      with check ((auth.uid() = user_id));
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'positions' and policyname = 'positions_self_read') then
    create policy positions_self_read on public.positions
      for select to public
      using ((auth.uid() = user_id));
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'positions' and policyname = 'positions_self_update') then
    create policy positions_self_update on public.positions
      for update to public
      using ((auth.uid() = user_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- moderation_log
-- ---------------------------------------------------------------------------
create table if not exists public.moderation_log (
  id                      bigint not null default nextval('moderation_log_id_seq'::regclass),
  admin_user_id           uuid not null,
  action                  text not null,
  target_type             text not null,
  target_id               uuid not null,
  reason                  text,
  metadata                jsonb,
  created_at              timestamptz default now(),
  constraint moderation_log_pkey PRIMARY KEY (id),
  constraint moderation_log_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES auth.users(id)
);

create index if not exists mod_log_admin_time_idx ON public.moderation_log USING btree (admin_user_id, created_at DESC);
create index if not exists mod_log_target_idx ON public.moderation_log USING btree (target_type, target_id);

alter table public.moderation_log enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'moderation_log' and policyname = 'mod_log_admin_insert') then
    create policy mod_log_admin_insert on public.moderation_log
      for insert to public
      with check ((is_admin() AND (auth.uid() = admin_user_id)));
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'moderation_log' and policyname = 'mod_log_admin_read') then
    create policy mod_log_admin_read on public.moderation_log
      for select to public
      using (is_admin());
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------
-- Bucket `captures` is PUBLIC (verified 2026-09-20), which is why
-- lib/store.ts can read captures back with getPublicUrl(). Buckets are not
-- created here; the policies below are what the live project has on
-- storage.objects.

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'admins_can_crud_any 1y7i3n1_0') then
    create policy "admins_can_crud_any 1y7i3n1_0" on storage.objects
      for delete to authenticated
      using (((bucket_id = 'captures'::text) AND is_admin()));
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'admins_can_crud_any 1y7i3n1_1') then
    create policy "admins_can_crud_any 1y7i3n1_1" on storage.objects
      for select to authenticated
      using (((bucket_id = 'captures'::text) AND is_admin()));
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'admins_can_crud_any 1y7i3n1_2') then
    create policy "admins_can_crud_any 1y7i3n1_2" on storage.objects
      for update to authenticated
      using (((bucket_id = 'captures'::text) AND is_admin()));
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'admins_can_crud_any 1y7i3n1_3') then
    create policy "admins_can_crud_any 1y7i3n1_3" on storage.objects
      for insert to authenticated
      with check (((bucket_id = 'captures'::text) AND is_admin()));
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'authenticated_users_can_upload 1y7i3n1_0') then
    create policy "authenticated_users_can_upload 1y7i3n1_0" on storage.objects
      for insert to authenticated
      with check (((bucket_id = 'captures'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------
-- find_similar_market, is_admin and the admin_* RPCs are defined in
-- chunk4.sql, which predates this file and is already applied.

