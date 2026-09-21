// Embeds every live market that has no embedding yet.
//
//   npm run backfill:embeddings
//
// Markets created before Phase 2, and markets seeded by scripts, have no
// vector, so cosine retrieval cannot find them. This fills the gap using
// the same text format and model as lib/embed.ts: "name. Also known as:
// aliases. description". Safe to re-run; it only touches null rows.

import { embedMany } from 'ai';
import { createClient } from '@supabase/supabase-js';

const MODEL = process.env.EMBED_MODEL ?? 'cohere/embed-v4.0';
const DIMS = 512;

function truncateAndNormalise(vec) {
  const head = vec.slice(0, DIMS);
  let norm = 0;
  for (const x of head) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return head.map((x) => x / norm);
}

export function marketEmbeddingText(m) {
  const parts = [m.entity_name];
  if (m.aliases?.length) parts.push(`Also known as: ${m.aliases.join(', ')}`);
  return parts.join('. ');
}

export async function backfillEmbeddings({ admin, log = console.log } = {}) {
  admin ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const { data: rows, error } = await admin
    .from('markets')
    .select('id, entity_name, aliases')
    .is('deleted_at', null)
    .is('embedding', null)
    .limit(500);
  if (error) throw error;
  if (!rows?.length) {
    log('backfill: nothing to do');
    return 0;
  }
  const { embeddings } = await embedMany({
    model: MODEL,
    values: rows.map(marketEmbeddingText),
    providerOptions: { cohere: { inputType: 'search_document', truncate: 'END' } },
    maxParallelCalls: 2,
  });
  let n = 0;
  for (let i = 0; i < rows.length; i++) {
    const vec = truncateAndNormalise(embeddings[i]);
    const { error: upErr } = await admin
      .from('markets')
      .update({ embedding: `[${vec.join(',')}]` })
      .eq('id', rows[i].id);
    if (upErr) throw upErr;
    n++;
  }
  log(`backfill: embedded ${n} markets`);
  return n;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  await backfillEmbeddings();
}
