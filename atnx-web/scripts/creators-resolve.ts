// Dry run of the creator channel resolver over the person markets. Reads
// markets and captures, calls YouTube (channels/videos lists, 1 unit each)
// and Wikidata, writes nothing. Channel searches only with --search.
//   npm run creators:resolve [-- --search] [-- --name "Forrest Jones"]
import { createClient } from '@supabase/supabase-js';
import { resolveYoutube } from '../lib/creators/resolve';

const args = process.argv.slice(2);
const allowSearch = args.includes('--search');
const only = args.includes('--name') ? args[args.indexOf('--name') + 1] : null;

async function main() {
  const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: markets, error } = await s
    .from('markets')
    .select('id, entity_name, aliases, entity_type, vi_components')
    .is('deleted_at', null)
    .eq('entity_type', 'person')
    .order('entity_name');
  if (error) throw error;

  let units = 0;
  let searches = 0;
  for (const m of markets ?? []) {
    if (only && m.entity_name !== only) continue;
    const { data: caps } = await s.from('captures').select('source_url, ocr_text').eq('market_id', m.id).is('deleted_at', null);
    const wiki = (m.vi_components as Record<string, { meta?: { title?: string | null } }> | null)?.wikipedia?.meta?.title ?? null;
    const r = await resolveYoutube({ name: m.entity_name, aliases: m.aliases ?? [], wikipediaTitle: wiki, captures: caps ?? [], allowSearch });
    units += r.cost.units;
    searches += r.cost.searches;
    const b = r.best?.channel;
    console.log(`\n${m.entity_name}  →  ${r.status.toUpperCase()}${b ? `  @${b.handle ?? '?'} "${b.title}" ${b.subscribers ?? 'hidden'} subs` : ''}  (${r.reason})`);
    for (const c of r.candidates.sort((x, y) => (y.channel.subscribers ?? 0) - (x.channel.subscribers ?? 0))) {
      console.log(`   @${String(c.channel.handle).padEnd(28)} ${String(c.channel.subscribers ?? 'hidden').padStart(10)} subs  ${c.channel.videos} videos  name:${c.nameMatch ? 'y' : 'n'}  evidence: ${c.evidence.join(', ')}`);
    }
  }
  console.log(`\nquota: ${units} units, ${searches} searches`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
