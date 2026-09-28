// Two guards between "the model proposed a new market" and "a market
// exists": names that can never be subjects, and names an admin retired.
//
// A calendar phrase ("November 2026") was admitted as a meme market and
// its Trends reading counted everyone searching for a calendar. The model
// prompt now asks for a reject, and this file makes sure of it whatever
// the model says: a proposal whose name (or an alias) is a calendar
// period, or sits in blocked_terms (supabase/021, filled when an admin
// retires a market), is rejected before anything is created.
import { createAdminClient } from './supabase/admin';
import { normalizeName } from './retrieve';
import type { RoutingDecision } from './route';

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec';
// Only forms that cannot be a title. A bare year ("1984", "2012", "1917")
// and a weekday ("Wednesday") are films, novels and series, so they are
// left to the model's judgement and the blocklist.
const GENERIC: RegExp[] = [
  new RegExp(`^(${MONTHS})\\.?,?\\s+\\d{4}$`, 'i'), // November 2026, Nov. 2026
  new RegExp(`^\\d{4}\\s+(${MONTHS})$`, 'i'), // 2026 November
  /^(q[1-4]|h[12])\s*\d{4}$/i, // Q4 2026
  new RegExp(`^(${MONTHS})\\s+\\d{1,2}(st|nd|rd|th)?,?\\s+\\d{4}$`, 'i'), // November 5, 2026
  /^the \d{2,4}s$/i, // the 90s
];

// A name that is a calendar period, not a subject. Pure.
export function isGenericPhrase(name: string): boolean {
  const n = normalizeName(name);
  return GENERIC.some((re) => re.test(n));
}

// Which of the names sit in blocked_terms, normalised. Empty when the
// table is missing (migration 021 not applied): the guard fails open and
// logs, the generic-phrase rule still applies.
export async function blockedTerms(names: string[]): Promise<string[]> {
  const wanted = [...new Set(names.map(normalizeName).filter((n) => n.length >= 2))];
  if (wanted.length === 0) return [];
  const { data, error } = await createAdminClient().from('blocked_terms').select('term_normalized').in('term_normalized', wanted);
  if (error) {
    console.error(`[blocklist] lookup failed: ${error.message}`);
    return [];
  }
  return (data ?? []).map((r) => r.term_normalized as string);
}

// A proposal to create a market, checked. Returns the decision to use:
// the original, or a rejection with what was blocked.
export async function guardProposal(decision: RoutingDecision): Promise<RoutingDecision> {
  if (decision.outcome !== 'created' && decision.outcome !== 'created_review') return decision;
  const names = [decision.newMarket.name, ...decision.newMarket.aliases];
  const generic = names.find(isGenericPhrase);
  if (generic) return { outcome: 'rejected', reason: 'not_cultural_content', blocked: `generic phrase: ${generic}` };
  const hits = await blockedTerms(names);
  if (hits.length) return { outcome: 'rejected', reason: 'policy', blocked: `retired: ${hits.join(', ')}` };
  return decision;
}

// Blocks a retired market's name and aliases (the dashboard's Retire).
export async function blockMarketTerms(market: { id: string; entity_name: string; aliases: string[] | null }, reason: string, by: string | null): Promise<number> {
  const terms = [...new Set([market.entity_name, ...(market.aliases ?? [])].map(normalizeName).filter((n) => n.length >= 2))];
  if (terms.length === 0) return 0;
  const { error } = await createAdminClient()
    .from('blocked_terms')
    .upsert(terms.map((t) => ({ term_normalized: t, reason, source_market_id: market.id, created_by: by })), { onConflict: 'term_normalized', ignoreDuplicates: true });
  if (error) throw new Error(`blocked_terms upsert: ${error.message}`);
  return terms.length;
}
