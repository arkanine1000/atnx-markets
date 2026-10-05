import { NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/cron';
import { runKeeper } from '@/lib/bm/keeper-run';

// The keeper: Vercel cron, every five minutes (vercel.json), production
// deployments only. One tick (lib/bm/keeper-run.ts): bounded markets
// first (resolve on a bound touch, roll a new one unless BM_AUTO_ROLL=0),
// then, with BM_ROUNDS_ENABLED=1, the rolling rounds on Solana devnet
// (create pending series, ante, open, settle, void; lib/bm/rounds.ts).
// `?dry=1` reports what it would do without sending or writing anything.
//
//   curl -H "Authorization: Bearer $CRON_SECRET" https://markets.atnx.app/api/bm/keeper?dry=1

export const maxDuration = 60;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const dry = new URL(request.url).searchParams.get('dry') === '1';
  try {
    return NextResponse.json(await runKeeper({ dry }));
  } catch (err) {
    console.error('[bm keeper] failed', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
