// The admission gate for generic names, as a Jev Choice. Runs on every
// proposal to create a market (lib/blocklist.ts guardProposal), after the
// regex and the blocklist. In shadow it only records; on, it rejects when
// the name is very likely not a subject and sends the borderline to review.
import { jevEvaluate, roundProbs } from './jev';

export const GATE_KINDS = ['specific_subject', 'generic_phrase', 'calendar_or_time', 'everyday_word_or_category'] as const;
export type GateKind = (typeof GATE_KINDS)[number];

export interface GateVerdict {
  kind: GateKind;
  probabilities: Record<string, number>;
  // P(not a specific subject): the three generic kinds summed.
  pGeneric: number;
  model: string;
  latency_ms: number;
  input_tokens: number | null;
}

// Reject at or above this; review from REVIEW_AT up to it. Pure.
export const REJECT_AT = 0.9;
export const REVIEW_AT = 0.5;
export function gateAction(pGeneric: number): 'reject' | 'review' | 'allow' {
  if (pGeneric >= REJECT_AT) return 'reject';
  if (pGeneric >= REVIEW_AT) return 'review';
  return 'allow';
}

export function pGenericOf(probabilities: Record<string, number>): number {
  return Math.min(1, Math.max(0, (probabilities.generic_phrase ?? 0) + (probabilities.calendar_or_time ?? 0) + (probabilities.everyday_word_or_category ?? 0)));
}

export interface GateInput {
  name: string;
  entityType: string;
  category: string;
  aliases: string[];
  // What the model read from the capture, when there is any.
  captureText?: string | null;
}

export async function jevAdmission(input: GateInput): Promise<GateVerdict | null> {
  const state = {
    proposed_market: { name: input.name, entity_type: input.entityType, category: input.category, aliases: input.aliases.slice(0, 8) },
    capture_text: (input.captureText ?? '').replace(/\s+/g, ' ').trim().slice(0, 1500) || null,
  };
  const r = await jevEvaluate(
    state,
    {
      kind: {
        type: 'choice',
        instructions:
          'ATNX tracks pieces of internet culture as markets. Judge the proposed market NAME as a subject people would follow: what kind of name is it? A meme built on a phrase is a specific subject under the meme\'s own name; the phrase alone is not.',
        criteria: {
          specific_subject: 'a specific person, brand, product, meme, work, event, place or token with its own public identity',
          generic_phrase: 'a generic phrase, slogan or saying with no single subject behind it',
          calendar_or_time: 'a date, month, year, quarter, season, weekday or other period of time',
          everyday_word_or_category: 'a common word or a category of things, such as memes, football, cats or news',
        },
      },
    },
    `admission "${input.name}"`
  );
  if (!r) return null;
  const a = r.answers.kind;
  const probabilities = roundProbs(a.probabilities);
  return { kind: a.choice as GateKind, probabilities, pGeneric: Math.round(pGenericOf(probabilities) * 1000) / 1000, model: r.model, latency_ms: r.latencyMs, input_tokens: r.inputTokens };
}
