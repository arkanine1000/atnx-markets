"use client";

import { useState, useEffect, useCallback } from "react";
import { useDemoContext, calculatePnL, type Position } from "@/context/DemoContext";
import { Nav } from "@/components/Nav";
import { ClosePositionModal, DemoToast } from "@/components/Trading";

function timeAgo(timestamp: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(timestamp).getTime()) / 1000
  );
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function PositionCard({
  position,
  onClose,
}: {
  position: Position;
  onClose: (pos: Position) => void;
}) {
  const pnl = calculatePnL(position);
  const isLong = position.type === "long";
  // PnL arrow: cyan for profit, magenta for loss. Number always yellow.
  const directionColor = pnl.isProfit ? "#00D4FF" : "#FF00E5";
  const directionArrow = pnl.isProfit ? "\u25B2" : "\u25BC";

  return (
    <div className="bg-surface border border-surface rounded-lg p-4 space-y-3 transition-opacity duration-300 hover:border-atnx-cyan/30">
      {/* Header */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span
            className={`text-xs font-bold px-2 py-0.5 rounded shrink-0 ${
              isLong
                ? "bg-atnx-cyan/15 text-atnx-cyan border border-atnx-cyan/30"
                : "bg-atnx-magenta/15 text-atnx-magenta border border-atnx-magenta/30"
            }`}
          >
            {isLong ? "LONG" : "SHORT"}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            <span style={{ color: directionColor }} className="text-sm">
              {directionArrow}
            </span>
            <span className="text-lg font-bold font-mono tabular-nums text-atnx-yellow">
              {pnl.isProfit ? "+" : ""}${pnl.pnlAmount}
            </span>
          </div>
        </div>
        <div className="font-bold text-primary text-sm break-words">
          {position.name}
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4 text-sm">
        <div>
          <div className="text-xs text-tertiary uppercase">Entry</div>
          <div className="font-mono text-atnx-cyan">{position.entryIndex}</div>
        </div>
        <div>
          <div className="text-xs text-tertiary uppercase">Current</div>
          <div className="font-mono text-atnx-cyan">
            {position.currentIndex}
          </div>
        </div>
        <div>
          <div className="text-xs text-tertiary uppercase">Change</div>
          <div className="font-mono font-bold flex items-center gap-1">
            <span style={{ color: directionColor }}>{directionArrow}</span>
            <span className="text-atnx-yellow">
              {Math.abs(parseFloat(pnl.pnlPercent))}%
            </span>
          </div>
        </div>
        <div>
          <div className="text-xs text-tertiary uppercase">Size</div>
          <div className="font-mono text-secondary">
            ${position.size.toFixed(2)}
          </div>
        </div>
        <div>
          <div className="text-xs text-tertiary uppercase">Value</div>
          <div className="font-mono text-primary">${pnl.currentValue}</div>
        </div>
        <div>
          <div className="text-xs text-tertiary uppercase">Opened</div>
          <div className="text-tertiary">
            {timeAgo(position.openedAt)}
          </div>
        </div>
      </div>

      {/* Close button — magenta */}
      <div className="flex justify-stretch sm:justify-end">
        <button
          onClick={() => onClose(position)}
          className="text-xs px-4 py-2 sm:py-1.5 rounded border border-surface text-secondary hover:border-atnx-magenta/50 hover:text-atnx-magenta cursor-pointer transition-colors w-full sm:w-auto"
        >
          Close Position
        </button>
      </div>
    </div>
  );
}

export default function PortfolioPage() {
  const { positions, balance } = useDemoContext();
  const { closePosition } = useDemoContext();
  const [captureCount, setCaptureCount] = useState(0);
  const [closingPosition, setClosingPosition] = useState<Position | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    detail: string;
    type: "long" | "short" | "close-profit" | "close-loss";
  } | null>(null);

  useEffect(() => {
    fetch("/api/captures")
      .then((r) => r.json())
      .then((d) => setCaptureCount(d.captures?.length ?? 0))
      .catch(() => {});
  }, []);

  const handleClose = useCallback(
    async (pos: Position) => {
      const closed = await closePosition(pos.id);
      if (closed) {
        setClosingPosition(closed);
      }
    },
    [closePosition]
  );

  const handleCloseModalDismiss = useCallback(() => {
    if (closingPosition) {
      const pnl = calculatePnL(closingPosition);
      setToast({
        message: `Closed ${closingPosition.type.toUpperCase()} ${closingPosition.name}`,
        detail: `${pnl.isProfit ? "Profit" : "Loss"}: ${pnl.isProfit ? "+" : ""}$${pnl.pnlAmount}`,
        type: pnl.isProfit ? "close-profit" : "close-loss",
      });
    }
    setClosingPosition(null);
  }, [closingPosition]);

  const totalPnL = positions.reduce((sum, pos) => {
    const pnl = calculatePnL(pos);
    return sum + parseFloat(pnl.pnlAmount);
  }, 0);
  const totalSize = positions.reduce((sum, pos) => sum + pos.size, 0);
  const totalPnLPercent = totalSize > 0 ? (totalPnL / totalSize) * 100 : 0;
  const totalDirColor = totalPnL >= 0 ? "#00D4FF" : "#FF00E5";
  const totalDirArrow = totalPnL >= 0 ? "\u25B2" : "\u25BC";

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 w-full">
      <Nav captureCount={captureCount} />

      {/* Portfolio summary */}
      <div className="bg-surface border border-surface rounded-lg p-4 sm:p-5 mb-6 grid grid-cols-3 gap-2 sm:gap-4">
        <div className="min-w-0">
          <div className="text-[10px] sm:text-xs text-tertiary uppercase tracking-wider mb-1">
            Balance
          </div>
          <div className="text-base sm:text-xl font-bold font-mono text-atnx-yellow truncate">
            ${balance.toFixed(2)}
          </div>
          <div className="text-[10px] sm:text-xs text-tertiary">USDC</div>
        </div>
        <div className="min-w-0">
          <div className="text-[10px] sm:text-xs text-tertiary uppercase tracking-wider mb-1">
            <span className="sm:hidden">Positions</span>
            <span className="hidden sm:inline">Open Positions</span>
          </div>
          <div className="text-base sm:text-xl font-bold font-mono text-primary">
            {positions.length}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-[10px] sm:text-xs text-tertiary uppercase tracking-wider mb-1">
            Total PnL
          </div>
          <div className="text-base sm:text-xl font-bold font-mono flex items-center gap-1">
            <span style={{ color: totalDirColor }}>{totalDirArrow}</span>
            <span className="text-atnx-yellow truncate">
              {totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(2)}
            </span>
          </div>
          <div className="text-[10px] sm:text-xs font-mono flex items-center gap-1">
            <span style={{ color: totalDirColor }}>{totalDirArrow}</span>
            <span className="text-atnx-yellow truncate">
              {totalPnLPercent >= 0 ? "+" : ""}
              {totalPnLPercent.toFixed(2)}%
            </span>
          </div>
        </div>
      </div>

      {/* Positions list */}
      {positions.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-secondary text-sm">No open positions.</p>
          <p className="text-tertiary text-xs mt-2">
            Go to the Dashboard and click &ldquo;Trade This&rdquo; on a capture
            to open a position.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
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
