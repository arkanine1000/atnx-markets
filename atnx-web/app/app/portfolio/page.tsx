"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import {
  useDemoContext,
  calculatePnL,
  type Position,
} from "@/context/DemoContext";
import { useAuth } from "@/context/AuthContext";
import { ClosePositionModal, DemoToast } from "@/components/Trading";
import { PortfolioMobile } from "@/components/PortfolioMobile";
import { PortfolioChart } from "@/components/PortfolioChart";
import { usePortfolioFeed } from "@/components/usePortfolioFeed";
import { Card, Chip, DeltaChip, EmptyState, Readout, StatTile } from "@/components/ui";
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
            className="font-bold text-primary text-[15px] hover:text-atnx-cyan transition-colors break-words"
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
            className={`font-display text-2xl font-bold leading-none tabular-nums ${pnlTone}`}
          >
            {pnl.isProfit ? "+" : ""}${pnl.pnlAmount}
          </div>
          <DeltaChip value={pnlPct} className="mt-1" />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 mt-4 pt-3 border-t border-surface">
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
          <Readout key={String(k)} label={k} value={v} valueClassName={String(cls)} />
        ))}
      </div>

      <div className="mt-3 pt-3 border-t border-surface flex items-center justify-between">
        <Link
          href={`/app/markets/${position.marketId}`}
          className="text-[11px] text-tertiary hover:text-atnx-cyan transition-colors"
        >
          View market {"↗"}
        </Link>
        <button
          type="button"
          onClick={() => onClose(position)}
          className="text-xs px-4 py-2 rounded-full bg-atnx-magenta text-white font-bold shadow-[0_0_16px_rgba(255,0,229,0.25)] hover:brightness-110 transition cursor-pointer"
        >
          Close position
        </button>
      </div>
    </Card>
  );
}

export default function PortfolioPage() {
  const { positions, balance, fees, closePosition } = useDemoContext();
  const { user, loading: authLoading, openLoginModal } = useAuth();
  const [closingPosition, setClosingPosition] = useState<Position | null>(null);
  // Any trade elsewhere on the page changes the ids and refetches the feed.
  const feed = usePortfolioFeed(positions.map((p) => p.id).join(","));
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
  const handleCloseById = useCallback(
    async (id: string) => {
      const closed = await closePosition(id);
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
      <div>
        <EmptyState
          title="Sign in to view your portfolio"
          body="Balance, open positions and PnL are tied to your account."
          action={
            <button
              type="button"
              onClick={openLoginModal}
              className="text-xs px-5 py-2.5 rounded-full btn-magenta font-bold cursor-pointer"
            >
              Login
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-5">
        <h2 className="font-display text-xl sm:text-2xl font-bold text-primary tracking-tight">
          Portfolio
        </h2>
      </div>

      {/* Phones: the side-panel layout (value tile, collapsible card). */}
      <div className="md:hidden">
        <PortfolioMobile feed={feed} onClosePosition={handleCloseById} />
      </div>

      {/* Desktop: Equity over PnL | Fees on the left, the value chart
          filling the space to their right. */}
      <div className="hidden md:grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4 mb-6">
        <div className="flex flex-col gap-4 min-w-0">
          <StatTile
            label="Equity"
            value={`$${equity.toFixed(2)}`}
            hero
          />
          <div className="grid grid-cols-2 gap-4">
            <StatTile
              label="Unrealized PnL"
              value={
                <span className={pnlTone}>
                  {totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(2)}
                </span>
              }
              sub={<DeltaChip value={totalPnLPercent} />}
            />
            <StatTile
              label="Fees earned"
              value={
                <span className={fees.earned > 0 ? "text-atnx-cyan light:text-atnx-cyan-light" : ""}>
                  {fees.earned > 0 ? "+" : ""}${fees.earned.toFixed(2)}
                </span>
              }
            />
          </div>
        </div>
        <PortfolioChart feed={feed} />
      </div>

      <div className="hidden md:block">
        {positions.length === 0 ? (
          <EmptyState
            title="No open positions"
            body="Pick a market and take a side. Long if you think attention is heading up, short if it's fading."
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {positions.map((pos) => (
              <PositionCard key={pos.id} position={pos} onClose={handleClose} />
            ))}
          </div>
        )}
      </div>

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
