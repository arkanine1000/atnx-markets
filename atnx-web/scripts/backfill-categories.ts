// Fills markets.category for live markets that have none. Markets seeded
// before the category enum landed (supabase/002) carry a null, which puts
// them last in the category sort and leaves the review screen's create
// form without a default when a capture proposes one of them.
//
//   npm run categories:backfill              # writes
//   npm run categories:backfill -- --dry-run # prints proposals, writes nothing
//
// One text-model call per market with the fixed enum as the schema, so the
// answer is always one of the ten values the check constraint accepts.
import { createClient } from '@supabase/supabase-js';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { CATEGORIES } from '../lib/vlm';

const MODEL = process.env.VLM_MODEL_TEXT ?? 'google/gemini-3.5-flash-lite';
const dryRun = process.argv.includes('--dry-run');

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const schema = z.object({
  category: z.enum(CATEGORIES),
  // One line, printed for the operator; not stored.
  why: z.string().max(160),
});

const SYSTEM = `You file a cultural subject that people trade attention on into exactly one category.

The categories: memes (image macros, formats, catchphrases, brainrot, edits whose identity is the joke itself), crypto (coins, tokens, crypto people and events), politics (politicians, elections, political events and the memes that are primarily about politics), sports (athletes, teams, matches, sports memes), music (artists, songs, albums, tours), film_tv (films, series, characters, actors known for a role), gaming (games, studios, gaming hardware and memes that live in gaming), tech (products, companies, founders, software), people (public figures who do not fit a narrower category: creators, streamers, influencers, models), other (anything that fits none of these).

Pick by what the subject is primarily about, not by where it appears. A meme about a politician is politics; a meme about a graphics setting is gaming; a reaction meme with no subject beyond itself is memes. A person goes to the field they are known for (an athlete is sports, a singer is music) and to people only when no field fits.`;

(async () => {
  const { data: markets, error } = await sb
    .from('markets')
    .select('id, entity_name, entity_type, category, aliases')
    .is('deleted_at', null)
    .order('created_at');
  if (error) throw error;

  const todo = (markets ?? []).filter((m) => !m.category);
  console.log(`${todo.length} of ${markets?.length ?? 0} live markets have no category${dryRun ? ' (dry run)' : ''}`);

  for (const m of todo) {
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
      (m.aliases as string[] | null)?.length ? `Also known as: ${(m.aliases as string[]).join(', ')}` : null,
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
        maxOutputTokens: 200,
      });
      const out = result.output;
      if (!out || !(CATEGORIES as readonly string[]).includes(out.category)) {
        console.error(`  no valid category for ${m.entity_name}`);
        continue;
      }
      console.log(`${m.entity_name.padEnd(44)} ${m.entity_type?.padEnd(7) ?? '       '} => ${out.category.padEnd(9)} ${out.why}`);
      if (dryRun) continue;
      const { error: upErr } = await sb.from('markets').update({ category: out.category }).eq('id', m.id);
      if (upErr) throw upErr;
    } catch (err) {
      console.error(`  failed for ${m.entity_name}:`, (err as Error).message?.split('\n')[0]);
    }
  }
})();
