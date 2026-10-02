import sharp from 'sharp';
import { createAdminClient } from './supabase/admin';
import type { Json } from './supabase/database';
import { CATEGORIES, ENTITY_TYPES, type SubjectType, type SubmissionAnalysis } from './vlm';
import type { ScoredCandidate } from './retrieve';
import type { RoutingDecision } from './route';

// The review step between capture and market creation. Propose (in
// lib/capture.ts) runs the pipeline and stores a draft here; the submitter
// reviews it; commit validates their choice against what the draft offered
// and runs the persisting tail. This module holds the draft shape, the
// nudge and the bounded choices, the draft table and the parked images.
//
// Nothing here is free text. Every market id, name, alias, type and
// category a client can send back is one this module wrote into
// `choices` first.

export const DRAFT_TTL_MS = 15 * 60 * 1000;
export const MAX_RECROPS = 2;
export const MIN_CROP_SHORT_SIDE = 160;
export const MAX_CROP_ASPECT = 4;
// Markets one account may create in a rolling day; the review step makes
// creating a market a deliberate act, and this caps how deliberate.
export const MARKET_CREATE_DAILY_LIMIT = Number(process.env.MARKET_CREATE_DAILY_LIMIT ?? 10);
// Accounts younger than this cannot override a strong match.
export const NEW_ACCOUNT_MS = 24 * 60 * 60 * 1000;
// Accounts the daily create cap does not apply to, by email or user id,
// comma-separated: the eval tester, a seeding account. Admins and
// moderators are exempt by role without being listed.
const CREATE_LIMIT_EXEMPT = new Set(
  (process.env.MARKET_CREATE_LIMIT_EXEMPT ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

// Below the link thresholds but above these, an existing market is close
// enough to show the reviewer (and, on the one-shot path, to ask the
// model about).
export const CONFIRM_COSINE = Number(process.env.CONFIRM_COSINE ?? 0.6);
export const CONFIRM_TRIGRAM = Number(process.env.CONFIRM_TRIGRAM ?? 0.35);

const BUCKET = 'captures';

// Thrown for a bad client choice or a draft that cannot be used. Routes
// turn it into the given status.
export class ReviewError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code: string = 'bad_request'
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// A market the reviewer may attach to, with what the screen needs to show
// it. `relation` says why it is offered: it looks like the same thing, or
// it is the subject the content is about.
export interface OfferedMarket {
  id: string;
  name: string;
  entityType: string | null;
  category: string | null;
  thumbnailUrl: string | null;
  currentVi: number;
  totalCaptures: number;
  parentMarketId: string | null;
  similarity: number | null;
  relation: 'identity' | 'subject';
}

export type NudgeTier = 'strong' | 'subject' | 'ambiguous' | 'none';

export type ReviewChoice =
  | { kind: 'attach'; marketId: string }
  | {
      kind: 'create';
      name: string;
      entityType: string;
      category: string;
      aliases: string[];
      parentMarketId: string | null;
    }
  // Create a market for the subject the model named (it does not exist
  // yet) and attach the capture there: the DLSS case.
  | { kind: 'create_subject' };

export interface Nudge {
  tier: NudgeTier;
  defaultChoice: ReviewChoice;
  // Identity candidates, strongest first. Up to three.
  candidates: OfferedMarket[];
  // The subject market, when the model named one that exists.
  subject: OfferedMarket | null;
}

export interface DraftChoices {
  // Markets the reviewer may attach to: the candidates and the subject.
  attachIds: string[];
  // Names the created market may take: the proposal and its alternates.
  names: string[];
  entityTypes: readonly string[];
  categories: readonly string[];
  // Aliases the created market may keep. Toggle-off only; none can be added.
  aliases: string[];
  canCreate: boolean;
  // The subject market a created market may point at (supabase/010), when
  // the subject exists and is itself top-level.
  parentMarketId: string | null;
  // Offered when the model named a subject that has no market yet.
  createSubject: { name: string; entityType: SubjectType; category: string } | null;
  // Set when the pipeline would have linked on its own; creating anyway is
  // an override, audited and closed to new accounts.
  strongMatchId: string | null;
}

// The full server-side draft. The persisted part maps 1:1 onto
// submission_drafts; imageBase64 and docEmbedding ride along in memory
// for the one-shot path and are never stored on the row.
export interface ReviewDraft {
  id: string;
  userId: string;
  status: 'pending' | 'committed' | 'expired';
  contentHash: string;
  mediaType: string | null;
  sourceUrl: string | null;
  pageTitle: string | null;
  pageContext: string | null;
  text: string | null;
  imagePath: string | null;
  cropPath: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  crop: CropRect | null;
  recrops: number;
  submission: SubmissionAnalysis;
  candidates: ScoredCandidate[];
  decision: RoutingDecision;
  nudge: Nudge;
  choices: DraftChoices;
  embedding: string | null;
  expiresAt: string;
  imageBase64?: string;
  docEmbedding?: number[] | null;
}

// What the review screen gets. Everything the client needs to render and
// nothing it could replay: no model response, no scores beyond what is
// shown, no storage paths.
export interface ReviewDraftView {
  draftId: string;
  expiresAt: string;
  recropsLeft: number;
  image: {
    url: string;
    width: number;
    height: number;
    crop: CropRect | null;
    cropUrl: string | null;
  } | null;
  text: string | null;
  sourceUrl: string | null;
  pageTitle: string | null;
  analysis: {
    name: string;
    description: string;
    ocrText: string;
    entityType: string | null;
    category: string | null;
    aliases: string[];
    sentiment: string;
    platforms: string[];
    confidence: string;
  };
  nudge: Nudge;
  choices: DraftChoices;
}

// --- Nudge and choices -----------------------------------------------------

interface MarketDetails {
  id: string;
  entity_name: string;
  entity_type: string | null;
  category: string | null;
  thumbnail_url: string | null;
  current_vi: number;
  total_captures: number;
  parent_market_id: string | null;
}

export async function marketDetails(ids: string[]): Promise<Map<string, MarketDetails>> {
  const out = new Map<string, MarketDetails>();
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return out;
  const { data, error } = await createAdminClient()
    .from('markets')
    .select('id, entity_name, entity_type, category, thumbnail_url, current_vi, total_captures, parent_market_id')
    .in('id', unique)
    .is('deleted_at', null);
  if (error) throw error;
  for (const m of (data ?? []) as MarketDetails[]) out.set(m.id, m);
  return out;
}

function toOffered(
  m: MarketDetails,
  similarity: number | null,
  relation: OfferedMarket['relation']
): OfferedMarket {
  return {
    id: m.id,
    name: m.entity_name,
    entityType: m.entity_type,
    category: m.category,
    thumbnailUrl: m.thumbnail_url,
    currentVi: Math.round(Number(m.current_vi) || 0),
    totalCaptures: m.total_captures ?? 0,
    parentMarketId: m.parent_market_id,
    similarity,
    relation,
  };
}

export function candidateScore(c: ScoredCandidate): number {
  return Math.max(c.cosine ?? 0, c.trigram ?? 0);
}

export function inConfirmBand(c: ScoredCandidate): boolean {
  return (c.cosine ?? 0) >= CONFIRM_COSINE || (c.trigram ?? 0) >= CONFIRM_TRIGRAM;
}

// Which existing market the model's subject refers to, if any. A subject
// id is taken as shown; a subject name is matched by name retrieval, and
// only an unambiguous hit counts (the caller passes the best candidate for
// the name and its trigram score).
export interface SubjectResolution {
  existing: MarketDetails | null;
  proposal: { name: string; entityType: SubjectType } | null;
}

// The proposal's own entity types that can have a subject. A person or a
// brand is a subject, not something about one.
const ABOUT_TYPES = new Set(['meme', 'trend', 'event', 'other']);

export function buildReview(input: {
  submission: SubmissionAnalysis;
  decision: RoutingDecision;
  candidates: ScoredCandidate[];
  details: Map<string, MarketDetails>;
  subject: SubjectResolution;
  // Names Wikipedia vouches for beside the model's (lib/naming.ts).
  nameAlternates?: string[];
}): { nudge: Nudge; choices: DraftChoices } {
  const { submission: s, decision } = input;
  const nm = s.new_market;

  const strongId =
    decision.outcome === 'matched' || decision.outcome === 'linked' ? decision.marketId : null;

  // Identity candidates: the strong match first, then anything else in
  // the confirm band, three at most.
  const ranked = [...input.candidates].sort((a, b) => candidateScore(b) - candidateScore(a));
  const identity: OfferedMarket[] = [];
  const seen = new Set<string>();
  const push = (id: string, similarity: number | null) => {
    const d = input.details.get(id);
    if (!d || seen.has(id)) return;
    seen.add(id);
    identity.push(toOffered(d, similarity, 'identity'));
  };
  if (strongId) {
    push(strongId, decision.outcome === 'matched' ? 1 : (decision as { similarity: number }).similarity);
  }
  for (const c of ranked) {
    if (identity.length >= 3) break;
    if (inConfirmBand(c)) push(c.id, candidateScore(c));
  }

  // The subject, when it is a different market from the strong match and
  // the proposal is the kind of thing that has one.
  const aboutSomething = !nm || ABOUT_TYPES.has(nm.entity_type);
  const subjectDetails = input.subject.existing;
  const subject =
    subjectDetails && subjectDetails.id !== strongId && aboutSomething
      ? toOffered(subjectDetails, null, 'subject')
      : null;

  const tier: NudgeTier = strongId
    ? 'strong'
    : subject
      ? 'subject'
      : identity.length > 0
        ? 'ambiguous'
        : 'none';

  const canCreate = nm !== null;
  const names: string[] = [];
  if (nm) {
    const seen = new Set<string>();
    for (const n of [nm.name, ...s.name_alternates, ...(input.nameAlternates ?? [])]) {
      const k = n.trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      names.push(n.trim());
    }
  }
  const parentMarketId = subject && subject.parentMarketId === null ? subject.id : null;
  const createSubject =
    !subjectDetails && input.subject.proposal && nm && aboutSomething
      ? { ...input.subject.proposal, category: nm.category }
      : null;

  let defaultChoice: ReviewChoice;
  if (strongId) {
    defaultChoice = { kind: 'attach', marketId: strongId };
  } else if (subject) {
    defaultChoice = { kind: 'attach', marketId: subject.id };
  } else if (nm) {
    defaultChoice = {
      kind: 'create',
      name: nm.name,
      entityType: nm.entity_type,
      category: nm.category,
      aliases: nm.aliases,
      parentMarketId: null,
    };
  } else if (identity[0]) {
    defaultChoice = { kind: 'attach', marketId: identity[0].id };
  } else {
    // Admitted, unmatched, no proposal: vlm.ts routes this to unreadable
    // before we get here. Belt and braces.
    throw new ReviewError('Nothing to review', 422, 'unreadable');
  }

  const attachIds = [...identity.map((m) => m.id), ...(subject ? [subject.id] : [])];

  return {
    nudge: { tier, defaultChoice, candidates: identity, subject },
    choices: {
      attachIds,
      names,
      entityTypes: ENTITY_TYPES,
      categories: CATEGORIES,
      aliases: nm?.aliases ?? [],
      canCreate,
      parentMarketId,
      createSubject,
      strongMatchId: strongId,
    },
  };
}

// The client's choice, checked against what the draft offered. Returns the
// normalised choice or throws a ReviewError the route reports as 400.
export function validateChoice(draft: ReviewDraft, raw: unknown): ReviewChoice {
  if (!raw || typeof raw !== 'object') throw new ReviewError('choice is required');
  const c = raw as Record<string, unknown>;
  const { choices } = draft;

  switch (c.kind) {
    case 'attach': {
      const marketId = typeof c.marketId === 'string' ? c.marketId : '';
      if (!choices.attachIds.includes(marketId)) {
        throw new ReviewError('That market was not offered for this submission');
      }
      return { kind: 'attach', marketId };
    }
    case 'create': {
      if (!choices.canCreate) throw new ReviewError('Creating a market is not an option here');
      const name = typeof c.name === 'string' ? c.name : '';
      if (!choices.names.includes(name)) throw new ReviewError('Pick one of the proposed names');
      const entityType = typeof c.entityType === 'string' ? c.entityType : '';
      if (!choices.entityTypes.includes(entityType)) throw new ReviewError('Unknown entity type');
      const category = typeof c.category === 'string' ? c.category : '';
      if (!choices.categories.includes(category)) throw new ReviewError('Unknown category');
      const aliases = Array.isArray(c.aliases) ? c.aliases : null;
      if (!aliases || aliases.some((a) => typeof a !== 'string' || !choices.aliases.includes(a))) {
        throw new ReviewError('Aliases can only be removed, not added');
      }
      const parentMarketId =
        c.parentMarketId === null || c.parentMarketId === undefined
          ? null
          : typeof c.parentMarketId === 'string'
            ? c.parentMarketId
            : '';
      if (parentMarketId !== null && parentMarketId !== choices.parentMarketId) {
        throw new ReviewError('That market cannot be the parent here');
      }
      return {
        kind: 'create',
        name,
        entityType,
        category,
        aliases: [...new Set(aliases as string[])],
        parentMarketId,
      };
    }
    case 'create_subject': {
      if (!choices.createSubject) throw new ReviewError('No subject market to create here');
      return { kind: 'create_subject' };
    }
    default:
      throw new ReviewError('Unknown choice');
  }
}

// --- Limits ------------------------------------------------------------------

export async function marketsCreatedToday(userId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await createAdminClient()
    .from('submission_decisions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('outcome', ['created', 'created_review'])
    .gte('created_at', since);
  if (error) throw error;
  return count ?? 0;
}

// Whether the daily create cap applies to this account: not to admins and
// moderators, and not to anyone named in MARKET_CREATE_LIMIT_EXEMPT.
export async function isCreateLimitExempt(userId: string): Promise<boolean> {
  if (CREATE_LIMIT_EXEMPT.has(userId.toLowerCase())) return true;
  const { data, error } = await createAdminClient()
    .from('user_profiles')
    .select('role, email')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;
  if (data.role === 'admin' || data.role === 'moderator') return true;
  return Boolean(data.email && CREATE_LIMIT_EXEMPT.has(data.email.toLowerCase()));
}

export async function isNewAccount(userId: string): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from('user_profiles')
    .select('created_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.created_at) return true;
  return Date.now() - new Date(data.created_at).getTime() < NEW_ACCOUNT_MS;
}

// --- Parked images -------------------------------------------------------------

export function pendingImagePath(userId: string, draftId: string, suffix = ''): string {
  return `${userId}/pending/${draftId}${suffix}.jpg`;
}

export async function parkImage(path: string, bytes: Buffer, contentType: string): Promise<void> {
  const { error } = await createAdminClient()
    .storage.from(BUCKET)
    .upload(path, bytes, { contentType, upsert: true });
  if (error) throw error;
}

export async function readParkedImage(path: string): Promise<Buffer> {
  const { data, error } = await createAdminClient().storage.from(BUCKET).download(path);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

export function parkedImageUrl(path: string): string {
  return createAdminClient().storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

export async function removeParkedImages(paths: (string | null)[]): Promise<void> {
  const list = paths.filter((p): p is string => Boolean(p));
  if (list.length === 0) return;
  const { error } = await createAdminClient().storage.from(BUCKET).remove(list);
  if (error) console.warn('[review] could not remove parked images', error.message);
}

export async function imageSize(bytes: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(bytes).metadata();
  // EXIF orientation swaps the axes the browser will draw with.
  const swap = (meta.orientation ?? 1) >= 5;
  const width = swap ? meta.height : meta.width;
  const height = swap ? meta.width : meta.height;
  if (!width || !height) throw new ReviewError('Could not read the image', 422, 'unreadable');
  return { width, height };
}

// The crop the reviewer asked for, checked against the original's size and
// the bounds (short side, aspect). Values are original pixels.
export function validateCrop(raw: unknown, width: number, height: number): CropRect {
  if (!raw || typeof raw !== 'object') throw new ReviewError('crop is required');
  const r = raw as Record<string, unknown>;
  const num = (k: string) => {
    const v = r[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new ReviewError(`crop.${k} must be a number`);
    return Math.round(v);
  };
  const rect = { x: num('x'), y: num('y'), width: num('width'), height: num('height') };
  if (rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1) {
    throw new ReviewError('crop is out of bounds');
  }
  if (rect.x + rect.width > width || rect.y + rect.height > height) {
    throw new ReviewError('crop is out of bounds');
  }
  const minSide = Math.min(MIN_CROP_SHORT_SIDE, width, height);
  if (Math.min(rect.width, rect.height) < minSide) {
    throw new ReviewError(`crop must be at least ${minSide} px on its short side`);
  }
  const aspect = Math.max(rect.width, rect.height) / Math.min(rect.width, rect.height);
  if (aspect > MAX_CROP_ASPECT) {
    throw new ReviewError(`crop cannot be more than ${MAX_CROP_ASPECT}:1`);
  }
  return rect;
}

// Crops the server's copy of the original. The client only ever sends a
// rectangle, so the reviewed image can never be swapped for another.
export async function cropImage(bytes: Buffer, rect: CropRect): Promise<Buffer> {
  return sharp(bytes)
    .rotate() // apply EXIF orientation so the rectangle matches what was shown
    .extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })
    .jpeg({ quality: 88 })
    .toBuffer();
}

// --- Draft rows ----------------------------------------------------------------

type DraftRow = {
  id: string;
  user_id: string;
  status: 'pending' | 'committed' | 'expired';
  content_hash: string;
  media_type: string | null;
  source_url: string | null;
  page_title: string | null;
  page_context: string | null;
  text: string | null;
  image_path: string | null;
  crop_path: string | null;
  image_width: number | null;
  image_height: number | null;
  crop: Json | null;
  recrops: number;
  analysis: Json;
  candidates: Json;
  decision: Json;
  nudge: Json;
  choices: Json;
  embedding: string | null;
  expires_at: string;
};

const DRAFT_COLUMNS =
  'id, user_id, status, content_hash, media_type, source_url, page_title, page_context, text, image_path, crop_path, image_width, image_height, crop, recrops, analysis, candidates, decision, nudge, choices, embedding, expires_at';

function toRow(d: ReviewDraft) {
  return {
    id: d.id,
    user_id: d.userId,
    status: d.status,
    content_hash: d.contentHash,
    media_type: d.mediaType,
    source_url: d.sourceUrl,
    page_title: d.pageTitle,
    page_context: d.pageContext,
    text: d.text,
    image_path: d.imagePath,
    crop_path: d.cropPath,
    image_width: d.imageWidth,
    image_height: d.imageHeight,
    crop: d.crop as unknown as Json,
    recrops: d.recrops,
    analysis: d.submission as unknown as Json,
    candidates: d.candidates as unknown as Json,
    decision: d.decision as unknown as Json,
    nudge: d.nudge as unknown as Json,
    choices: d.choices as unknown as Json,
    embedding: d.embedding,
    expires_at: d.expiresAt,
    updated_at: new Date().toISOString(),
  };
}

function fromRow(r: DraftRow): ReviewDraft {
  return {
    id: r.id,
    userId: r.user_id,
    status: r.status,
    contentHash: r.content_hash,
    mediaType: r.media_type,
    sourceUrl: r.source_url,
    pageTitle: r.page_title,
    pageContext: r.page_context,
    text: r.text,
    imagePath: r.image_path,
    cropPath: r.crop_path,
    imageWidth: r.image_width,
    imageHeight: r.image_height,
    crop: (r.crop as unknown as CropRect | null) ?? null,
    recrops: r.recrops,
    submission: r.analysis as unknown as SubmissionAnalysis,
    candidates: (r.candidates as unknown as ScoredCandidate[]) ?? [],
    decision: r.decision as unknown as RoutingDecision,
    nudge: r.nudge as unknown as Nudge,
    choices: r.choices as unknown as DraftChoices,
    embedding: r.embedding,
    expiresAt: r.expires_at,
  };
}

export function newExpiry(): string {
  return new Date(Date.now() + DRAFT_TTL_MS).toISOString();
}

export async function saveDraft(d: ReviewDraft): Promise<void> {
  const { error } = await createAdminClient().from('submission_drafts').insert(toRow(d));
  if (error) throw error;
}

export async function updateDraft(d: ReviewDraft): Promise<void> {
  const { error } = await createAdminClient().from('submission_drafts').update(toRow(d)).eq('id', d.id);
  if (error) throw error;
}

// A pending, unexpired draft that belongs to this user. Anything else is
// reported as gone: the client's answer is to submit again.
export async function loadDraft(id: string, userId: string): Promise<ReviewDraft> {
  const { data, error } = await createAdminClient()
    .from('submission_drafts')
    .select(DRAFT_COLUMNS)
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ReviewError('This review has expired. Submit again.', 410, 'draft_gone');
  const draft = fromRow(data as DraftRow);
  if (draft.status !== 'pending' || new Date(draft.expiresAt).getTime() < Date.now()) {
    throw new ReviewError(
      draft.status === 'committed'
        ? 'This submission was already committed.'
        : 'This review has expired. Submit again.',
      410,
      'draft_gone'
    );
  }
  return draft;
}

export async function markDraftCommitted(
  id: string,
  captureId: string | null,
  marketId: string | null
): Promise<void> {
  const { error } = await createAdminClient()
    .from('submission_drafts')
    .update({
      status: 'committed',
      capture_id: captureId,
      market_id: marketId,
      committed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw error;
}

// Expired pending drafts: the rows stay (status expired) as a record of
// what was proposed and not committed; the parked images go. Runs from the
// hourly slow refresh.
export async function sweepExpiredDrafts(limit = 200): Promise<{ expired: number }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('submission_drafts')
    .select('id, image_path, crop_path')
    .eq('status', 'pending')
    .lt('expires_at', new Date().toISOString())
    .limit(limit);
  if (error) throw error;
  const rows = (data ?? []) as { id: string; image_path: string | null; crop_path: string | null }[];
  if (rows.length === 0) return { expired: 0 };
  await removeParkedImages(rows.flatMap((r) => [r.image_path, r.crop_path]));
  const { error: updErr } = await admin
    .from('submission_drafts')
    .update({ status: 'expired', image_path: null, crop_path: null, updated_at: new Date().toISOString() })
    .in(
      'id',
      rows.map((r) => r.id)
    );
  if (updErr) throw updErr;
  return { expired: rows.length };
}

// --- The client's view ---------------------------------------------------------

export function toView(d: ReviewDraft): ReviewDraftView {
  const s = d.submission;
  const nm = s.new_market;
  const matchedName = d.nudge.candidates.find((c) => c.id === s.matched_market_id)?.name;
  return {
    draftId: d.id,
    expiresAt: d.expiresAt,
    recropsLeft: d.imagePath ? Math.max(0, MAX_RECROPS - d.recrops) : 0,
    image:
      d.imagePath && d.imageWidth && d.imageHeight
        ? {
            url: parkedImageUrl(d.imagePath),
            width: d.imageWidth,
            height: d.imageHeight,
            crop: d.crop,
            cropUrl: d.cropPath ? parkedImageUrl(d.cropPath) : null,
          }
        : null,
    text: d.text,
    sourceUrl: d.sourceUrl,
    pageTitle: d.pageTitle,
    analysis: {
      name: nm?.name ?? matchedName ?? '',
      description: s.description,
      ocrText: s.ocr_text,
      entityType: nm?.entity_type ?? null,
      category: nm?.category ?? null,
      aliases: nm?.aliases ?? [],
      sentiment: s.sentiment,
      platforms: s.platforms_detected,
      confidence: s.confidence,
    },
    nudge: d.nudge,
    choices: d.choices,
  };
}
