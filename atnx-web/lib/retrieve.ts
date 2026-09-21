import { createAdminClient } from './supabase/admin';
import { toPgVector } from './embed';
import type { CandidateMarket } from './vlm';

// Candidate retrieval for the model call and for the post-model link check.
// Two cheap, unindexed queries: nearest markets by embedding and nearest by
// trigram similarity on the normalised name. Union, dedupe by id, keep the
// best score of each kind per market.

export interface ScoredCandidate extends CandidateMarket {
  cosine: number | null;
  trigram: number | null;
}

export interface RetrievalResult {
  candidates: ScoredCandidate[];
  maxCosine: number | null;
  maxTrigram: number | null;
  best: ScoredCandidate | null;
}

export function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

export async function retrieveCandidates(opts: {
  embedding?: number[] | null;
  // Name and aliases; each is trigram-matched against market names and
  // aliases, and the best score per market is kept.
  names?: string[] | null;
  limit?: number;
}): Promise<RetrievalResult> {
  const admin = createAdminClient();
  const limit = opts.limit ?? 10;
  const byId = new Map<string, ScoredCandidate>();

  const upsert = (
    row: { id: string; entity_name: string; entity_type: string | null; similarity: number },
    kind: 'cosine' | 'trigram'
  ) => {
    const existing = byId.get(row.id) ?? {
      id: row.id,
      name: row.entity_name,
      entityType: row.entity_type,
      cosine: null,
      trigram: null,
    };
    existing[kind] = Math.max(existing[kind] ?? -Infinity, row.similarity);
    byId.set(row.id, existing);
  };

  const queries: Promise<void>[] = [];

  if (opts.embedding?.length) {
    const embedding = opts.embedding;
    queries.push(
      (async () => {
        const { data, error } = await admin.rpc('match_markets_by_embedding', {
          query_embedding: toPgVector(embedding),
          match_count: limit,
        });
        if (error) throw error;
        for (const r of data ?? []) upsert(r, 'cosine');
      })()
    );
  }

  const names = [...new Set((opts.names ?? []).map(normalizeName).filter(Boolean))].slice(0, 9);
  for (const name of names) {
    queries.push(
      (async () => {
        const { data, error } = await admin.rpc('match_markets_by_name', {
          query_name: name,
          match_count: 5,
        });
        if (error) throw error;
        for (const r of data ?? []) upsert(r, 'trigram');
      })()
    );
  }

  await Promise.all(queries);

  // Rank by the stronger of the two signals so the list handed to the model
  // (and the audit row) puts the likeliest match first.
  const candidates = [...byId.values()]
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit);

  let maxCosine: number | null = null;
  let maxTrigram: number | null = null;
  for (const c of candidates) {
    if (c.cosine !== null) maxCosine = Math.max(maxCosine ?? -Infinity, c.cosine);
    if (c.trigram !== null) maxTrigram = Math.max(maxTrigram ?? -Infinity, c.trigram);
  }

  return { candidates, maxCosine, maxTrigram, best: candidates[0] ?? null };
}

function score(c: ScoredCandidate): number {
  return Math.max(c.cosine ?? 0, c.trigram ?? 0);
}
