"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import { Card, DeltaChip, EmptyState, StatTile, compactUsd } from "@/components/ui";
import { Identicon } from "@/components/Identicon";
import { STARTING_BALANCE, type LeaderboardRow } from "@/lib/leaderboard";
import type { Treasury } from "@/lib/treasury";
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
  1: "bg-atnx-yellow/15 text-atnx-yellow light:text-atnx-yellow-light border-atnx-yellow/40",
  2: "bg-atnx-cyan/10 text-atnx-cyan light:text-atnx-cyan-light border-atnx-cyan/30",
  3: "bg-atnx-magenta/10 text-atnx-magenta light:text-atnx-magenta-light border-atnx-magenta/30",
};

function RankBadge({ rank }: { rank: number }) {
  const tone = RANK_TONE[rank] ?? "bg-elevated text-tertiary border-surface";
  return (
    <span
      className={`h-7 w-9 shrink-0 inline-flex items-center justify-center rounded-lg border font-mono font-bold tabular-nums text-xs ${tone}`}
    >
      {rank}
    </span>
  );
}

function Row({ row, me }: { row: LeaderboardRow; me: boolean }) {
  const pnlTone = (n: number) =>
    n >= 0
      ? "text-atnx-cyan light:text-atnx-cyan-light"
      : "text-atnx-magenta light:text-atnx-magenta-light";
  return (
    <div
      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-colors ${
        me
          ? "bg-atnx-cyan/5 border-atnx-cyan/40"
          : "bg-surface border-surface hover:border-atnx-cyan/35"
      }`}
    >
      <RankBadge rank={row.rank} />
      <Identicon seed={row.userId} size={32} className="border border-surface" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-primary truncate flex items-center gap-2">
          <span className="truncate">@{row.handle}</span>
          {me && (
            <span className="rounded-md border border-atnx-cyan/30 bg-atnx-cyan/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-atnx-cyan light:text-atnx-cyan-light">
              you
            </span>
          )}
        </div>
        <div className="text-xs text-tertiary truncate">
          {row.totalTrades} {row.totalTrades === 1 ? "trade" : "trades"}
          {row.openPositions > 0 && ` · ${row.openPositions} open`}
          {row.volumeUsd > 0 && ` · ${compactUsd(row.volumeUsd)} vol`}
          {row.feesEarnedUsd > 0 && (
            <span className="md:hidden"> · {usd.format(row.feesEarnedUsd)} fees</span>
          )}
        </div>
      </div>
      <div className="hidden md:block w-24 text-right font-mono text-xs tabular-nums">
        <div className="text-[10px] uppercase tracking-wider text-tertiary">Realized</div>
        <div className={pnlTone(row.realizedPnl)}>{signedUsd(row.realizedPnl)}</div>
      </div>
      <div className="hidden md:block w-24 text-right font-mono text-xs tabular-nums">
        <div className="text-[10px] uppercase tracking-wider text-tertiary">Unrealized</div>
        <div className={pnlTone(row.unrealizedPnl)}>{signedUsd(row.unrealizedPnl)}</div>
      </div>
      <div
        className="hidden lg:block w-24 text-right font-mono text-xs tabular-nums"
        title="Half of every trading fee on markets this account created"
      >
        <div className="text-[10px] uppercase tracking-wider text-tertiary">Fees earned</div>
        <div className={row.feesEarnedUsd > 0 ? pnlTone(1) : "text-tertiary"}>
          {row.feesEarnedUsd > 0 ? signedUsd(row.feesEarnedUsd) : "—"}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="font-mono font-bold text-primary tabular-nums text-sm sm:text-base">
          {usd.format(row.equity)}
        </div>
        <DeltaChip value={row.returnPct} className="mt-0.5" />
      </div>
    </div>
  );
}

export function LeaderboardView({
  rows,
  treasury,
}: {
  rows: LeaderboardRow[];
  treasury: Treasury;
}) {
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
  const creatorFees = rows.reduce((sum, r) => sum + r.feesEarnedUsd, 0);

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-xl sm:text-2xl font-bold text-primary tracking-tight">
          Leaderboard
        </h2>
        <p className="text-xs text-tertiary mt-1">
          Everyone starts with {usd.format(STARTING_BALANCE)}. Ranked by equity:
          cash plus open positions marked to the live VI, including fees earned
          from markets you created.
        </p>
      </div>

      {/* Phones show three tiles: the field, the treasury and where you stand. */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4 mb-6">
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
          label="Treasury"
          value={usd.format(treasury.balanceUsd)}
          sub={`${usd.format(creatorFees)} paid to market creators`}
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
              className="inline-block text-xs px-5 py-2.5 rounded-full bg-atnx-magenta text-white font-bold hover:bg-atnx-magenta-dim transition-colors"
            >
              Browse markets
            </Link>
          }
        />
      ) : (
        <div className="space-y-1.5">
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
        </div>
      )}

      {rows.length > SHOW && !pinned && (
        <p className="text-xs text-tertiary mt-3 text-center">
          Showing the top {SHOW} of {rows.length}.
        </p>
      )}

      <Card className="mt-6 p-4 text-xs text-tertiary leading-relaxed">
        Simulated trading only. Equity counts realised results already in
        your balance plus what your open positions would be worth if closed
        now, so it moves with every VI refresh. Every open pays a 1% fee on
        its size: half goes to whoever created the market, half to the
        treasury. A position that loses its whole size is liquidated.
      </Card>
    </div>
  );
}
