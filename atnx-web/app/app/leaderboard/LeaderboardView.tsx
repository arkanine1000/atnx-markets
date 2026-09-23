"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import { Card, DeltaChip, EmptyState, StatTile, compactUsd } from "@/components/ui";
import { Identicon } from "@/components/Identicon";
import { STARTING_BALANCE, type LeaderboardRow } from "@/lib/leaderboard";
import { startPolling } from "@/lib/poll";

const REFRESH_MS = 30_000;
const SHOW = 100;

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

function signedUsd(n: number) {
  return `${n >= 0 ? "+" : "-"}${usd.format(Math.abs(n))}`;
}

// Top three get the brand's three inks; everyone else a quiet number.
const RANK_TONE: Record<number, string> = {
  1: "text-atnx-yellow light:text-atnx-yellow-light",
  2: "text-atnx-cyan light:text-atnx-cyan-light",
  3: "text-atnx-magenta light:text-atnx-magenta-light",
};

function Rank({ rank }: { rank: number }) {
  const tone = RANK_TONE[rank] ?? "text-tertiary";
  return (
    <span
      className={`w-7 shrink-0 text-right font-mono font-bold tabular-nums text-sm ${tone}`}
    >
      {rank}
    </span>
  );
}

// Column widths shared by the header row and every data row.
const COL_PNL = "hidden md:block w-24 text-right";
const COL_EQUITY = "w-24 sm:w-28 text-right";

function Row({ row, me }: { row: LeaderboardRow; me: boolean }) {
  const pnlTone = (n: number) =>
    n >= 0
      ? "text-atnx-cyan light:text-atnx-cyan-light"
      : "text-atnx-magenta light:text-atnx-magenta-light";
  return (
    <div
      className={`flex items-center gap-3 px-3 py-2.5 border-l-2 hover-lift ${
        me ? "bg-atnx-cyan/5 border-l-atnx-cyan" : "border-l-transparent"
      }`}
    >
      <Rank rank={row.rank} />
      <Identicon seed={row.userId} size={32} className="border border-surface" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-primary truncate flex items-center gap-2">
          <span className="truncate">@{row.handle}</span>
          {me && (
            <span className="rounded-md border border-atnx-cyan/30 bg-atnx-cyan/10 px-1.5 py-0.5 text-[10px] font-bold font-mono uppercase tracking-wider text-atnx-cyan light:text-atnx-cyan-light">
              you
            </span>
          )}
        </div>
        <div className="text-xs text-tertiary truncate">
          {row.totalTrades} {row.totalTrades === 1 ? "trade" : "trades"}
          {row.openPositions > 0 && ` · ${row.openPositions} open`}
          {row.volumeUsd > 0 && ` · ${compactUsd(row.volumeUsd)} vol`}
        </div>
      </div>
      <div className={`${COL_PNL} font-mono text-xs tabular-nums ${pnlTone(row.realizedPnl)}`}>
        {signedUsd(row.realizedPnl)}
      </div>
      <div className={`${COL_PNL} font-mono text-xs tabular-nums ${pnlTone(row.unrealizedPnl)}`}>
        {signedUsd(row.unrealizedPnl)}
      </div>
      <div className={`${COL_EQUITY} shrink-0`}>
        <div className="font-display font-bold text-primary tabular-nums text-[15px] sm:text-base leading-none">
          {usd.format(row.equity)}
        </div>
        <DeltaChip value={row.returnPct} className="mt-1" />
      </div>
    </div>
  );
}

export function LeaderboardView({ rows }: { rows: LeaderboardRow[] }) {
  const router = useRouter();
  const { user } = useAuth();

  // Re-render from the server while the tab is visible so the marks move
  // with the VI. router.refresh() keeps the header and scroll position.
  useEffect(
    () => startPolling(async () => router.refresh(), { intervalMs: REFRESH_MS }),
    [router]
  );

  const top = rows.slice(0, SHOW);
  const mine = user ? rows.find((r) => r.userId === user.id) ?? null : null;
  const pinned = mine && mine.rank > SHOW ? mine : null;
  const leader = rows[0];
  const totalVolume = rows.reduce((sum, r) => sum + r.volumeUsd, 0);
  const totalTrades = rows.reduce((sum, r) => sum + r.totalTrades, 0);

  return (
    <div>
      <div className="mb-5">
        <h2 className="font-display text-xl sm:text-2xl font-bold text-primary tracking-tight">
          Leaderboard
        </h2>
        <p className="text-xs text-tertiary mt-1">
          Everyone starts with {usd.format(STARTING_BALANCE)}. Ranked by equity:
          cash plus open positions marked to the live VI.
        </p>
      </div>

      {/* Phones show two tiles: the field and where you stand. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
        <StatTile label="Traders" value={rows.length} sub="with at least one trade" />
        <StatTile
          label="Volume"
          value={compactUsd(totalVolume)}
          sub={`${totalTrades} ${totalTrades === 1 ? "trade" : "trades"} · simulated USDC`}
          className="hidden md:block"
        />
        <StatTile
          label="Leader"
          value={leader ? `@${leader.handle}` : "—"}
          sub={leader ? <DeltaChip value={leader.returnPct} /> : undefined}
          className="hidden md:block"
        />
        <StatTile
          label="Your rank"
          value={mine ? `#${mine.rank}` : user ? "—" : "Sign in"}
          sub={
            mine ? (
              <DeltaChip value={mine.returnPct} />
            ) : user ? (
              "make a trade to enter"
            ) : (
              "to see where you stand"
            )
          }
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No trades yet"
          body="The board fills in as soon as someone takes a position."
          action={
            <Link
              href="/app"
              className="inline-block text-xs px-5 py-2.5 rounded-full btn-magenta font-bold"
            >
              Browse markets
            </Link>
          }
        />
      ) : (
        <div>
          <div className="flex items-center gap-3 px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider text-tertiary">
            <span className="w-7 text-right shrink-0">#</span>
            <span className="w-8 shrink-0" />
            <span className="flex-1">Trader</span>
            <span className={COL_PNL}>Realized</span>
            <span className={COL_PNL}>Unrealized</span>
            <span className={`${COL_EQUITY} shrink-0`}>Equity</span>
          </div>
          <Card className="overflow-hidden divide-y divide-(--color-dark-border) light:divide-(--color-light-border)">
            {top.map((r) => (
              <Row key={r.userId} row={r} me={r.userId === user?.id} />
            ))}
            {pinned && (
              <>
                <div className="text-center text-[11px] text-tertiary py-1" aria-hidden="true">
                  ···
                </div>
                <Row row={pinned} me />
              </>
            )}
          </Card>
        </div>
      )}

      {rows.length > SHOW && !pinned && (
        <p className="text-xs text-tertiary mt-3 text-center">
          Showing the top {SHOW} of {rows.length}.
        </p>
      )}

      <p className="mt-6 text-xs text-tertiary leading-relaxed max-w-prose">
        Simulated trading only. Equity counts realised results already in
        your balance plus what your open positions would be worth if closed
        now, so it moves with every VI refresh.
      </p>
    </div>
  );
}
