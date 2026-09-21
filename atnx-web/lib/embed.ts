import { embed, type EmbeddingModel } from 'ai';

// One text embedding call through the Vercel AI Gateway.
//
// The gateway exposes every embedding model as text-only (checked against
// its model list on 2026-09-20), so images are never embedded directly.
// Instead the pipeline embeds text on both sides: the page title and any
// submitted text before the model call, and the model's proposed market
// name, aliases and description after it. Markets store the latter.

const MODEL = process.env.EMBED_MODEL ?? 'cohere/embed-v4.0';
export const EMBED_DIMS = 512;

// Embed v4 is Matryoshka-trained, so truncating its default 1536-dim output
// to the first 512 dims and renormalising is the documented way to get a
// smaller vector. Done here rather than through a provider option so it
// works the same for any model the env var points at.
function truncateAndNormalise(vec: number[]): number[] {
  const head = vec.length > EMBED_DIMS ? vec.slice(0, EMBED_DIMS) : vec;
  if (head.length !== EMBED_DIMS) {
    throw new Error(`embedding has ${head.length} dims, expected ${EMBED_DIMS}`);
  }
  let norm = 0;
  for (const x of head) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return head.map((x) => x / norm);
}

export async function embedText(
  text: string,
  opts: { purpose?: 'query' | 'document'; model?: EmbeddingModel } = {}
): Promise<number[]> {
  const value = text.replace(/\s+/g, ' ').trim().slice(0, 4000);
  if (!value) throw new Error('embedText needs non-empty text');

  const { embedding } = await embed({
    model: opts.model ?? MODEL,
    value,
    providerOptions: {
      cohere: {
        inputType: opts.purpose === 'document' ? 'search_document' : 'search_query',
        truncate: 'END',
      },
    },
  });
  return truncateAndNormalise(embedding);
}

// The text a market is embedded from. Kept in one place so query-side and
// document-side strings are built the same way.
export function marketEmbeddingText(m: {
  name: string;
  aliases?: string[] | null;
  description?: string | null;
}): string {
  const parts = [m.name];
  if (m.aliases?.length) parts.push(`Also known as: ${m.aliases.join(', ')}`);
  if (m.description) parts.push(m.description);
  return parts.join('. ');
}

// pgvector accepts a JSON-array string through PostgREST.
export function toPgVector(vec: number[]): string {
  return `[${vec.join(',')}]`;
}
