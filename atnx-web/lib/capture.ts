import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database';
import {
  analyzeSubmission,
  type CandidateMarket,
  type RejectReason,
  type SubmissionAnalysis,
  type VisionMediaType,
} from './vlm';
import { embedText, marketEmbeddingText, toPgVector } from './embed';
import { retrieveCandidates, type RetrievalResult } from './retrieve';
import { LINK_COSINE, LINK_TRIGRAM, recordDecision, routeSubmission } from './route';

// Below the link thresholds but above these, a proposal is checked with the
// model before a new market is created.
const CONFIRM_COSINE = Number(process.env.CONFIRM_COSINE ?? 0.6);
const CONFIRM_TRIGRAM = Number(process.env.CONFIRM_TRIGRAM ?? 0.35);
import { normalizeSearchTerm } from './trends';
import { composeVi } from './signals';
import { addCapture, createMarket, DuplicateCaptureError, recordVi, type Capture } from './store';
import { createAdminClient } from './supabase/admin';

export type { VisionMediaType };

// The shape persisted in captures.raw_ai_response and read by the app UI
// (market cards, hero, market detail) and by the price signals. Kept stable
// across the model swap; it is a projection of SubmissionAnalysis.
export type VisionAnalysis = {
  type: 'meme' | 'trend' | 'person' | 'brand' | 'event' | 'other';
  name: string;
  description: string;
  category: string;
  platforms_detected: string[];
  metrics_detected: Record<string, string | number>;
  sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
  virality_signals: string;
  raw_text: string;
};

export interface ProcessCaptureResult {
  marketId: string | null;
  entityName: string | null;
  isNew: boolean;
  // How the market was decided. 'dedup' means an earlier identical
  // submission answered this one.
  outcome: 'matched' | 'linked' | 'created' | 'created_review' | 'dedup';
  review: boolean;
  // The market's VI as of the response. When viPending is true this is the
  // value before this capture's reading: the sources are fetched after the
  // response goes out, so a brand-new market answers 0 for a few seconds.
  vi: number;
  viPending: boolean;
  source: string;
  analysis: VisionAnalysis;
  // Work that runs after the response: the VI scoring and, for a
  // created_review outcome, one retry with a wider candidate list. Route
  // handlers pass it to after() from next/server.
  background?: () => Promise<void>;
}

// Thrown when the model declines the submission. Routes turn this into a
// 422 with the reason instead of a generic 500.
export class SubmissionRejectedError extends Error {
  readonly reason: RejectReason;
  readonly analysis: SubmissionAnalysis | null;
  constructor(reason: RejectReason, analysis: SubmissionAnalysis | null = null) {
    super(rejectMessage(reason));
    this.name = 'SubmissionRejectedError';
    this.reason = reason;
    this.analysis = analysis;
  }
}

function rejectMessage(reason: RejectReason): string {
  switch (reason) {
    case 'unreadable':
      return "Couldn't read this. Try a clearer screenshot or paste the text.";
    case 'policy':
      return "This content isn't allowed on ATNX.";
    default:
      return "Couldn't find a meme, trend, person, or brand in this. Try a post about something people are talking about.";
  }
}

export function toVisionAnalysis(
  a: SubmissionAnalysis,
  matched?: CandidateMarket
): VisionAnalysis {
  const matchedType = matched?.entityType as VisionAnalysis['type'] | null | undefined;
  return {
    type: a.new_market?.entity_type ?? matchedType ?? 'other',
    name: a.new_market?.name ?? matched?.name ?? '',
    description: a.description,
    category: a.new_market?.category ?? matched?.category ?? '',
    platforms_detected: a.platforms_detected,
    // Screenshot metrics and the free-text virality signal came from the old
    // prompt and no longer feed anything. Kept as empty values so older
    // rows and the UI that reads them keep one shape.
    metrics_detected: {},
    sentiment: a.sentiment,
    virality_signals: '',
    raw_text: a.ocr_text,
  };
}

// SHA-256 of what was submitted: the image bytes, else the normalised URL,
// else the normalised text. Two submissions with the same hash are the same
// submission and get the same answer.
export function contentHash(input: {
  imageBase64?: string;
  url?: string;
  text?: string;
}): string {
  const h = createHash('sha256');
  if (input.imageBase64) {
    h.update('image:');
    h.update(Buffer.from(input.imageBase64, 'base64'));
  } else if (input.url) {
    h.update('url:');
    h.update(normalizeUrl(input.url));
  } else if (input.text) {
    h.update('text:');
    h.update(input.text.toLowerCase().replace(/\s+/g, ' ').trim());
  } else {
    throw new Error('contentHash needs an image, url, or text');
  }
  return h.digest('hex');
}

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|igsh$|si$|s$|t$|ref_src$|ref_url$)/i;

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    let out = u.toString();
    if (out.endsWith('/')) out = out.slice(0, -1);
    return out;
  } catch {
    return raw.trim().toLowerCase();
  }
}

// Earlier result for the same hash, if any. Uses the admin client because
// the earlier capture may belong to another user.
export async function findByHash(hash: string): Promise<ProcessCaptureResult | null> {
  const { data, error } = await createAdminClient()
    .from('captures')
    .select('market_id, raw_ai_response, market:markets(id, entity_name, current_vi)')
    .eq('content_hash', hash)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const market = data.market as { id: string; entity_name: string; current_vi: number } | null;
  const analysis = { ...(data.raw_ai_response ?? {}) } as VisionAnalysis & { _meta?: unknown };
  delete analysis._meta;
  return {
    marketId: data.market_id,
    entityName: market?.entity_name ?? analysis.name ?? null,
    isNew: false,
    outcome: 'dedup',
    review: false,
    vi: Math.round(market?.current_vi ?? 0),
    viPending: false,
    source: 'dedup',
    analysis,
  };
}

// A rejection recorded for the same hash. Rejections store no capture, so
// the audit table is the only place they leave a trace; without this a
// rejected file resubmitted would call the model again every time.
export async function findEarlierRejection(hash: string): Promise<RejectReason | null> {
  const { data, error } = await createAdminClient()
    .from('submission_decisions')
    .select('reject_reason')
    .eq('content_hash', hash)
    .eq('outcome', 'rejected')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const reason = data.reject_reason as RejectReason | null;
  return reason && (['not_cultural_content', 'policy', 'unreadable'] as const).includes(reason)
    ? reason
    : 'not_cultural_content';
}

// Shared capture pipeline used by /api/captures (extension) and /share
// (Android share target). Order: exact dedup by hash, cheap retrieval on
// the text we already have, one model call with those candidates, a
// deterministic link check on the name the model proposed, then persist.
// The VI sources (Trends, Bluesky, GDELT, Wikipedia) are the slowest step
// and the user is not waiting on them, so they run after the response via
// `result.background`. Auth must be established by the caller.
export interface ProcessCaptureInput {
  // At least one of imageBase64 / text is required.
  imageBase64?: string;
  mediaType?: VisionMediaType;
  // Free text the user submitted (web form, or a text-only share).
  text?: string;
  sourceUrl?: string;
  pageTitle?: string;
  pageContext?: string;
  // Dedup key. Defaults to a hash of the image bytes or the text; a URL
  // submission passes contentHash({ url }) so a repeat skips the OG fetch.
  contentHash?: string;
  supabase: SupabaseClient<Database>;
  userId: string;
}

export async function processCapture(opts: ProcessCaptureInput): Promise<ProcessCaptureResult> {
  if (!opts.imageBase64 && !opts.text?.trim()) {
    throw new Error('processCapture needs an image or text');
  }
  const hash =
    opts.contentHash ?? contentHash({ imageBase64: opts.imageBase64, text: opts.text });
  const earlier = await findByHash(hash);
  if (earlier) {
    await recordDecision({
      outcome: 'dedup',
      userId: opts.userId,
      contentHash: hash,
      marketId: earlier.marketId,
    });
    return earlier;
  }
  const earlierReject = await findEarlierRejection(hash);
  if (earlierReject) {
    await recordDecision({
      outcome: 'dedup',
      userId: opts.userId,
      contentHash: hash,
      rejectReason: earlierReject,
    });
    throw new SubmissionRejectedError(earlierReject);
  }

  // Pre-model retrieval on whatever text the caller sent. Page titles from
  // X, Reddit and YouTube usually carry the post text, so this is often
  // enough to surface the right market before the image is even looked at.
  const modelText = [opts.text, opts.pageContext].filter(Boolean).join('\n') || undefined;
  const contextText = [opts.pageTitle, modelText].filter(Boolean).join('\n');
  let candidates: CandidateMarket[] = [];
  let preRetrieval: RetrievalResult | null = null;
  if (contextText.trim().length >= 8) {
    try {
      const queryEmbedding = await embedText(contextText, { purpose: 'query' });
      preRetrieval = await retrieveCandidates({ embedding: queryEmbedding, limit: 10 });
      candidates = preRetrieval.candidates.map(({ id, name, entityType }) => ({ id, name, entityType }));
    } catch (err) {
      // Retrieval is an optimisation; the model call works without it.
      console.warn('[capture] pre-retrieval failed', (err as Error).message);
    }
  }

  const submission = await analyzeSubmission({
    imageBase64: opts.imageBase64,
    mediaType: opts.mediaType,
    text: modelText,
    sourceUrl: opts.sourceUrl,
    pageTitle: opts.pageTitle,
    candidates,
  });

  // Post-model retrieval on the name the model proposed, so a duplicate of
  // an existing market is linked instead of created.
  let postRetrieval: RetrievalResult | null = null;
  let embedding: string | null = null;
  let docEmbedding: number[] | null = null;
  if (submission.admit && !submission.matched_market_id && submission.new_market) {
    const nm = submission.new_market;
    docEmbedding = await embedText(
      marketEmbeddingText({ name: nm.name, aliases: nm.aliases, description: submission.description }),
      { purpose: 'document' }
    );
    embedding = toPgVector(docEmbedding);
    postRetrieval = await retrieveCandidates({
      embedding: docEmbedding,
      names: [nm.name, ...nm.aliases],
      limit: 10,
    });

    // Middle band: something is close but not close enough to link blind.
    // One text-only call shows the model the candidates and lets it decide.
    // Measured at 1.5 to 2.5 s; only paid on ambiguous proposals.
    const best = postRetrieval.best;
    const ambiguous =
      best &&
      ((best.cosine ?? 0) >= CONFIRM_COSINE || (best.trigram ?? 0) >= CONFIRM_TRIGRAM) &&
      (best.cosine ?? 0) < LINK_COSINE &&
      (best.trigram ?? 0) < LINK_TRIGRAM;
    if (ambiguous) {
      const confirmCandidates = postRetrieval.candidates.map(({ id, name, entityType }) => ({
        id,
        name,
        entityType,
      }));
      const confirm = await analyzeSubmission({
        text: [
          `Proposed market: ${nm.name}`,
          nm.aliases.length ? `Aliases: ${nm.aliases.join(', ')}` : '',
          submission.description,
          submission.ocr_text ? `Text in the post: ${submission.ocr_text.slice(0, 600)}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        sourceUrl: opts.sourceUrl,
        pageTitle: opts.pageTitle,
        candidates: confirmCandidates,
      });
      if (confirm.admit && confirm.matched_market_id) {
        const hit = postRetrieval.candidates.find((c) => c.id === confirm.matched_market_id);
        if (hit) {
          // Promote to a link by reporting it at the link threshold; the
          // audit row keeps the measured scores in max_cosine/max_trigram.
          postRetrieval = {
            ...postRetrieval,
            best: { ...hit, cosine: Math.max(hit.cosine ?? 0, LINK_COSINE) },
          };
        }
      }
    }
  }

  const decision = routeSubmission({
    submission,
    shownCandidates: candidates,
    postRetrieval,
    embedding,
  });

  const audit = {
    userId: opts.userId,
    contentHash: hash,
    candidates: postRetrieval?.candidates ?? candidates,
    retrieval: postRetrieval ?? preRetrieval,
    submission,
  };

  if (decision.outcome === 'rejected') {
    await recordDecision({ ...audit, outcome: 'rejected', rejectReason: decision.reason });
    throw new SubmissionRejectedError(decision.reason, submission);
  }

  // Resolve the market row the capture attaches to.
  let marketId: string;
  let similarity: number | null;
  let matched: CandidateMarket | undefined;
  let createdMarketId: string | null = null;
  if (decision.outcome === 'matched' || decision.outcome === 'linked') {
    marketId = decision.marketId;
    similarity = decision.similarity;
    matched = decision.matched;
  } else {
    const { market, created } = await createMarket({
      name: decision.newMarket.name,
      entityType: decision.newMarket.entityType,
      category: decision.newMarket.category,
      aliases: decision.newMarket.aliases,
      embedding: decision.newMarket.embedding,
    });
    marketId = market.id;
    // Lost a race to an identical name: treat as a link to the winner.
    similarity = created ? null : 1;
    if (created) createdMarketId = market.id;
    else matched = { id: market.id, name: market.entity_name, entityType: market.entity_type };
  }
  const review = decision.outcome === 'created_review' && createdMarketId !== null;

  const analysis = toVisionAnalysis(submission, matched);

  // Persist unscored: the market keeps its current VI until the deferred
  // scoring below records this capture's reading.
  const input: Capture = {
    id: crypto.randomUUID(),
    marketId: null,
    timestamp: new Date().toISOString(),
    pageUrl: opts.sourceUrl ?? '',
    pageTitle: opts.pageTitle ?? '',
    screenshot: opts.imageBase64 ?? '',
    analysis,
    trends: null,
    viralityScore: 0,
    scored: false,
  };

  let capture: Capture;
  let isNew: boolean;
  try {
    ({ capture, isNew } = await addCapture(input, opts.supabase, opts.userId, {
      marketId,
      similarity,
      review,
      contentHash: hash,
      mediaType: opts.mediaType ?? null,
    }));
  } catch (err) {
    if (err instanceof DuplicateCaptureError) {
      const winner = await findByHash(hash);
      if (winner) {
        await recordDecision({ ...audit, outcome: 'dedup', marketId: winner.marketId });
        return winner;
      }
    }
    throw err;
  }

  // A create that lost the name race to a concurrent request is a link.
  const outcome: ProcessCaptureResult['outcome'] =
    decision.outcome === 'matched' || decision.outcome === 'linked' || createdMarketId !== null
      ? decision.outcome
      : 'linked';
  await recordDecision({ ...audit, outcome, captureId: capture.id, marketId });

  const result: ProcessCaptureResult = {
    marketId: capture.marketId,
    entityName: analysis.name || null,
    isNew,
    outcome,
    review,
    // The market's VI before this capture's reading; the sources are
    // fetched after the response.
    vi: Math.round(capture.viralityScore),
    viPending: true,
    source: 'pending',
    analysis,
  };

  const scoring: ScoringContext = {
    marketId,
    term: normalizeSearchTerm(analysis),
    // Straight from the model for a market created just now; read from the
    // row for an existing one (inside the background task, not here).
    aliases: 'newMarket' in decision ? decision.newMarket.aliases : null,
  };
  const retry: RetryContext | null =
    review && createdMarketId && docEmbedding
      ? {
          captureId: capture.id,
          createdMarketId,
          docEmbedding,
          userId: opts.userId,
          contentHash: hash,
          imageBase64: opts.imageBase64,
          mediaType: opts.mediaType,
          text: modelText,
          sourceUrl: opts.sourceUrl,
          pageTitle: opts.pageTitle,
        }
      : null;

  result.background = async () => {
    // The retry may move the capture to an existing market; that market
    // already has a score and the refresh keeps it fresh, so scoring the
    // retired one would be wasted.
    if (retry && (await retryLowConfidence(retry))) return;
    await scoreMarketLater(scoring);
  };

  return result;
}

interface ScoringContext {
  marketId: string;
  term: string;
  aliases: string[] | null;
}

// Every VI source, fresh, then one vi_history point (seeded from the Trends
// series on a market's first reading). Runs after the response. A failure
// here costs nothing visible: the five-minute refresh scores every live
// market, so the value lands on the next pass instead.
async function scoreMarketLater(ctx: ScoringContext): Promise<void> {
  try {
    const aliases = ctx.aliases ?? (await marketAliases(ctx.marketId));
    const signal = await composeVi({ term: ctx.term, aliases });
    if (signal.score === null) return;
    await recordVi(ctx.marketId, signal.score, signal.components, signal.seedSeries);
  } catch (err) {
    console.error('[capture] deferred VI scoring failed', (err as Error).message);
  }
}

async function marketAliases(marketId: string): Promise<string[]> {
  const { data } = await createAdminClient().from('markets').select('aliases').eq('id', marketId).maybeSingle();
  return (data?.aliases as string[] | null) ?? [];
}

interface RetryContext {
  captureId: string;
  createdMarketId: string;
  docEmbedding: number[];
  userId: string;
  contentHash: string;
  imageBase64?: string;
  mediaType?: VisionMediaType;
  text?: string;
  sourceUrl?: string;
  pageTitle?: string;
}

// One retry for a low-confidence create, run after the response was sent.
// The candidate list is widened to twenty markets nearest the market that
// was just created. If the model now matches one of them, the capture is
// re-linked, the created market is soft-deleted, and both are logged.
// Resolves true when the capture was re-linked.
async function retryLowConfidence(ctx: RetryContext): Promise<boolean> {
  try {
    const wide = await retrieveCandidates({ embedding: ctx.docEmbedding, limit: 21 });
    const candidates = wide.candidates
      .filter((c) => c.id !== ctx.createdMarketId)
      .slice(0, 20)
      .map(({ id, name, entityType }) => ({ id, name, entityType }));
    if (candidates.length === 0) return false;

    const retry = await analyzeSubmission({
      imageBase64: ctx.imageBase64,
      mediaType: ctx.mediaType,
      text: ctx.text,
      sourceUrl: ctx.sourceUrl,
      pageTitle: ctx.pageTitle,
      candidates,
    });

    const matched = retry.matched_market_id
      ? candidates.find((c) => c.id === retry.matched_market_id)
      : undefined;
    if (!retry.admit || !matched) return false;

    const admin = createAdminClient();
    const now = new Date().toISOString();

    const { error: capErr } = await admin
      .from('captures')
      .update({ market_id: matched.id, resolution_status: 'resolved', confidence_score: 1 })
      .eq('id', ctx.captureId);
    if (capErr) throw capErr;

    // Only retire the created market if nothing else attached to it meanwhile.
    const { count } = await admin
      .from('captures')
      .select('id', { count: 'exact', head: true })
      .eq('market_id', ctx.createdMarketId)
      .is('deleted_at', null);
    if ((count ?? 0) === 0) {
      await admin.from('markets').update({ deleted_at: now }).eq('id', ctx.createdMarketId);
    }

    const { data: target } = await admin
      .from('markets')
      .select('total_captures')
      .eq('id', matched.id)
      .maybeSingle();
    await admin
      .from('markets')
      .update({ total_captures: (target?.total_captures ?? 0) + 1 })
      .eq('id', matched.id);

    await recordDecision({
      outcome: 'relinked',
      captureId: ctx.captureId,
      userId: ctx.userId,
      contentHash: ctx.contentHash,
      marketId: matched.id,
      candidates,
      retrieval: wide,
      submission: retry,
      extra: { retired_market_id: ctx.createdMarketId },
    });
    return true;
  } catch (err) {
    console.error('[capture] low-confidence retry failed', (err as Error).message);
    return false;
  }
}

const SUPPORTED_MEDIA: VisionMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

export function toMediaType(mime: string): VisionMediaType {
  const normalized = (mime || '').toLowerCase() as VisionMediaType;
  return SUPPORTED_MEDIA.includes(normalized) ? normalized : 'image/png';
}
