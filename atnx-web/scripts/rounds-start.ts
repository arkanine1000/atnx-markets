// Starts a series of VI rounds on an atnx market from the keeper, without
// the site (operations use). Pass a market uuid or a name fragment; with
// no argument it lists the ten liveliest candidates.
//
//   npm run rounds:start -- "Labubu"                  daily rounds
//   npm run rounds:start -- <uuid> --fast             the hourly demo series
//   npm run rounds:start -- <uuid> --finder <pubkey>  someone else is the finder
//   npm run rounds:start -- <uuid> --dry              validate only
//
// The finder defaults to the keeper's wallet.
import { createAdminClient } from '../lib/supabase/admin';
import { readLiveVi, viIsFresh } from '../lib/bm/open';
import { keeperWallet, roundParams, startSeries } from '../lib/bm/rounds';

function flag(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const args = process.argv.slice(2);
  const finderArg = flag('--finder');
  const arg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--finder');
  const fast = args.includes('--fast');
  const dry = args.includes('--dry');
  const db = createAdminClient();
  if (!arg) {
    const { data } = await db
      .from('markets')
      .select('id, entity_name, current_vi, vi_state, vi_last_updated')
      .is('deleted_at', null)
      .eq('vi_state', 'live')
      .gt('current_vi', 0)
      .order('current_vi', { ascending: false })
      .limit(10);
    for (const m of data ?? []) {
      console.log(`${m.id}  VI ${Number(m.current_vi).toFixed(2).padStart(8)}  ${viIsFresh(m.vi_last_updated) ? 'fresh' : 'STALE'}  ${m.entity_name}`);
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
  console.log('VI', await readLiveVi(id));
  console.log(fast ? 'fast series' : 'daily series', roundParams(fast));
  const finderWallet = finderArg ?? keeperWallet();
  const r = await startSeries({ atnxMarketId: id, finderWallet, fast, dry });
  console.log(JSON.stringify(r, null, 2));
  if (!r.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
