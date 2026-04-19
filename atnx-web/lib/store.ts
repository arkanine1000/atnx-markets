import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from './supabase/admin';
import { normalizeSearchTerm, type TrendsResult } from './trends';
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

type MarketRow = {
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

async function uploadScreenshot(
  client: DbClient,
  screenshot: string,
  folder: string
): Promise<string> {
  const fileName = `${folder}/${crypto.randomUUID()}.png`;
  const buffer = base64ToBuffer(screenshot);

  const { error } = await client.storage
    .from(STORAGE_BUCKET)
    .upload(fileName, buffer, { contentType: 'image/png', upsert: false });
  if (error) throw error;

  const { data } = client.storage.from(STORAGE_BUCKET).getPublicUrl(fileName);
  return data.publicUrl;
}

async function resolveOrCreateMarket(
  entityName: string,
  entityType: string | null
): Promise<MarketRow> {
  const supabase = createAdminClient();
  const normalized = entityName.toLowerCase().trim();

  const { data: existing, error: findErr } = await supabase
    .from('markets')
    .select('id, entity_name, entity_type, current_vi, vi_last_updated, total_captures')
    .eq('entity_name_normalized', normalized)
    .is('deleted_at', null)
    .maybeSingle();
  if (findErr) throw findErr;
  if (existing) return existing as MarketRow;

  const { data: created, error: insertErr } = await supabase
    .from('markets')
    .insert({
      entity_name: entityName,
      entity_name_normalized: normalized,
      entity_type: entityType,
    })
    .select('id, entity_name, entity_type, current_vi, vi_last_updated, total_captures')
    .single();
  if (insertErr) throw insertErr;
  return created as MarketRow;
}

async function recordVi(marketId: string, vi: number, dataPoints: TrendsResult['dataPoints']) {
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

export async function addCapture(
  input: Capture,
  sessionClient: DbClient,
  userId: string
): Promise<Capture> {
  const admin = createAdminClient();

  const entityName = input.analysis?.name || normalizeSearchTerm(input.analysis) || 'Unknown';
  const entityType = input.analysis?.type ?? null;

  // Upload under the user's folder so storage RLS ({user_id}/*.png) passes,
  // then resolve/create the shared market row via admin (bypasses RLS).
  const image_url = await uploadScreenshot(sessionClient, input.screenshot, userId);
  const market = await resolveOrCreateMarket(entityName, entityType);

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
      resolution_status: 'resolved',
    })
    .select('id, created_at')
    .single();
  if (error) throw error;

  const vi = input.viralityScore;
  const seedPoints = input.trends?.dataPoints ?? [];
  await recordVi(market.id, vi, seedPoints);

  await admin
    .from('markets')
    .update({ total_captures: (market.total_captures ?? 0) + 1 })
    .eq('id', market.id);

  return {
    ...input,
    id: captureRow.id as string,
    marketId: market.id,
    timestamp: captureRow.created_at as string,
    screenshot: image_url,
    viralityScore: vi,
  };
}

export async function getCaptures(limit = 50): Promise<Capture[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('captures')
    .select(
      'id, created_at, image_url, source_url, ocr_text, raw_ai_response, market_id, market:markets(id, entity_name, entity_type, current_vi, vi_last_updated, total_captures)'
    )
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit)
    .returns<CaptureRowWithMarket[]>();
  if (error) throw error;
  if (!data) return [];

  const results = await Promise.all(
    data.map(async (row) => {
      const analysis = (row.raw_ai_response ?? {}) as Capture['analysis'] & {
        _meta?: { page_title?: string; captured_at?: string };
      };
      const meta = analysis._meta;
      const market = row.market;
      const trends = market ? await buildTrendsView(market.id, market.entity_name) : null;

      const cleanedAnalysis: Capture['analysis'] = { ...analysis };
      delete (cleanedAnalysis as Record<string, unknown>)._meta;

      return {
        id: row.id,
        marketId: row.market_id,
        timestamp: meta?.captured_at ?? row.created_at,
        pageUrl: row.source_url ?? '',
        pageTitle: meta?.page_title ?? '',
        screenshot: row.image_url ?? '',
        analysis: cleanedAnalysis,
        trends,
        viralityScore: Math.round(market?.current_vi ?? 0),
      } satisfies Capture;
    })
  );

  return results;
}
