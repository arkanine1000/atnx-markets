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
  const pnlColor = pnl.isProfit ? "#00FF66" : "#FF0040";

  return (
    <div className="bg-atnx-surface border border-atnx-border rounded-lg p-4 space-y-3 transition-opacity duration-300">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className={`text-xs font-bold px-2 py-0.5 rounded ${
              isLong
                ? "bg-green-500/20 text-green-400 border border-green-500/30"
                : "bg-red-500/20 text-red-400 border border-red-500/30"
            }`}
          >
            {isLong ? "LONG" : "SHORT"}
          </span>
          <span className="font-bold text-atnx-text text-sm">
            {position.name}
          </span>
        </div>
        <span
          className="text-lg font-bold font-mono tabular-nums"
          style={{ color: pnlColor }}
        >
          {pnl.isProfit ? "+" : ""}${pnl.pnlAmount}
        </span>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-4 text-sm">
        <div>
          <div className="text-xs text-atnx-text-muted uppercase">Entry</div>
          <div className="font-mono text-atnx-text">{position.entryIndex}</div>
        </div>
        <div>
          <div className="text-xs text-atnx-text-muted uppercase">Current</div>
          <div className="font-mono text-atnx-text">
            {position.currentIndex}
          </div>
        </div>
        <div>
          <div className="text-xs text-atnx-text-muted uppercase">Change</div>
          <div className="font-mono font-bold" style={{ color: pnlColor }}>
            {pnl.isProfit ? "+" : ""}
            {pnl.pnlPercent}%
          </div>
        </div>
        <div>
          <div className="text-xs text-atnx-text-muted uppercase">Size</div>
          <div className="font-mono text-atnx-text">
            ${position.size.toFixed(2)}
          </div>
        </div>
        <div>
          <div className="text-xs text-atnx-text-muted uppercase">Value</div>
          <div className="font-mono text-atnx-text">${pnl.currentValue}</div>
        </div>
        <div>
          <div className="text-xs text-atnx-text-muted uppercase">Opened</div>
          <div className="text-atnx-text-muted">
            {timeAgo(position.openedAt)}
          </div>
        </div>
      </div>

      {/* Close button */}
      <div className="flex justify-end">
        <button
          onClick={() => onClose(position)}
          className="text-xs px-4 py-1.5 rounded border border-atnx-border text-atnx-text-muted hover:border-red-500/50 hover:text-red-400 cursor-pointer transition-colors"
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
    (pos: Position) => {
      const closed = closePosition(pos.id);
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

  // Calculate totals
  const totalPnL = positions.reduce((sum, pos) => {
    const pnl = calculatePnL(pos);
    return sum + parseFloat(pnl.pnlAmount);
  }, 0);
  const totalSize = positions.reduce((sum, pos) => sum + pos.size, 0);
  const totalPnLPercent = totalSize > 0 ? (totalPnL / totalSize) * 100 : 0;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 w-full">
      <Nav captureCount={captureCount} />

      {/* Portfolio summary */}
      <div className="bg-atnx-surface border border-atnx-border rounded-lg p-5 mb-6 grid grid-cols-3 gap-4">
        <div>
          <div className="text-xs text-atnx-text-muted uppercase tracking-wider mb-1">
            Balance
          </div>
          <div className="text-xl font-bold font-mono text-atnx-text">
            ${balance.toFixed(2)}
          </div>
          <div className="text-xs text-atnx-text-muted">USDC</div>
        </div>
        <div>
          <div className="text-xs text-atnx-text-muted uppercase tracking-wider mb-1">
            Open Positions
          </div>
          <div className="text-xl font-bold font-mono text-atnx-text">
            {positions.length}
          </div>
        </div>
        <div>
          <div className="text-xs text-atnx-text-muted uppercase tracking-wider mb-1">
            Total PnL
          </div>
          <div
            className="text-xl font-bold font-mono"
            style={{ color: totalPnL >= 0 ? "#00FF66" : "#FF0040" }}
          >
            {totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(2)}
          </div>
          <div
            className="text-xs font-mono"
            style={{ color: totalPnL >= 0 ? "#00FF66" : "#FF0040" }}
          >
            ({totalPnLPercent >= 0 ? "+" : ""}
            {totalPnLPercent.toFixed(2)}%)
          </div>
        </div>
      </div>

      {/* Positions list */}
      {positions.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-atnx-text-muted text-sm">No open positions.</p>
          <p className="text-atnx-text-muted text-xs mt-2">
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
