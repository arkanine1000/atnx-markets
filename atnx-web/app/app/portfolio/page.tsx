"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import {
  useDemoContext,
  calculatePnL,
  type Position,
} from "@/context/DemoContext";
import { useAuth } from "@/context/AuthContext";
import { Nav } from "@/components/Nav";
import { ClosePositionModal, DemoToast } from "@/components/Trading";
import { Card, Chip, DeltaChip, EmptyState, StatTile } from "@/components/ui";
import { timeAgo } from "@/lib/capture-view";

function PositionCard({
  position,
  onClose,
}: {
  position: Position;
  onClose: (pos: Position) => void;
}) {
  const pnl = calculatePnL(position);
  const isLong = position.type === "long";
  const pnlPct = parseFloat(pnl.pnlPercent);
  const pnlTone = pnl.isProfit
    ? "text-atnx-cyan light:text-atnx-cyan-light"
    : "text-atnx-magenta light:text-atnx-magenta-light";

  return (
    <Card className="p-4 sm:p-5 card-hover">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/app/markets/${position.marketId}`}
            className="font-bold text-primary text-sm hover:text-atnx-cyan transition-colors break-words"
          >
            {position.name}
          </Link>
          <div className="flex items-center gap-1.5 mt-1.5">
            <Chip tone={isLong ? "cyan" : "magenta"}>
              {isLong ? "Long" : "Short"} {position.leverage}&times;
            </Chip>
            <span className="text-[11px] text-tertiary">
              {timeAgo(position.openedAt)}
            </span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div
            className={`text-xl font-bold font-mono tabular-nums ${pnlTone}`}
          >
            {pnl.isProfit ? "+" : ""}${pnl.pnlAmount}
          </div>
          <DeltaChip value={pnlPct} className="mt-1" />
        </div>
      </div>

      <dl className="grid grid-cols-4 gap-2 mt-4 text-xs">
        {[
          [
            "Entry",
            position.entryIndex,
            "text-atnx-yellow light:text-atnx-yellow-light",
          ],
          [
            "Current",
            position.currentIndex,
            "text-atnx-yellow light:text-atnx-yellow-light",
          ],
          ["Size", `$${position.size.toFixed(0)}`, "text-primary"],
          ["Value", `$${pnl.currentValue}`, "text-primary"],
        ].map(([k, v, cls]) => (
          <div
            key={String(k)}
            className="rounded-lg bg-elevated border border-surface px-2.5 py-2 min-w-0"
          >
            <dt className="text-[10px] uppercase tracking-wider text-tertiary">
              {k}
            </dt>
            <dd
              className={`mt-0.5 font-mono font-bold tabular-nums truncate ${cls}`}
            >
              {v}
            </dd>
          </div>
        ))}
      </dl>

      <button
        type="button"
        onClick={() => onClose(position)}
        className="mt-3 w-full py-2 rounded-lg border border-surface text-xs font-bold text-secondary hover:border-atnx-magenta/50 hover:text-atnx-magenta cursor-pointer transition-colors"
      >
        Close position
      </button>
    </Card>
  );
}

export default function PortfolioPage() {
  const { positions, balance, closePosition } = useDemoContext();
  const { user, loading: authLoading, openLoginModal } = useAuth();
  const [closingPosition, setClosingPosition] = useState<Position | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    detail: string;
    type: "long" | "short" | "close-profit" | "close-loss";
  } | null>(null);

  const handleClose = useCallback(
    async (pos: Position) => {
      const closed = await closePosition(pos.id);
      if (closed) setClosingPosition(closed);
    },
    [closePosition],
  );

  const handleCloseModalDismiss = useCallback(() => {
    if (closingPosition) {
      const pnl = calculatePnL(closingPosition);
      setToast({
        message: `Closed ${closingPosition.type} ${closingPosition.name}`,
        detail: `${pnl.isProfit ? "Profit" : "Loss"}: ${pnl.isProfit ? "+" : ""}$${pnl.pnlAmount}`,
        type: pnl.isProfit ? "close-profit" : "close-loss",
      });
    }
    setClosingPosition(null);
  }, [closingPosition]);

  const totalPnL = positions.reduce(
    (sum, pos) => sum + parseFloat(calculatePnL(pos).pnlAmount),
    0,
  );
  const totalSize = positions.reduce((sum, pos) => sum + pos.size, 0);
  const totalPnLPercent = totalSize > 0 ? (totalPnL / totalSize) * 100 : 0;
  const equity = balance + totalSize + totalPnL;
  const pnlTone =
    totalPnL >= 0
      ? "text-atnx-cyan light:text-atnx-cyan-light"
      : "text-atnx-magenta light:text-atnx-magenta-light";

  if (!authLoading && !user) {
    return (
      <div className="max-w-6xl mx-auto px-4 pb-12 w-full">
        <Nav />
        <EmptyState
          title="Sign in to view your portfolio"
          body="Balance, open positions and PnL are tied to your account."
          action={
            <button
              type="button"
              onClick={openLoginModal}
              className="text-xs px-5 py-2.5 rounded-full bg-atnx-magenta text-white font-bold hover:bg-atnx-magenta-dim cursor-pointer transition-colors"
            >
              Login
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 pb-12 w-full">
      <Nav />

      <div className="mb-5">
        <h2 className="text-xl sm:text-2xl font-bold text-primary tracking-tight">
          Portfolio
        </h2>
        <p className="text-xs text-tertiary mt-1">Simulated USDC account</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
        <StatTile
          label="Equity"
          value={`$${equity.toFixed(2)}`}
          hero
          sub="balance + positions"
        />
        <StatTile
          label="Available"
          value={`$${balance.toFixed(2)}`}
          sub="USDC"
        />
        <StatTile
          label="Open positions"
          value={positions.length}
          sub={`$${totalSize.toFixed(0)} deployed`}
        />
        <StatTile
          label="Unrealized PnL"
          value={
            <span className={pnlTone}>
              {totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(2)}
            </span>
          }
          sub={<DeltaChip value={totalPnLPercent} />}
        />
      </div>

      {positions.length === 0 ? (
        <EmptyState
          title="No open positions"
          body="Pick a market and take a side. Long if you think attention is heading up, short if it's fading."
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {positions.map((pos) => (
            <PositionCard key={pos.id} position={pos} onClose={handleClose} />
          ))}
        </div>
      )}

      {closingPosition && (
        <ClosePositionModal
          position={closingPosition}
          onClose={handleCloseModalDismiss}
        />
      )}

      {toast && (
        <DemoToast
          message={toast.message}
          detail={toast.detail}
          type={toast.type}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}
