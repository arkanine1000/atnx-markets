// Every market gets a description, not only the highlighted ones the image
// job curates (lib/thumbnails.ts writes one as a by-product of finding a
// reference image, for the top of the board). The hero and the market
// page show it, and the relevance judges (lib/vi/relevance-x-jev.ts,
// relevance-jev.ts) read it to learn what a name refers to: "Zach Cregger
// Resident Evil" is the film, so a post about the film's record is about
// the market.
//
// Sources, cheapest and most trusted first:
//   1. the market's own Wikipedia article, when the stored Wikipedia
//      reading says it owns one (exact, redirect or qualified match; a
//      section redirect's target is about something else);
//   2. its Know Your Meme entry;
//   3. a capture's reference page, when the page is titled with the name;
//   4. one line from the text model, from the name, type, category,
//      aliases and the newest captures' analyses, stored as 'model'.
// A market with a description is never revisited here; one with none is
// retried weekly (markets.description_checked_at, supabase/022). A
// reference page the image job finds later replaces a model line;
// 'manual' is never touched. Runs a dozen markets per hourly slow
// refresh, and once for a new market right after its first score.
import { generateText, Output, type LanguageModel } from 'ai';
import { z } from 'zod';
import { createAdminClient } from './supabase/admin';
import { fetchArticleSummary, leadSentences } from './vi/wikipedia';
import { knowYourMemeEntry, pageImage, MANUAL_SOURCE, type MarketForImage } from './thumbnails';
import type { Components } from './vi/score';

const MODEL = process.env.VLM_MODEL_TEXT ?? 'google/gemini-3.5-flash-lite';
const MODEL_TIMEOUT_MS = 15_000;
const RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const GAP_MS = 300;
const MAX_REFERENCE_PAGES = 4;
const MAX_CONTEXT_CHARS = 1500;
export const MODEL_SOURCE = 'model';

export interface DescribeOptions {
  // Markets handled in one pass.
  limit?: number;
  // Only these markets (the capture path, right after a market's first
  // score).
  marketIds?: string[];
  // Look even if a recent look found nothing.
  force?: boolean;
  // Find, log, write nothing.
  dryRun?: boolean;
  // Test seam for the model fallback.
  model?: LanguageModel;
}

export interface DescribeResult {
  considered: number;
  set: number;
  none: number;
  failed: number;
  log: string[];
}

export interface Described {
  description: string;
  // Recorded in markets.description_source.
  source: string;
}

type MarketToDescribe = MarketForImage & {
  category: string | null;
  aliases: string[] | null;
  current_vi: number | null;
  description_source: string | null;
  description_checked_at: string | null;
};

// The Wikipedia title the market owns, from the stored reading; null when
// the article is a namesake or a section of another article. Pure.
export function ownArticleTitle(components: Components | null | undefined): string | null {
  const m = components?.wikipedia?.meta;
  if (!m || Number(m.own) !== 1) return null;
  const match = String(m.match ?? '');
  if (match !== 'exact' && match !== 'redirect' && match !== 'qualified') return null;
  const title = typeof m.title === 'string' ? m.title.trim() : '';
  return title || null;
}

// Whether the pass should look at a market now. Pure.
export function dueForDescription(
  m: { description_source: string | null; description_checked_at: string | null },
  { force = false, now = Date.now() }: { force?: boolean; now?: number } = {}
): boolean {
  if (m.description_source) return false;
  if (force) return true;
  const checked = m.description_checked_at ? new Date(m.description_checked_at).getTime() : 0;
  return checked < now - RECHECK_MS;
}

async function fromWikipedia(market: MarketToDescribe): Promise<Described | null> {
  const title = ownArticleTitle(market.vi_components);
  if (!title) return null;
  const summary = await fetchArticleSummary(title).catch(() => null);
  const text = summary?.extract ? leadSentences(summary.extract) : '';
  return text.length >= 20 ? { description: text, source: 'wikipedia' } : null;
}

async function fromKnowYourMeme(market: MarketToDescribe): Promise<Described | null> {
  const found = await knowYourMemeEntry(market);
  return found?.description ? { description: found.description, source: found.descriptionSource ?? found.source } : null;
}

async function fromReferencePage(market: MarketToDescribe): Promise<Described | null> {
  for (const url of market.sourceUrls.slice(0, MAX_REFERENCE_PAGES)) {
    const found = await pageImage(url, market.entity_name).catch(() => null);
    if (found?.description) return { description: found.description, source: found.descriptionSource ?? found.source };
  }
  return null;
}

const modelSchema = z.object({
  // False when the context and common knowledge do not say what the
  // subject is; the description is then empty and nothing is stored.
  known: z.boolean(),
  description: z.string(),
});

const SYSTEM = `You write the one- or two-sentence description shown under a subject's name on a board that tracks attention to people, brands, memes, events and works.

Say what the subject is, plainly, the way an encyclopedia's first sentence would: who or what it is, what it is known for. The subject is exactly the name given, with every word of it: when the name pins one instance of a broader thing (a film in a franchise, a director's take, one edit of a meme, a product's version), describe that instance and its specifics, never the broader thing. Use the context given and common knowledge you are sure of; the context is what people submitted about the subject and may describe one post rather than the subject itself, so lift the subject from it, not the post, and take dates, names and places from it. The subject is a thing in the world, never a poster, screenshot, image or page: when the context describes an image of something, describe that something. Treat the context's guesses about authenticity (fan-made, hypothetical, rumoured) as unknown rather than fact. If you cannot tell what the subject is, set known to false and leave the description empty rather than guess.

Never mention screenshots, posts, captures, submissions, this board or attention. No hype, no adjectives of praise. At most 220 characters.`;

// Pure: the prompt the model fallback sees.
export function buildDescribePrompt(market: { entity_name: string; entity_type: string | null; category: string | null; aliases: string[] | null }, context: string[]): string {
  const lines = [
    `Subject: ${market.entity_name}`,
    `Type: ${market.entity_type ?? 'unknown'}${market.category ? ` (${market.category})` : ''}`,
    market.aliases?.length ? `Also known as: ${market.aliases.join(', ')}` : '',
    '',
    'Context, newest first:',
    ...context.map((c, i) => `${i + 1}. ${c}`),
  ];
  return lines.filter((l, i) => l !== '' || i === 3).join('\n');
}

async function fromModel(market: MarketToDescribe, model?: LanguageModel): Promise<Described | null> {
  const { data: captures } = await createAdminClient()
    .from('captures')
    .select('raw_ai_response, ocr_text')
    .eq('market_id', market.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(2);
  const context = (captures ?? [])
    .map((c) => JSON.stringify({ ...(c.raw_ai_response ?? {}), ...(c.ocr_text ? { text: c.ocr_text } : {}) }).replace(/\s+/g, ' ').slice(0, MAX_CONTEXT_CHARS))
    .filter((c) => c.length > 2);
  if (context.length === 0) return null;
  const result = await generateText({
    model: model ?? MODEL,
    system: SYSTEM,
    prompt: buildDescribePrompt(market, context),
    output: Output.object({ schema: modelSchema }),
    providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
    temperature: 0,
    maxOutputTokens: 200,
    abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  const out = result.output;
  if (!out?.known) return null;
  const text = leadSentences(out.description);
  return text.length >= 20 ? { description: text, source: MODEL_SOURCE } : null;
}

// The first source that has something to say.
export async function findDescription(market: MarketToDescribe, model?: LanguageModel): Promise<Described | null> {
  return (await fromWikipedia(market)) ?? (await fromKnowYourMeme(market)) ?? (await fromReferencePage(market)) ?? (await fromModel(market, model));
}

export async function describeMarkets({ limit = 12, marketIds, force = false, dryRun = false, model }: DescribeOptions = {}): Promise<DescribeResult> {
  const supabase = createAdminClient();
  const result: DescribeResult = { considered: 0, set: 0, none: 0, failed: 0, log: [] };

  let query = supabase
    .from('markets')
    .select('id, entity_name, entity_type, category, aliases, vi_components, current_vi, description_source, description_checked_at')
    .is('deleted_at', null)
    .is('description_source', null)
    .order('current_vi', { ascending: false, nullsFirst: false });
  if (marketIds) query = query.in('id', marketIds);
  const { data, error } = await query;
  if (error) throw error;

  const now = Date.now();
  const due = (data ?? []).filter((m) => dueForDescription(m, { force, now }));
  result.considered = due.length;
  const batch = due.slice(0, limit);
  if (batch.length === 0) return result;

  const { data: captures, error: capErr } = await supabase
    .from('captures')
    .select('market_id, source_url')
    .in('market_id', batch.map((m) => m.id))
    .is('deleted_at', null)
    .not('source_url', 'is', null)
    .order('created_at', { ascending: false });
  if (capErr) throw capErr;
  const urls = new Map<string, string[]>();
  for (const c of captures ?? []) {
    if (!c.market_id || !c.source_url) continue;
    urls.set(c.market_id, [...(urls.get(c.market_id) ?? []), c.source_url]);
  }

  for (const row of batch) {
    const market: MarketToDescribe = { ...row, vi_components: row.vi_components as Components | null, sourceUrls: urls.get(row.id) ?? [] };
    try {
      const found = await findDescription(market, model);
      if (!dryRun) {
        const patch: { description_checked_at: string; description?: string; description_source?: string } = { description_checked_at: new Date().toISOString() };
        if (found) {
          patch.description = found.description;
          patch.description_source = found.source;
        }
        // Never over a description written by hand or found meanwhile.
        const { error: upErr } = await supabase.from('markets').update(patch).eq('id', market.id).is('description_source', null);
        if (upErr) throw upErr;
      }
      result[found ? 'set' : 'none']++;
      result.log.push(`${market.entity_name}: ${found ? `${found.source} "${found.description.slice(0, 80)}"` : 'none'}`);
    } catch (err) {
      result.failed++;
      result.log.push(`${market.entity_name}: failed`);
      console.error(`[describe] ${market.entity_name} failed:`, err);
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  return result;
}

export { MANUAL_SOURCE };
