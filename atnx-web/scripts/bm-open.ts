// Opens a bounded market on an atnx market from the keeper, without the
// site's sign-in (operations use). Pass a market uuid or a name fragment;
// with no argument it lists the ten liveliest candidates.
//
//   npm run bm:open -- "Labubu"            open on the default chain
//   npm run bm:open -- <uuid> eip155:421614
import { createAdminClient } from '../lib/supabase/admin';
import { DEFAULT_CHAIN } from '../lib/bm/chains';
import { openBoundedMarket, readLiveVi, viIsFresh } from '../lib/bm/open';
import { bounds } from '../lib/bm/bounds';

async function main() {
  const [arg, chainKey = DEFAULT_CHAIN] = process.argv.slice(2);
  const db = createAdminClient();
  if (!arg) {
    const { data } = await db
      .from('markets')
      .select('id, entity_name, current_vi, vi_state, vi_last_updated')
      .is('deleted_at', null)
      .eq('vi_state', 'live')
      .order('current_vi', { ascending: false })
      .limit(10);
    for (const m of data ?? []) {
      const b = bounds(Math.max(1, Number(m.current_vi)));
      console.log(`${m.id}  VI ${Math.round(Number(m.current_vi)).toString().padStart(5)}  bounds ${b.lower}-${b.upper}  ${viIsFresh(m.vi_last_updated) ? 'fresh' : 'STALE'}  ${m.entity_name}`);
    }
    return;
  }
  let id = arg;
  if (!/^[0-9a-f-]{36}$/i.test(arg)) {
    const { data } = await db
      .from('markets')
      .select('id, entity_name')
      .is('deleted_at', null)
      .ilike('entity_name', `%${arg}%`)
      .limit(1);
    if (!data?.length) throw new Error(`no market matching ${arg}`);
    id = data[0].id;
    console.log(`matched ${data[0].entity_name} (${id})`);
  }
  const snap = await readLiveVi(id);
  console.log('VI', snap);
  const r = await openBoundedMarket({ atnxMarketId: id, chainKey });
  console.log(JSON.stringify(r, null, 2));
  if (!r.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
