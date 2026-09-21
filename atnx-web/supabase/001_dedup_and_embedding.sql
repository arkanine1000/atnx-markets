-- 001_dedup_and_embedding.sql
--
-- Phase 2 of the input/taxonomy MVP. Apply after 000_baseline.sql.
--
-- 1. captures.content_hash: SHA-256 of the submitted bytes (or normalised
--    URL or text). A unique partial index makes a resubmission a no-op that
--    returns the earlier result without a model call.
-- 2. markets.embedding: 512-dim text embedding of "name; aliases;
--    description", written on market creation and used for retrieval.
-- 3. Two read-only functions the retrieval stage calls through PostgREST,
--    because supabase-js cannot express `<=>` or `similarity()` directly.
--
-- Idempotent: safe to run more than once.

create extension if not exists vector;
create extension if not exists pg_trgm;

-- 1. Exact dedup ------------------------------------------------------------

alter table public.captures
  add column if not exists content_hash text;

create unique index if not exists captures_content_hash_uniq
  on public.captures (content_hash)
  where deleted_at is null and content_hash is not null;

-- 2. Market embedding -------------------------------------------------------

alter table public.markets
  add column if not exists embedding vector(512);

-- No ANN index on purpose. A sequential scan over a few thousand 512-dim rows
-- takes single-digit milliseconds and the planner would not pick an HNSW
-- index at this size. Add one past ~50,000 rows.

-- 3. Retrieval functions ----------------------------------------------------

-- Nearest live markets by cosine similarity (1 - cosine distance).
create or replace function public.match_markets_by_embedding(
  query_embedding vector(512),
  match_count int default 10
)
returns table (id uuid, entity_name text, entity_type text, similarity real)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    m.id,
    m.entity_name,
    m.entity_type,
    (1 - (m.embedding <=> query_embedding))::real as similarity
  from public.markets m
  where m.deleted_at is null
    and m.embedding is not null
  order by m.embedding <=> query_embedding
  limit match_count;
$$;

-- Nearest live markets by trigram similarity on the normalised name.
-- Complements find_similar_market (chunk4.sql), which returns only the top
-- hit above a threshold.
create or replace function public.match_markets_by_name(
  query_name text,
  match_count int default 5,
  min_similarity real default 0.3
)
returns table (id uuid, entity_name text, entity_type text, similarity real)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    m.id,
    m.entity_name,
    m.entity_type,
    similarity(m.entity_name_normalized, query_name) as similarity
  from public.markets m
  where m.deleted_at is null
    and similarity(m.entity_name_normalized, query_name) > min_similarity
  order by similarity(m.entity_name_normalized, query_name) desc
  limit match_count;
$$;

-- 4. Unused columns ---------------------------------------------------------
-- captures.embedding_text, embedding_image and perceptual_hash exist in
-- production but nothing in this repo writes or reads them. They are kept
-- until it is confirmed that nothing outside the repo reads them either.
-- When that is confirmed, uncomment:
--
-- alter table public.captures
--   drop column if exists embedding_text,
--   drop column if exists embedding_image,
--   drop column if exists perceptual_hash;
