import { createAdminClient } from './supabase/admin';
import type { Json, SubmissionOutcome } from './supabase/database';
import type { CandidateMarket, RejectReason, SubmissionAnalysis } from './vlm';
import type { RetrievalResult, ScoredCandidate } from './retrieve';

// Deterministic routing on the model's output and the retrieval evidence.
// Pure: no I/O. The caller persists whatever the decision says and then
// writes the audit row with recordDecision().
//
// | Condition                                        | Outcome        |
// |--------------------------------------------------|----------------|
// | admit: false                                     | rejected       |
// | matched_market_id in the shown candidate list    | matched        |
// | proposal's best neighbour clears a link threshold| linked         |
// | otherwise, confidence high or medium             | created        |
// | otherwise, confidence low                        | created_review |

export const LINK_COSINE = Number(process.env.LINK_COSINE ?? 0.88);
export const LINK_TRIGRAM = Number(process.env.LINK_TRIGRAM ?? 0.85);

export interface NewMarketSpec {
  name: string;
  entityType: string;
  category: string;
  aliases: string[];
  embedding: string | null; // pgvector string
}

export type RoutingDecision =
  // `blocked` names what the blocklist guard (lib/blocklist.ts) refused.
  | { outcome: 'rejected'; reason: RejectReason; blocked?: string }
  | { outcome: 'matched'; marketId: string; similarity: number; matched: CandidateMarket }
  | { outcome: 'linked'; marketId: string; similarity: number; matched: ScoredCandidate }
  | { outcome: 'created' | 'created_review'; newMarket: NewMarketSpec };

export function routeSubmission(input: {
  submission: SubmissionAnalysis;
  shownCandidates: CandidateMarket[];
  postRetrieval: RetrievalResult | null;
  embedding: string | null;
}): RoutingDecision {
  const { submission: s } = input;

  if (!s.admit) {
    return { outcome: 'rejected', reason: s.reject_reason ?? 'not_cultural_content' };
  }

  if (s.matched_market_id) {
    const matched = input.shownCandidates.find((c) => c.id === s.matched_market_id);
    if (matched) {
      return { outcome: 'matched', marketId: matched.id, similarity: 1, matched };
    }
    // vlm.ts already nulls ids that were not shown; this is belt and braces.
  }

  if (!s.new_market) {
    return { outcome: 'rejected', reason: 'unreadable' };
  }

  const best = input.postRetrieval?.best ?? null;
  if (best && ((best.cosine ?? 0) >= LINK_COSINE || (best.trigram ?? 0) >= LINK_TRIGRAM)) {
    return {
      outcome: 'linked',
      marketId: best.id,
      similarity: Math.max(best.cosine ?? 0, best.trigram ?? 0),
      matched: best,
    };
  }

  const newMarket: NewMarketSpec = {
    name: s.new_market.name,
    entityType: s.new_market.entity_type,
    category: s.new_market.category,
    aliases: s.new_market.aliases,
    embedding: input.embedding,
  };
  return { outcome: s.confidence === 'low' ? 'created_review' : 'created', newMarket };
}

export interface DecisionRecord {
  outcome: SubmissionOutcome;
  captureId?: string | null;
  userId?: string | null;
  contentHash?: string | null;
  marketId?: string | null;
  candidates?: CandidateMarket[] | ScoredCandidate[];
  retrieval?: RetrievalResult | null;
  submission?: SubmissionAnalysis | null;
  rejectReason?: string | null;
  extra?: Record<string, Json>;
}

// Writes the audit row. Never throws: a failed audit write is logged and the
// user still gets their answer.
export async function recordDecision(d: DecisionRecord): Promise<void> {
  try {
    const s = d.submission ?? null;
    const { error } = await createAdminClient().from('submission_decisions').insert({
      outcome: d.outcome,
      capture_id: d.captureId ?? null,
      user_id: d.userId ?? null,
      content_hash: d.contentHash ?? null,
      market_id: d.marketId ?? null,
      candidates: (d.candidates ?? []) as unknown as Json,
      max_cosine: d.retrieval?.maxCosine ?? null,
      max_trigram: d.retrieval?.maxTrigram ?? null,
      model_confidence: s?.confidence ?? null,
      reject_reason: d.rejectReason ?? s?.reject_reason ?? null,
      model: s?.model ?? null,
      latency_ms: s?.latencyMs ?? null,
      model_response: s
        ? ({ ...stripModelMeta(s), ...(d.extra ?? {}) } as unknown as Json)
        : d.extra
          ? (d.extra as unknown as Json)
          : null,
    });
    if (error) throw error;
  } catch (err) {
    console.error('[route] recordDecision failed', (err as Error).message);
  }
}

function stripModelMeta(s: SubmissionAnalysis): Record<string, unknown> {
  const { model: _model, latencyMs: _latencyMs, ...rest } = s;
  void _model;
  void _latencyMs;
  return rest;
}
