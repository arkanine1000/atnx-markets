// Fills markets.aliases for live markets that have none. Markets created
// before the taxonomy pass carry no aliases, and the VI sources search
// for the name and its aliases together, so those markets were queried by
// canonical title alone.
//
//   npm run aliases:backfill              # writes
//   npm run aliases:backfill -- --dry-run # prints proposals, writes nothing
//
// Uses the same text model and gateway as the capture pipeline.
import { createClient } from '@supabase/supabase-js';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { isSearchableAlias } from '../lib/vi/score';

const MODEL = process.env.VLM_MODEL_TEXT ?? 'google/gemini-3.5-flash-lite';
const dryRun = process.argv.includes('--dry-run');

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const schema = z.object({
  aliases: z.array(z.string().min(1).max(80)).max(6),
});

const SYSTEM = `You name the other ways people refer to a cultural subject online, so that searches for it catch the posts and articles that are actually about it.

Given a market's canonical name, type, category and description, return up to six aliases: alternative spellings, shorter forms people actually type, the hashtag form without the #, nicknames, and the original caption or catchphrase if the subject is a meme. Every alias must be a phrase someone would plausibly write in a post or headline about this subject.

Each alias is used as a search phrase, so a post or article that contains it must be about this subject and nothing broader. Never return the franchise, show, character, person, brand or platform the subject comes from unless the market IS that thing: for a reaction meme of an actor, the actor's bare name is wrong; for a SpongeBob meme, "SpongeBob" is wrong. No single common words ("troll", "problem", "toilet"). Do not include the canonical name itself, generic words ("meme", "viral video"), or descriptions.`;

(async () => {
  const { data: markets, error } = await sb
    .from('markets')
    .select('id, entity_name, entity_type, category, aliases')
    .is('deleted_at', null)
    .order('created_at');
  if (error) throw error;

  const todo = (markets ?? []).filter((m) => !m.aliases || (m.aliases as string[]).length === 0);
  console.log(`${todo.length} of ${markets?.length ?? 0} live markets have no aliases${dryRun ? ' (dry run)' : ''}`);

  for (const m of todo) {
    // The latest capture's description gives the model the context.
    const { data: cap } = await sb
      .from('captures')
      .select('raw_ai_response')
      .eq('market_id', m.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const description = (cap?.raw_ai_response as { description?: string } | null)?.description ?? '';

    const prompt = [
      `Name: ${m.entity_name}`,
      m.entity_type ? `Type: ${m.entity_type}` : null,
      m.category ? `Category: ${m.category}` : null,
      description ? `Description: ${description}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const result = await generateText({
        model: MODEL,
        system: SYSTEM,
        prompt,
        output: Output.object({ schema }),
        providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
        temperature: 0,
        maxOutputTokens: 400,
      });
      const aliases = (result.output?.aliases ?? [])
        .map((a) => a.trim())
        .filter((a, i, all) => a && a.toLowerCase() !== m.entity_name.toLowerCase() && all.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i)
        .filter(isSearchableAlias);
      console.log(`${m.entity_name}  =>  ${aliases.join(' | ') || '(none)'}`);
      if (dryRun || aliases.length === 0) continue;
      const { error: upErr } = await sb.from('markets').update({ aliases }).eq('id', m.id);
      if (upErr) throw upErr;
    } catch (err) {
      console.error(`  failed for ${m.entity_name}:`, (err as Error).message?.split('\n')[0]);
    }
  }
})();
