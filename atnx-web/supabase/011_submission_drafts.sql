-- 011_submission_drafts.sql
--
-- The review step. A submission no longer becomes a capture in one call:
-- propose runs the pipeline (hash, retrieve, model, route) and stores the
-- result here as a draft with the image parked under a pending storage
-- prefix; the submitter reviews it (crop, pick among bounded choices,
-- accept the nudge toward an existing market or not); commit turns the
-- draft into a capture and, when chosen, a market. Drafts belong to one
-- user, expire fifteen minutes after the last proposal, and are swept by
-- the hourly refresh: the row is kept as an audit trail (status expired),
-- the parked image is deleted.
--
-- Everything the reviewer may choose from is recorded on the draft
-- (`choices`), and commit validates the choice against it, so a client
-- cannot attach to a market it was not offered or create a market under a
-- name the model did not propose.
--
-- Written and read by the server with the service role only; RLS is on
-- with no policies, so no client can reach the table directly.
--
-- Idempotent.

create table if not exists public.submission_drafts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  status           text not null default 'pending'
                     check (status in ('pending', 'committed', 'expired')),
  -- SHA-256 of what will be stored: the (cropped) image bytes, the URL,
  -- or the text. Re-hashed on every recrop.
  content_hash     text not null,
  -- What was submitted.
  media_type       text,
  source_url       text,
  page_title       text,
  page_context     text,
  text             text,
  -- Storage paths of the parked original and, after a recrop, the crop.
  image_path       text,
  crop_path        text,
  image_width      integer,
  image_height     integer,
  -- Crop rectangle applied to the original, in original pixels.
  crop             jsonb,
  recrops          integer not null default 0,
  -- The pipeline's output the reviewer sees: model analysis, scored
  -- candidates, routing decision, resolved subject and the bounded choices.
  analysis         jsonb not null,
  candidates       jsonb not null default '[]'::jsonb,
  decision         jsonb not null,
  nudge            jsonb not null,
  choices          jsonb not null,
  embedding        text,
  -- Outcome.
  capture_id       uuid references public.captures (id) on delete set null,
  market_id        uuid references public.markets (id) on delete set null,
  committed_at     timestamptz,
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists submission_drafts_user_idx
  on public.submission_drafts (user_id, created_at desc);
create index if not exists submission_drafts_pending_expiry_idx
  on public.submission_drafts (expires_at)
  where status = 'pending';

alter table public.submission_drafts enable row level security;

comment on table public.submission_drafts is
  'Review-step drafts: one proposed submission awaiting the submitter''s commit. Server-only.';
comment on column public.submission_drafts.choices is
  'What the reviewer may pick: market ids offered, names, aliases, whether create is allowed and with which parent. Commit validates against this.';
