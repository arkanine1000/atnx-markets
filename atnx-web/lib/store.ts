import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from './supabase/admin';
import type { TrendsResult } from './trends';
import type { Database } from './supabase/database';

type DbClient = SupabaseClient<Database>;

// Legacy capture shape consumed by the dashboard. Post-Chunk 1 this is a view
// model assembled from the underlying Supabase rows.
export interface Capture {
  id: string;
  marketId: string | null;
  timestamp: string;
  pageUrl: string;
  pageTitle: string;
  screenshot: string; // storage public URL (was base64 pre-Chunk 1)
  analysis: {
    type?: string;
    name?: string;
    description?: string;
    category?: string;
    platforms_detected?: string[];
    metrics_detected?: Record<string, string | number>;
    sentiment?: string;
    virality_signals?: string;
    raw_text?: string;
    error?: string;
    raw_response?: string;
    parse_error?: boolean;
  };
  trends: TrendsResult | null;
  viralityScore: number;
}

export type MarketRow = {
  id: string;
  entity_name: string;
  entity_type: string | null;
  current_vi: number;
  vi_last_updated: string | null;
  total_captures: number;
};

type CaptureRowWithMarket = {
  id: string;
  created_at: string;
  image_url: string | null;
  source_url: string | null;
  ocr_text: string | null;
  raw_ai_response: Record<string, unknown> | null;
  market_id: string | null;
  market: MarketRow | null;
};

const STORAGE_BUCKET = 'captures';

function base64ToBuffer(screenshot: string): Buffer {
  // Strip a data URL prefix if present (the extension currently sends raw base64)
  const raw = screenshot.startsWith('data:')
    ? screenshot.slice(screenshot.indexOf(',') + 1)
    : screenshot;
  return Buffer.from(raw, 'base64');
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

// Shown in place of a screenshot for text-only submissions, so every
// component that renders capture.screenshot keeps working unchanged.
export const TEXT_PLACEHOLDER_IMAGE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#0b0b0f"/><text x="160" y="128" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#5b5f6b">TEXT</text></svg>'
  );

async function uploadScreenshot(
  client: DbClient,
  screenshot: string,
  folder: string,
  contentType: string
): Promise<string> {
  const ext = EXT_BY_TYPE[contentType] ?? 'png';
  const fileName = `${folder}/${crypto.randomUUID()}.${ext}`;
  const buffer = base64ToBuffer(screenshot);

  const { error } = await client.storage
    .from(STORAGE_BUCKET)
    .upload(fileName, buffer, { contentType, upsert: false });
  if (error) throw error;

  const { data } = client.storage.from(STORAGE_BUCKET).getPublicUrl(fileName);
  return data.publicUrl;
}

const MARKET_COLUMNS = 'id, entity_name, entity_type, current_vi, vi_last_updated, total_captures';

export async function getMarketById(id: string): Promise<MarketRow | null> {
  const { data, error } = await createAdminClient()
    .from('markets')
    .select(MARKET_COLUMNS)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  return (data as MarketRow | null) ?? null;
}

export interface CreateMarketInput {
  name: string;
  entityType: string | null;
  category: string | null;
  aliases: string[];
  embedding: string | null; // pgvector string
}

export interface CreateMarketResult {
  market: MarketRow;
  created: boolean; // false when a live market with this name already existed
}

// Inserts a market. The unique index on entity_name_normalized (live rows)
// turns a concurrent duplicate into a 23505, in which case the existing row
// is returned instead. This is what closes the concurrent-creation race.
export async function createMarket(input: CreateMarketInput): Promise<CreateMarketResult> {
  const admin = createAdminClient();
  const normalized = input.name.toLowerCase().trim().replace(/\s+/g, ' ');

  const { data, error } = await admin
    .from('markets')
    .insert({
      entity_name: input.name,
      entity_name_normalized: normalized,
      entity_type: input.entityType,
      category: input.category,
      aliases: input.aliases,
      embedding: input.embedding,
    })
    .select(MARKET_COLUMNS)
    .single();

  if (!error) return { market: data as MarketRow, created: true };
  if (error.code !== '23505') throw error;

  const { data: existing, error: selErr } = await admin
    .from('markets')
    .select(MARKET_COLUMNS)
    .eq('entity_name_normalized', normalized)
    .is('deleted_at', null)
    .maybeSingle();
  if (selErr) throw selErr;
  if (!existing) throw error;
  return { market: existing as MarketRow, created: false };
}

export async function recordVi(marketId: string, vi: number, dataPoints: TrendsResult['dataPoints']) {
  const supabase = createAdminClient();

  // If this is the first capture for the market and Google Trends gave us a
  // seed series, backfill vi_history so the sparkline is meaningful immediately.
  const { count } = await supabase
    .from('vi_history')
    .select('id', { count: 'exact', head: true })
    .eq('market_id', marketId);

  if ((count ?? 0) === 0 && dataPoints.length > 0) {
    const seedRows = dataPoints.map((p) => ({
      market_id: marketId,
      vi: p.value,
      recorded_at: p.date,
    }));
    const { error: seedErr } = await supabase.from('vi_history').insert(seedRows);
    if (seedErr) throw seedErr;
  }

  // Always append the latest scored point so each capture leaves a trace.
  const { error: insertErr } = await supabase
    .from('vi_history')
    .insert({ market_id: marketId, vi });
  if (insertErr) throw insertErr;

  const { error: updateErr } = await supabase
    .from('markets')
    .update({ current_vi: vi, vi_last_updated: new Date().toISOString() })
    .eq('id', marketId);
  if (updateErr) throw updateErr;
}

async function buildTrendsView(
  marketId: string,
  entityName: string
): Promise<TrendsResult | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('vi_history')
    .select('vi, recorded_at')
    .eq('market_id', marketId)
    .order('recorded_at', { ascending: true })
    .limit(200);
  if (error) throw error;
  if (!data || data.length === 0) return null;

  const dataPoints = data.map((row) => ({
    date: row.recorded_at as string,
    value: row.vi as number,
  }));
  const values = dataPoints.map((p) => p.value);
  const currentValue = values[values.length - 1];
  const peakValue = Math.max(...values);

  // Re-derive the qualitative trend bucket from the stored series.
  const recent = values.slice(-6);
  const prior = values.slice(-12, -6);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const recentAvg = avg(recent);
  const priorAvg = avg(prior);
  let trend: TrendsResult['trend'] = 'stable';
  if (priorAvg === 0 && recentAvg > 0) trend = 'new';
  else {
    const changePct = priorAvg > 0 ? ((recentAvg - priorAvg) / priorAvg) * 100 : 0;
    if (changePct > 100) trend = 'spiking';
    else if (changePct > 15) trend = 'rising';
    else if (changePct < -15) trend = 'falling';
  }

  return {
    term: entityName,
    dataPoints,
    viralityScore: 0, // unused by dashboard; viralityScore field below carries it
    peakValue,
    currentValue,
    trend,
    fetchedAt: new Date().toISOString(),
  };
}

export interface AddCaptureResult {
  capture: Capture;
  isNew: boolean;
}

export interface AddCaptureOptions {
  // Market decided by lib/route.ts (matched, linked, or just created).
  marketId: string;
  // Similarity evidence for the chosen market, stored as confidence_score.
  // Null when the market was created for this capture.
  similarity: number | null;
  // Flag for the admin review queue. Nothing waits on it.
  review: boolean;
  // SHA-256 of the submission; the unique partial index on it enforces
  // exact dedup.
  contentHash: string | null;
  // Real content type of the screenshot, stored as-is. Null for text-only.
  mediaType?: string | null;
}

export class DuplicateCaptureError extends Error {
  constructor(readonly contentHash: string) {
    super('duplicate capture');
    this.name = 'DuplicateCaptureError';
  }
}

export async function addCapture(
  input: Capture,
  sessionClient: DbClient,
  userId: string,
  opts: AddCaptureOptions
): Promise<AddCaptureResult> {
  const admin = createAdminClient();

  // Upload under the user's folder so storage RLS ({user_id}/*) passes.
  // Text-only submissions have no image.
  const image_url = input.screenshot
    ? await uploadScreenshot(sessionClient, input.screenshot, userId, opts.mediaType ?? 'image/png')
    : null;

  const market = await getMarketById(opts.marketId);
  if (!market) throw new Error(`market ${opts.marketId} not found`);
  const similarity = opts.similarity;
  const isNew = similarity === null;
  const resolutionStatus: 'resolved' | 'review' = opts.review ? 'review' : 'resolved';

  const rawAiResponse: Record<string, unknown> = {
    ...input.analysis,
    _meta: {
      page_title: input.pageTitle,
      // captured_at preserves the client-reported timestamp
      captured_at: input.timestamp,
    },
  };

  // Session client so RLS enforces user_id = auth.uid() on captures.
  const { data: captureRow, error } = await sessionClient
    .from('captures')
    .insert({
      user_id: userId,
      market_id: market.id,
      image_url,
      source_url: input.pageUrl,
      ocr_text: input.analysis?.raw_text ?? null,
      raw_ai_response: rawAiResponse,
      confidence_score: similarity,
      resolution_status: resolutionStatus,
      content_hash: opts.contentHash ?? null,
    })
    .select('id, created_at')
    .single();
  if (error) {
    // Unique violation on content_hash: a concurrent submission of the same
    // bytes won the race. Undo the market this call may have created and let
    // the pipeline return the winner's result.
    if (error.code === '23505' && opts.contentHash) {
      if (isNew) {
        await admin
          .from('markets')
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', market.id)
          .eq('total_captures', 0);
      }
      throw new DuplicateCaptureError(opts.contentHash);
    }
    throw error;
  }

  const vi = input.viralityScore;
  const seedPoints = input.trends?.dataPoints ?? [];
  await recordVi(market.id, vi, seedPoints);

  await admin
    .from('markets')
    .update({ total_captures: (market.total_captures ?? 0) + 1 })
    .eq('id', market.id);

  return {
    capture: {
      ...input,
      id: captureRow.id as string,
      marketId: market.id,
      timestamp: captureRow.created_at as string,
      screenshot: image_url ?? TEXT_PLACEHOLDER_IMAGE,
      viralityScore: vi,
    },
    isNew,
  };
}

function rowToCapture(
  row: CaptureRowWithMarket,
  trends: TrendsResult | null
): Capture {
  const analysis = (row.raw_ai_response ?? {}) as Capture['analysis'] & {
    _meta?: { page_title?: string; captured_at?: string };
  };
  const meta = analysis._meta;
  const market = row.market;

  const cleanedAnalysis: Capture['analysis'] = { ...analysis };
  delete (cleanedAnalysis as Record<string, unknown>)._meta;

  return {
    id: row.id,
    marketId: row.market_id,
    timestamp: meta?.captured_at ?? row.created_at,
    pageUrl: row.source_url ?? '',
    pageTitle: meta?.page_title ?? '',
    screenshot: row.image_url ?? TEXT_PLACEHOLDER_IMAGE,
    analysis: cleanedAnalysis,
    trends,
    viralityScore: Math.round(market?.current_vi ?? 0),
  };
}

export async function getCaptures(limit = 50): Promise<Capture[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('captures')
    .select(
      'id, created_at, image_url, source_url, ocr_text, raw_ai_response, market_id, market:markets!inner(id, entity_name, entity_type, current_vi, vi_last_updated, total_captures)'
    )
    .is('deleted_at', null)
    .is('market.deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit)
    .returns<CaptureRowWithMarket[]>();
  if (error) throw error;
  if (!data) return [];

  return Promise.all(
    data.map(async (row) => {
      const market = row.market;
      const trends = market
        ? await buildTrendsView(market.id, market.entity_name)
        : null;
      return rowToCapture(row, trends);
    })
  );
}

export interface MarketDetail {
  market: MarketRow;
  latest: Capture;
  captures: Capture[];
  trends: TrendsResult | null;
}

export async function getMarketDetail(
  marketId: string
): Promise<MarketDetail | null> {
  const supabase = createAdminClient();

  const { data: market, error: marketErr } = await supabase
    .from('markets')
    .select(
      'id, entity_name, entity_type, current_vi, vi_last_updated, total_captures'
    )
    .eq('id', marketId)
    .is('deleted_at', null)
    .maybeSingle();
  if (marketErr) throw marketErr;
  if (!market) return null;

  const { data: captureRows, error: captureErr } = await supabase
    .from('captures')
    .select(
      'id, created_at, image_url, source_url, ocr_text, raw_ai_response, market_id, market:markets(id, entity_name, entity_type, current_vi, vi_last_updated, total_captures)'
    )
    .eq('market_id', marketId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .returns<CaptureRowWithMarket[]>();
  if (captureErr) throw captureErr;
  if (!captureRows || captureRows.length === 0) return null;

  const trends = await buildTrendsView(market.id, market.entity_name);
  const captures = captureRows.map((row) => rowToCapture(row, trends));

  return {
    market: market as MarketRow,
    latest: captures[0],
    captures,
    trends,
  };
}

export interface TradeLogEvent {
  id: string;                      // `${positionId}:open` | `${positionId}:close`
  kind: 'open' | 'close';
  handle: string;                  // trader's user_profiles.handle
  direction: 'long' | 'short';
  sizeUsd: number;
  leverage: number;
  vi: number;                      // entry_vi for open, exit_vi for close
  pnl: number | null;              // realized_pnl for close, null for open
  at: string;                      // opened_at for open, closed_at for close
}

// Public trade log for a market. `positions` has no RLS today (all existing
// code filters by user_id at the app layer), so we read via the admin client
// and only expose the handle + trade-shape fields — no user_id or email leak.
// We fetch positions and user_profiles separately because positions.user_id
// FKs to auth.users (Supabase native), not to public.user_profiles — so
// PostgREST can't auto-embed the relation.
export async function getMarketTradeLog(
  marketId: string,
  limit = 50
): Promise<TradeLogEvent[]> {
  const supabase = createAdminClient();

  const { data: positions, error: posErr } = await supabase
    .from('positions')
    .select(
      'id, user_id, direction, size_usd, leverage, entry_vi, exit_vi, realized_pnl, opened_at, closed_at'
    )
    .eq('market_id', marketId)
    .order('opened_at', { ascending: false })
    .limit(limit);
  if (posErr) throw posErr;
  if (!positions || positions.length === 0) return [];

  const userIds = Array.from(new Set(positions.map((p) => p.user_id)));
  const { data: profiles, error: profErr } = await supabase
    .from('user_profiles')
    .select('id, handle')
    .in('id', userIds);
  if (profErr) throw profErr;

  const handleById = new Map<string, string>();
  for (const row of profiles ?? []) {
    if (row.handle) handleById.set(row.id, row.handle);
  }

  const events: TradeLogEvent[] = [];
  for (const p of positions) {
    const handle = handleById.get(p.user_id) ?? 'anon';
    events.push({
      id: `${p.id}:open`,
      kind: 'open',
      handle,
      direction: p.direction,
      sizeUsd: p.size_usd,
      leverage: p.leverage,
      vi: p.entry_vi,
      pnl: null,
      at: p.opened_at,
    });
    if (p.closed_at && p.exit_vi !== null) {
      events.push({
        id: `${p.id}:close`,
        kind: 'close',
        handle,
        direction: p.direction,
        sizeUsd: p.size_usd,
        leverage: p.leverage,
        vi: p.exit_vi,
        pnl: p.realized_pnl,
        at: p.closed_at,
      });
    }
  }

  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return events.slice(0, limit);
}
