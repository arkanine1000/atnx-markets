import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database';
import { analyzeScreenshot, type VisionAnalysis, type VisionMediaType } from './claude-vision';
import { normalizeSearchTerm } from './trends';
import { composeVi } from './signals';
import { addCapture, type Capture } from './store';

export interface ProcessCaptureResult {
  marketId: string | null;
  entityName: string | null;
  isNew: boolean;
  vi: number;
  source: string;
  analysis: VisionAnalysis;
}

// Shared capture pipeline used by /api/captures (extension) and /share
// (Android share target). Takes a raw image, runs Claude vision, composes
// VI from all signal sources, and persists the capture under the user's
// account. Auth must be established by the caller.
export async function processCapture(opts: {
  imageBase64: string;
  mediaType: VisionMediaType;
  sourceUrl?: string;
  pageTitle?: string;
  pageContext?: string;
  supabase: SupabaseClient<Database>;
  userId: string;
}): Promise<ProcessCaptureResult> {
  const analysis = await analyzeScreenshot({
    imageBase64: opts.imageBase64,
    mediaType: opts.mediaType,
    sourceUrl: opts.sourceUrl,
    pageTitle: opts.pageTitle,
    pageContext: opts.pageContext,
  });

  const searchTerm = normalizeSearchTerm(analysis);
  const signal = await composeVi({ term: searchTerm, analysis });

  const input: Capture = {
    id: crypto.randomUUID(),
    marketId: null,
    timestamp: new Date().toISOString(),
    pageUrl: opts.sourceUrl ?? '',
    pageTitle: opts.pageTitle ?? '',
    screenshot: opts.imageBase64,
    analysis,
    trends: signal.trends,
    viralityScore: signal.score,
  };

  const { capture, isNew } = await addCapture(input, opts.supabase, opts.userId);

  return {
    marketId: capture.marketId,
    entityName: analysis.name ?? null,
    isNew,
    vi: signal.score,
    source: signal.source,
    analysis,
  };
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
