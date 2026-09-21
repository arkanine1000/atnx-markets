-- 003_alias_matching.sql
--
-- Name retrieval also scores a market's aliases. A proposal named
-- "Dogecoin" with alias "Doge" should find the market "Doge", and a market
-- created by the pipeline carries the aliases the model gave it, so later
-- variants of the same name land on it. Replaces the function from 001.
--
-- Idempotent.

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
  select s.id, s.entity_name, s.entity_type, s.similarity
  from (
    select
      m.id,
      m.entity_name,
      m.entity_type,
      greatest(
        similarity(m.entity_name_normalized, query_name),
        coalesce(
          (select max(similarity(lower(a), query_name)) from unnest(m.aliases) as a),
          0
        )
      )::real as similarity
    from public.markets m
    where m.deleted_at is null
  ) s
  where s.similarity > min_similarity
  order by s.similarity desc
  limit match_count;
$$;
