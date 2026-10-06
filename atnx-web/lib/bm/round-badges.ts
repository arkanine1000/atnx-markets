import { memo } from '@/lib/memo';
import { listLiveRounds } from './rounds-registry';
import type { RoundBadgeInfo } from '@/components/rounds/RoundBadge';

// The current round per atnx market id, for the listing's round badges,
// its Live / Up next tabs and its "Closing soonest" order. Registry only:
// no chain reads in lists. The markets page renders with it and
// /api/markets sends it along with a tabbed listing, so the client's poll
// keeps the badges and the tabs in step.
export type RoundsMap = Record<string, RoundBadgeInfo>;

// The same window as the listing it rides with.
const TTL_MS = 15_000;

export function getRoundBadges(): Promise<RoundsMap> {
  return memo('rounds:badges', TTL_MS, async () => {
    const liveRounds = await listLiveRounds();
    const rounds: RoundsMap = {};
    // One round badge per market: a round in flight beats a presale, the
    // daily series beats the fast demo one.
    const rank = (r: (typeof liveRounds)[number]) => (r.state === 'presale' ? 2 : 0) + (r.series.fast ? 1 : 0);
    for (const r of [...liveRounds].sort((a, b) => rank(a) - rank(b))) {
      rounds[r.series.atnx_market_id] ??= {
        idx: r.idx,
        state: r.state,
        target: r.target_vi,
        closeAt: r.close_at,
        tradeUntil: r.trade_until,
        opensAt: r.opens_at,
        fast: r.series.fast,
      };
    }
    return rounds;
  });
}

// Markets whose badge round is live: the Live tab. A round opening or
// settling, a presale, or no series at all is Up next.
export function liveMarketIds(rounds: RoundsMap): string[] {
  return Object.keys(rounds)
    .filter((id) => rounds[id].state === 'live')
    .sort();
}
