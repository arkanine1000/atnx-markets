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
import { retrieveCandidates, type RetrievalResult, type ScoredCandidate } from './retrieve';
import {
  LINK_COSINE,
  LINK_TRIGRAM,
  recordDecision,
  routeSubmission,
  type RoutingDecision,
} from './route';
import {
  buildReview,
  CONFIRM_COSINE,
  CONFIRM_TRIGRAM,
  cropImage,
  imageSize,
  isCreateLimitExempt,
  isNewAccount,
  loadDraft,
  MARKET_CREATE_DAILY_LIMIT,
  markDraftCommitted,
  marketDetails,
  marketsCreatedToday,
  MAX_RECROPS,
  newExpiry,
  parkImage,
  pendingImagePath,
  readParkedImage,
  removeParkedImages,
  ReviewError,
  saveDraft,
  toView,
  updateDraft,
  validateCrop,
  type ReviewChoice,
  type ReviewDraft,
  type ReviewDraftView,
  type SubjectResolution,
} from './review';
import { normalizeSearchTerm } from './trends';
import { composeVi, prefetchSlowSources, scoreTerms, creatorOf } from './signals';
import { describeMarkets } from './describe';
import { guardProposal } from './blocklist';
import { runChannelJob, verifiedYoutubeHandles } from './creators/channel';
import { runXAccountJob, verifiedXHandles } from './creators/x-account';
import { runGdeltJob } from './vi/gdelt';
import { hasXRow, hasYoutubeRow, resolveAndSave, resolveAndSaveX, X_ACCOUNT_TYPES } from './creators/store';
import type { Components } from './vi/score';
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
  // Work that runs after the response: the VI scoring and, on the one-shot
  // path, one retry for a low-confidence create. Route handlers pass it to
  // after() from next/server.
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
      return "Couldn't match this to a meme, trend, person, or brand. Fully custom submissions aren't live in the current beta.";
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

// Shared capture pipeline. Two halves:
//
//   propose  hash dedup, cheap retrieval on the text we already have, one
//            model call with those candidates, a deterministic link check on
//            the name the model proposed, the subject the content is about,
//            and the bounded choices the reviewer gets. Persists a draft and
//            parks the image; creates nothing else.
//   commit   the reviewer's choice, validated against the draft, then the
//            tail: create or attach, upload, audit. VI scoring runs after the
//            response via `result.background`.
//
// processCapture() is the one-shot path (eval script, older clients): propose
// in memory and commit the default choice at once. Auth must be established
// by the caller.
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

// --- Stage one: analyse and route -------------------------------------------

interface AnalysisStage {
  submission: SubmissionAnalysis;
  shownCandidates: CandidateMarket[];
  preRetrieval: RetrievalResult | null;
  postRetrieval: RetrievalResult | null;
  decision: RoutingDecision;
  embedding: string | null;
  docEmbedding: number[] | null;
}

async function analyseAndRoute(opts: {
  imageBase64?: string;
  mediaType?: VisionMediaType;
  text?: string;
  sourceUrl?: string;
  pageTitle?: string;
  pageContext?: string;
  // One-shot path only: ask the model about a proposal that is close to an
  // existing market but not close enough to link blind. With a reviewer,
  // the candidates are shown to them instead.
  confirmAmbiguous: boolean;
}): Promise<AnalysisStage> {
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

    const best = postRetrieval.best;
    const ambiguous =
      best &&
      ((best.cosine ?? 0) >= CONFIRM_COSINE || (best.trigram ?? 0) >= CONFIRM_TRIGRAM) &&
      (best.cosine ?? 0) < LINK_COSINE &&
      (best.trigram ?? 0) < LINK_TRIGRAM;
    if (ambiguous && opts.confirmAmbiguous) {
      // Measured at 1.5 to 2.5 s; only paid on ambiguous proposals.
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

  // A proposal to create is checked against the generic-phrase rule and
  // the retired names (lib/blocklist.ts) before anything is created.
  const decision = await guardProposal(
    routeSubmission({
      submission,
      shownCandidates: candidates,
      postRetrieval,
      embedding,
    }),
    { captureText: [submission.description, submission.ocr_text].filter(Boolean).join('\n') }
  );
  if (decision.outcome === 'rejected' && decision.blocked) console.log(`[capture] proposal blocked: ${decision.blocked}`);

  return { submission, shownCandidates: candidates, preRetrieval, postRetrieval, decision, embedding, docEmbedding };
}

// The market the model's subject refers to. An id is taken as shown; a
// name is matched against existing markets and only a hit at the link
// threshold counts. Anything else becomes a proposal to create.
async function resolveSubject(s: SubmissionAnalysis): Promise<SubjectResolution> {
  if (s.subject_market_id) {
    const details = await marketDetails([s.subject_market_id]);
    const existing = details.get(s.subject_market_id) ?? null;
    if (existing) return { existing, proposal: null };
  }
  if (s.subject_name && s.subject_entity_type) {
    const hits = await retrieveCandidates({ names: [s.subject_name], limit: 3 });
    const best = hits.best;
    if (best && (best.trigram ?? 0) >= LINK_TRIGRAM) {
      const details = await marketDetails([best.id]);
      const existing = details.get(best.id) ?? null;
      if (existing) return { existing, proposal: null };
    }
    return { existing: null, proposal: { name: s.subject_name, entityType: s.subject_entity_type } };
  }
  return { existing: null, proposal: null };
}

// The candidate list the reviewer sees and the audit row records: what the
// proposal's name retrieval found, else what the context found.
function reviewCandidates(stage: AnalysisStage): ScoredCandidate[] {
  const r = stage.postRetrieval ?? stage.preRetrieval;
  return r?.candidates ?? [];
}

function retrievalFor(candidates: ScoredCandidate[]): RetrievalResult {
  let maxCosine: number | null = null;
  let maxTrigram: number | null = null;
  for (const c of candidates) {
    if (c.cosine !== null) maxCosine = Math.max(maxCosine ?? -Infinity, c.cosine);
    if (c.trigram !== null) maxTrigram = Math.max(maxTrigram ?? -Infinity, c.trigram);
  }
  return { candidates, maxCosine, maxTrigram, best: candidates[0] ?? null };
}

async function reviewFor(
  stage: AnalysisStage
): Promise<Pick<ReviewDraft, 'candidates' | 'nudge' | 'choices'>> {
  const candidates = reviewCandidates(stage);
  const subject = await resolveSubject(stage.submission);
  const ids = candidates.map((c) => c.id);
  if (stage.decision.outcome === 'matched' || stage.decision.outcome === 'linked') {
    ids.push(stage.decision.marketId);
  }
  if (subject.existing) ids.push(subject.existing.id);
  const details = await marketDetails(ids);
  const { nudge, choices } = buildReview({
    submission: stage.submission,
    decision: stage.decision,
    candidates,
    details,
    subject,
  });
  return { candidates, nudge, choices };
}

// --- Propose ----------------------------------------------------------------

export type ProposeOutcome =
  | { kind: 'final'; result: ProcessCaptureResult }
  | { kind: 'draft'; draft: ReviewDraft; view: ReviewDraftView };

export interface ProposeOptions {
  // Store the draft and park the image so a later request can commit it.
  // The one-shot path keeps everything in memory.
  persist: boolean;
  confirmAmbiguous?: boolean;
}

export async function proposeCapture(
  opts: ProcessCaptureInput,
  po: ProposeOptions
): Promise<ProposeOutcome> {
  if (!opts.imageBase64 && !opts.text?.trim()) {
    throw new Error('proposeCapture needs an image or text');
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
    return { kind: 'final', result: earlier };
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

  const stage = await analyseAndRoute({
    imageBase64: opts.imageBase64,
    mediaType: opts.mediaType,
    text: opts.text,
    sourceUrl: opts.sourceUrl,
    pageTitle: opts.pageTitle,
    pageContext: opts.pageContext,
    confirmAmbiguous: po.confirmAmbiguous ?? false,
  });

  // Rejections are not appealable and skip review.
  if (stage.decision.outcome === 'rejected') {
    await recordDecision({
      userId: opts.userId,
      contentHash: hash,
      candidates: stage.postRetrieval?.candidates ?? stage.shownCandidates,
      retrieval: stage.postRetrieval ?? stage.preRetrieval,
      submission: stage.submission,
      outcome: 'rejected',
      rejectReason: stage.decision.reason,
      extra: stage.decision.jev ? { jev: stage.decision.jev } : undefined,
    });
    throw new SubmissionRejectedError(stage.decision.reason, stage.submission);
  }

  const review = await reviewFor(stage);
  const id = crypto.randomUUID();
  const modelText = [opts.text, opts.pageContext].filter(Boolean).join('\n') || null;

  const draft: ReviewDraft = {
    id,
    userId: opts.userId,
    status: 'pending',
    contentHash: hash,
    mediaType: opts.mediaType ?? null,
    sourceUrl: opts.sourceUrl ?? null,
    pageTitle: opts.pageTitle ?? null,
    pageContext: opts.pageContext ?? null,
    text: opts.text ?? null,
    imagePath: null,
    cropPath: null,
    imageWidth: null,
    imageHeight: null,
    crop: null,
    recrops: 0,
    submission: stage.submission,
    candidates: review.candidates,
    decision: stage.decision,
    nudge: review.nudge,
    choices: review.choices,
    embedding: stage.embedding,
    expiresAt: newExpiry(),
    imageBase64: opts.imageBase64,
    docEmbedding: stage.docEmbedding,
  };
  void modelText;

  if (po.persist && opts.imageBase64) {
    const bytes = Buffer.from(opts.imageBase64, 'base64');
    try {
      const size = await imageSize(bytes);
      draft.imageWidth = size.width;
      draft.imageHeight = size.height;
    } catch (err) {
      // No dimensions means no crop; the review still works.
      console.warn('[capture] image size unreadable', (err as Error).message);
    }
    draft.imagePath = pendingImagePath(opts.userId, id);
    await parkImage(draft.imagePath, bytes, opts.mediaType ?? 'image/png');
  }
  if (po.persist) await saveDraft(draft);

  return { kind: 'draft', draft, view: toView(draft) };
}

// --- Commit -----------------------------------------------------------------

export interface CommitOptions {
  supabase: SupabaseClient<Database>;
  userId: string;
  choice: ReviewChoice;
  // The draft lives in submission_drafts (review path) rather than only in
  // memory (one-shot path).
  persisted: boolean;
  // One-shot path: a low-confidence create gets one model retry with a
  // wider candidate list. With a reviewer, the reviewer is the retry.
  lowConfidenceRetry?: boolean;
}

export async function commitDraft(
  draft: ReviewDraft,
  opts: CommitOptions
): Promise<ProcessCaptureResult> {
  const { choice } = opts;
  const s = draft.submission;
  const strongId = draft.choices.strongMatchId;

  if (choice.kind === 'create' && strongId && (await isNewAccount(opts.userId))) {
    throw new ReviewError(
      'New accounts cannot create a market over a strong match. Attach it to the existing market for now.',
      403,
      'override_not_allowed'
    );
  }
  if (choice.kind !== 'attach' && !(await isCreateLimitExempt(opts.userId))) {
    const created = await marketsCreatedToday(opts.userId);
    if (created >= MARKET_CREATE_DAILY_LIMIT) {
      throw new ReviewError(
        `You have created ${created} markets in the last day, the limit. Attach this to an existing market or come back later.`,
        429,
        'create_limit'
      );
    }
  }

  // Hash dedup still applies at commit: the same bytes may have been
  // committed by someone else while this draft sat in review.
  const hash = draft.contentHash;
  const earlier = await findByHash(hash);
  if (earlier) {
    await recordDecision({ outcome: 'dedup', userId: opts.userId, contentHash: hash, marketId: earlier.marketId });
    if (opts.persisted) {
      await markDraftCommitted(draft.id, null, earlier.marketId);
      await removeParkedImages([draft.imagePath, draft.cropPath]);
    }
    return earlier;
  }

  // The image that gets stored: the crop when there is one, else the
  // original, from memory on the one-shot path and from storage otherwise.
  let imageBase64 = draft.imageBase64;
  let mediaType: VisionMediaType | null = (draft.mediaType as VisionMediaType | null) ?? null;
  if (!imageBase64 && (draft.cropPath || draft.imagePath)) {
    const bytes = await readParkedImage((draft.cropPath ?? draft.imagePath) as string);
    imageBase64 = bytes.toString('base64');
  }
  if (draft.cropPath) mediaType = 'image/jpeg';

  const audit = {
    userId: opts.userId,
    contentHash: hash,
    candidates: draft.candidates,
    retrieval: retrievalFor(draft.candidates),
    submission: s,
  };

  // Resolve the market row the capture attaches to.
  let marketId: string;
  let similarity: number | null;
  let matched: CandidateMarket | undefined;
  let createdMarketId: string | null = null;
  let outcome: ProcessCaptureResult['outcome'];
  let analysis: VisionAnalysis;
  let extra: Record<string, string | boolean> = {};
  let scoringAliases: string[] | null = null;

  const offered = [...draft.nudge.candidates, ...(draft.nudge.subject ? [draft.nudge.subject] : [])];

  if (choice.kind === 'attach') {
    const target = offered.find((m) => m.id === choice.marketId);
    if (!target) throw new ReviewError('That market was not offered for this submission');
    marketId = target.id;
    matched = { id: target.id, name: target.name, entityType: target.entityType, category: target.category };
    if (target.id === strongId) {
      similarity = draft.decision.outcome === 'matched' || draft.decision.outcome === 'linked'
        ? draft.decision.similarity
        : 1;
      outcome = draft.decision.outcome === 'matched' ? 'matched' : 'linked';
    } else {
      similarity = target.similarity ?? 1;
      outcome = 'linked';
      extra = { chosen_by: 'reviewer', relation: target.relation };
    }
    // The capture lands on that market, so it carries that market's name
    // and type; the market page titles itself from its newest capture.
    // The description keeps what this particular post is.
    analysis = {
      ...toVisionAnalysis(s, matched),
      name: target.name,
      type: (target.entityType as VisionAnalysis['type'] | null) ?? 'other',
      category: target.category ?? s.new_market?.category ?? '',
    };
  } else {
    const spec =
      choice.kind === 'create'
        ? {
            name: choice.name,
            entityType: choice.entityType,
            category: choice.category,
            aliases: choice.aliases,
            embedding: draft.embedding,
            parentMarketId: choice.parentMarketId,
          }
        : await subjectMarketSpec(draft);
    const { market, created } = await createMarket({ ...spec, createdBy: opts.userId });
    marketId = market.id;
    // Lost a race to an identical name: treat as a link to the winner.
    similarity = created ? null : 1;
    if (created) {
      createdMarketId = market.id;
      const override = choice.kind === 'create' && strongId !== null;
      outcome = override || s.confidence === 'low' ? 'created_review' : 'created';
      if (override) extra = { overrode_market_id: strongId as string };
      if (choice.kind === 'create_subject') extra = { created_subject_market: true };
      if (choice.kind === 'create' && choice.parentMarketId) {
        extra = { ...extra, parent_market_id: choice.parentMarketId };
      }
    } else {
      outcome = 'linked';
      matched = { id: market.id, name: market.entity_name, entityType: market.entity_type };
    }
    scoringAliases = spec.aliases;
    analysis = toVisionAnalysis(s, matched);
    if (choice.kind === 'create_subject') {
      analysis = { ...analysis, name: spec.name, type: spec.entityType as VisionAnalysis['type'] };
    } else if (choice.kind === 'create') {
      analysis = {
        ...analysis,
        name: spec.name,
        type: spec.entityType as VisionAnalysis['type'],
        category: spec.category,
      };
    }
  }
  const review = outcome === 'created_review' && createdMarketId !== null;

  // Persist unscored: the market keeps its current VI until the deferred
  // scoring below records this capture's reading.
  const input: Capture = {
    id: crypto.randomUUID(),
    marketId: null,
    timestamp: new Date().toISOString(),
    pageUrl: draft.sourceUrl ?? '',
    pageTitle: draft.pageTitle ?? '',
    screenshot: imageBase64 ?? '',
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
      mediaType,
    }));
  } catch (err) {
    if (err instanceof DuplicateCaptureError) {
      const winner = await findByHash(hash);
      if (winner) {
        await recordDecision({ ...audit, outcome: 'dedup', marketId: winner.marketId });
        if (opts.persisted) await markDraftCommitted(draft.id, null, winner.marketId);
        return winner;
      }
    }
    throw err;
  }

  await recordDecision({ ...audit, outcome, captureId: capture.id, marketId, extra: { ...extra, ...(draft.decision.jev ? { jev: draft.decision.jev } : {}) } });
  if (opts.persisted) {
    await markDraftCommitted(draft.id, capture.id, marketId);
    await removeParkedImages([draft.imagePath, draft.cropPath]);
  }

  const result: ProcessCaptureResult = {
    marketId: capture.marketId,
    entityName: analysis.name || null,
    isNew,
    outcome,
    review,
    vi: Math.round(capture.viralityScore),
    viPending: true,
    source: 'pending',
    analysis,
  };

  const scoring: ScoringContext = {
    marketId,
    term: normalizeSearchTerm(analysis),
    aliases: createdMarketId ? scoringAliases : null,
  };
  const retry: RetryContext | null =
    opts.lowConfidenceRetry && review && createdMarketId && draft.docEmbedding
      ? {
          captureId: capture.id,
          createdMarketId,
          docEmbedding: draft.docEmbedding,
          userId: opts.userId,
          contentHash: hash,
          imageBase64: draft.imageBase64,
          mediaType: (draft.mediaType as VisionMediaType | null) ?? undefined,
          text: [draft.text, draft.pageContext].filter(Boolean).join('\n') || undefined,
          sourceUrl: draft.sourceUrl ?? undefined,
          pageTitle: draft.pageTitle ?? undefined,
        }
      : null;

  result.background = async () => {
    // The retry may move the capture to an existing market; that market
    // already has a score and the refresh keeps it fresh, so scoring the
    // retired one would be wasted.
    if (retry && (await retryLowConfidence(retry))) return;
    // A new market gets one full pass over every source before it shows a
    // number or trades (supabase/018); a capture on an existing market
    // only refreshes its score.
    if (createdMarketId) await scoreNewMarket(scoring);
    else await scoreMarketLater(scoring);
  };

  return result;
}

// A market for the subject the model named, embedded on its own name so
// later proposals of the same subject find it.
async function subjectMarketSpec(draft: ReviewDraft) {
  const cs = draft.choices.createSubject;
  if (!cs) throw new ReviewError('No subject market to create here');
  let embedding: string | null = null;
  try {
    embedding = toPgVector(
      await embedText(marketEmbeddingText({ name: cs.name, aliases: [], description: '' }), {
        purpose: 'document',
      })
    );
  } catch (err) {
    console.warn('[capture] subject embedding failed', (err as Error).message);
  }
  return {
    name: cs.name,
    entityType: cs.entityType,
    category: cs.category,
    aliases: [] as string[],
    embedding,
    parentMarketId: null,
  };
}

// --- Recrop -----------------------------------------------------------------

// The reviewer's crop rectangle, applied to the server's copy of the
// original. Re-hashes, re-analyses (one more model call) and rewrites the
// draft's proposal, nudge and choices. Capped at MAX_RECROPS per draft.
export async function recropDraft(draft: ReviewDraft, rect: unknown): Promise<ProposeOutcome> {
  if (!draft.imagePath || !draft.imageWidth || !draft.imageHeight) {
    throw new ReviewError('This submission has no image to crop');
  }
  if (draft.recrops >= MAX_RECROPS) {
    throw new ReviewError(`No re-crops left (${MAX_RECROPS} per submission)`, 429, 'recrop_limit');
  }
  const crop = validateCrop(rect, draft.imageWidth, draft.imageHeight);
  const original = await readParkedImage(draft.imagePath);
  const cropped = await cropImage(original, crop);
  const imageBase64 = cropped.toString('base64');
  const hash = contentHash({ imageBase64 });

  const earlier = await findByHash(hash);
  if (earlier) {
    await recordDecision({ outcome: 'dedup', userId: draft.userId, contentHash: hash, marketId: earlier.marketId });
    await markDraftCommitted(draft.id, null, earlier.marketId);
    await removeParkedImages([draft.imagePath, draft.cropPath]);
    return { kind: 'final', result: earlier };
  }
  const earlierReject = await findEarlierRejection(hash);
  if (earlierReject) throw new SubmissionRejectedError(earlierReject);

  draft.recrops += 1;
  const stage = await analyseAndRoute({
    imageBase64,
    mediaType: 'image/jpeg',
    text: draft.text ?? undefined,
    sourceUrl: draft.sourceUrl ?? undefined,
    pageTitle: draft.pageTitle ?? undefined,
    pageContext: draft.pageContext ?? undefined,
    confirmAmbiguous: false,
  });
  if (stage.decision.outcome === 'rejected') {
    await recordDecision({
      userId: draft.userId,
      contentHash: hash,
      candidates: stage.postRetrieval?.candidates ?? stage.shownCandidates,
      retrieval: stage.postRetrieval ?? stage.preRetrieval,
      submission: stage.submission,
      outcome: 'rejected',
      rejectReason: stage.decision.reason,
      extra: stage.decision.jev ? { jev: stage.decision.jev } : undefined,
    });
    // The crop was the problem; the draft keeps its earlier proposal.
    await updateDraft(draft);
    throw new SubmissionRejectedError(stage.decision.reason, stage.submission);
  }

  const review = await reviewFor(stage);
  const cropPath = pendingImagePath(draft.userId, draft.id, '-crop');
  await parkImage(cropPath, cropped, 'image/jpeg');

  Object.assign(draft, {
    contentHash: hash,
    cropPath,
    crop,
    submission: stage.submission,
    candidates: review.candidates,
    decision: stage.decision,
    nudge: review.nudge,
    choices: review.choices,
    embedding: stage.embedding,
    expiresAt: newExpiry(),
  } satisfies Partial<ReviewDraft>);
  await updateDraft(draft);
  return { kind: 'draft', draft, view: toView(draft) };
}

// Loads a user's pending draft or throws a ReviewError (410) if it is gone.
export { loadDraft };

// --- One-shot ---------------------------------------------------------------

// Propose and commit the default choice in one call. What every client did
// before the review step; kept for the eval script and older clients.
export async function processCapture(opts: ProcessCaptureInput): Promise<ProcessCaptureResult> {
  const proposed = await proposeCapture(opts, { persist: false, confirmAmbiguous: true });
  if (proposed.kind === 'final') return proposed.result;
  const { draft } = proposed;
  const nm = draft.submission.new_market;
  // Without a reviewer the subject nudge is not taken: a strong match
  // attaches, anything else creates, as before.
  const choice: ReviewChoice = draft.choices.strongMatchId
    ? { kind: 'attach', marketId: draft.choices.strongMatchId }
    : nm
      ? {
          kind: 'create',
          name: nm.name,
          entityType: nm.entity_type,
          category: nm.category,
          aliases: nm.aliases,
          parentMarketId: null,
        }
      : draft.nudge.defaultChoice;
  return commitDraft(draft, {
    supabase: opts.supabase,
    userId: opts.userId,
    choice,
    persisted: false,
    lowConfidenceRetry: true,
  });
}

// --- After the response -----------------------------------------------------

interface ScoringContext {
  marketId: string;
  term: string;
  aliases: string[] | null;
}

// Every VI source, fresh, then one vi_history point (seeded from the Trends
// series on a market's first reading). Runs after the response. A failure
// here costs nothing visible: the five-minute refresh scores every live
// market, so the value lands on the next pass instead.
//
// The market row supplies the term, aliases, type and the breakdown from
// earlier passes, so the capture scores the same string the refresh does
// and a source that fails here keeps its stored reading instead of
// thinning the breakdown to whatever answered. GDELT is read from the
// hourly job's samples, so a new market's first GDELT reading comes with
// the next slow refresh.
// A new market's first score, from every source rather than the ones that
// answer within the capture's minute: the creator handle, GDELT's count for
// today, the creator channel and a TikTok read are what the hourly refresh
// would otherwise add over the next hours, drifting the number the market
// first showed. The market goes live with this write. Runs after the
// response (the capture routes allow 300 s for it; the TikTok actor alone
// takes 30-40 s). If it fails, the next slow refresh does the same pass.
async function scoreNewMarket(ctx: ScoringContext): Promise<void> {
  try {
    const { data: market } = await createAdminClient()
      .from('markets')
      .select('entity_name, entity_type, category, aliases, vi_components')
      .eq('id', ctx.marketId)
      .maybeSingle();
    if (!market) return;
    if (market.entity_type === 'person' && !(await hasYoutubeRow(ctx.marketId))) {
      await resolveAndSave(ctx.marketId).catch((err) => console.error('[capture] resolve failed', (err as Error).message));
    }
    if (X_ACCOUNT_TYPES.includes(market.entity_type ?? '') && !(await hasXRow(ctx.marketId))) {
      await resolveAndSaveX(ctx.marketId).catch((err) => console.error('[capture] x resolve failed', (err as Error).message));
    }
    const now = Date.now();
    await Promise.allSettled([runGdeltJob(now, { marketIds: [ctx.marketId], backfill: false }), runChannelJob(now, [ctx.marketId]), runXAccountJob(now, [ctx.marketId])]);
    const [[handle], [xHandle]] = await Promise.all([verifiedYoutubeHandles([ctx.marketId]), verifiedXHandles([ctx.marketId])]);
    const request = {
      term: normalizeSearchTerm({ name: market.entity_name }),
      aliases: ctx.aliases ?? ((market.aliases as string[] | null) ?? []),
      entityType: (market.entity_type as string | null) ?? null,
      category: (market.category as string | null) ?? null,
      description: ((market as { description?: string | null }).description ?? null),
      marketId: ctx.marketId,
      stored: (market.vi_components as Components | null) ?? null,
      creator: creatorOf(handle, xHandle),
    };
    prefetchSlowSources([request]);
    const [signal] = await scoreTerms([request], 'all');
    // No source knowing the term is still a finished pass: live at 0.
    await recordVi(ctx.marketId, signal.score ?? 0, signal.components, signal.seedSeries, { fullPass: true });
  } catch (err) {
    console.error('[capture] new-market scoring failed', (err as Error).message);
  }
  // Its description, now that the Wikipedia reading says whether it owns
  // an article (lib/describe.ts); the hourly pass catches a miss.
  try {
    const { log } = await describeMarkets({ marketIds: [ctx.marketId], force: true });
    if (log.length) console.log('[describe]', log.join('; '));
  } catch (err) {
    console.error('[capture] new-market description failed', (err as Error).message);
  }
}

async function scoreMarketLater(ctx: ScoringContext): Promise<void> {
  try {
    const { data: market } = await createAdminClient()
      .from('markets')
      .select('entity_name, entity_type, category, aliases, vi_components')
      .eq('id', ctx.marketId)
      .maybeSingle();
    const term = market?.entity_name ? normalizeSearchTerm({ name: market.entity_name }) : ctx.term;
    const aliases = ctx.aliases ?? ((market?.aliases as string[] | null) ?? []);
    // A person market's own channel is looked up once, before its first
    // score; the hourly pass re-checks it weekly (lib/creators/store.ts).
    if (market?.entity_type === 'person' && !(await hasYoutubeRow(ctx.marketId))) {
      await resolveAndSave(ctx.marketId).catch((err) => console.error('[creators] resolve at capture failed', (err as Error).message));
    }
    if (X_ACCOUNT_TYPES.includes(market?.entity_type ?? '') && !(await hasXRow(ctx.marketId))) {
      await resolveAndSaveX(ctx.marketId).catch((err) => console.error('[creators:x] resolve at capture failed', (err as Error).message));
    }
    const [[handle], [xHandle]] = await Promise.all([verifiedYoutubeHandles([ctx.marketId]), verifiedXHandles([ctx.marketId])]);
    const signal = await composeVi(
      {
        term,
        aliases,
        entityType: (market?.entity_type as string | null) ?? null,
        category: (market?.category as string | null) ?? null,
        marketId: ctx.marketId,
        stored: (market?.vi_components as Components | null) ?? null,
        creator: creatorOf(handle, xHandle),
      }
    );
    if (signal.score === null) return;
    await recordVi(ctx.marketId, signal.score, signal.components, signal.seedSeries);
  } catch (err) {
    console.error('[capture] deferred VI scoring failed', (err as Error).message);
  }
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
