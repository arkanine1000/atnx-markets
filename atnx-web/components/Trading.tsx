"use client";

import { useEffect, useState } from "react";
import { positionPnl } from "@/lib/pnl";

// Toast notification
interface ToastProps {
  message: string;
  detail?: string;
  type: "long" | "short" | "close-profit" | "close-loss";
  onDismiss: () => void;
}

export function DemoToast({ message, detail, type, onDismiss }: ToastProps) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 3500);
    return () => clearTimeout(t);
  }, [onDismiss]);

  const bad = type === "short" || type === "close-loss";
  const accent = bad ? "#FF00E5" : "#00D4FF";

  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 animate-slide-in">
      <div
        className="bg-elevated pl-4 pr-5 py-3 rounded-xl shadow-2xl flex items-center gap-3 border border-surface"
        style={{
          boxShadow: `0 12px 40px rgba(0,0,0,0.4), inset 3px 0 0 ${accent}`,
        }}
      >
        <span
          className="h-7 w-7 rounded-full inline-flex items-center justify-center text-sm shrink-0"
          style={{ background: `${accent}22`, color: accent }}
        >
          {type === "close-loss" ? "↓" : "✓"}
        </span>
        <div>
          <div className="text-sm font-bold text-primary whitespace-nowrap">
            {message}
          </div>
          {detail && <div className="text-xs text-secondary">{detail}</div>}
        </div>
      </div>
    </div>
  );
}

// Close position modal
interface CloseModalProps {
  position: {
    type: "long" | "short";
    name: string;
    entryIndex: number;
    currentIndex: number;
    size: number;
    leverage?: number;
  };
  onClose: () => void;
}

export function ClosePositionModal({ position, onClose }: CloseModalProps) {
  const leverage = position.leverage ?? 1;
  const {
    pnlUsd: pnlAmount,
    pnlPercent,
    liquidated,
  } = positionPnl({
    sizeUsd: position.size,
    entryVi: position.entryIndex,
    currentVi: position.currentIndex,
    direction: position.type,
    leverage,
  });
  const isProfit = pnlAmount >= 0;
  // Profit: cyan accent, Loss: magenta accent
  const accentColor = isProfit ? "#00D4FF" : "#FF00E5";
  const barWidth = Math.min(100, Math.abs(pnlPercent));

  useEffect(() => {
    const t = setTimeout(onClose, 6000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        backgroundColor: "rgba(0,0,0,0.7)",
        backdropFilter: "blur(4px)",
      }}
    >
      <div className="bg-elevated border border-surface rounded-2xl p-7 w-full max-w-sm mx-4 text-center">
        <div
          className="mx-auto mb-3 h-12 w-12 rounded-full inline-flex items-center justify-center text-xl"
          style={{ background: `${accentColor}22`, color: accentColor }}
        >
          {isProfit ? "↑" : "↓"}
        </div>
        <h2 className="font-display text-lg font-bold text-primary">
          {liquidated ? "Position liquidated" : "Position closed"}
        </h2>
        <p className="text-xs text-secondary mt-1 mb-5">
          {position.name} &middot; {position.type.toUpperCase()} {leverage}
          &times;
          {liquidated && " · the loss reached the full size"}
        </p>

        <div
          className="text-3xl font-bold font-mono mb-1"
          style={{ color: accentColor }}
        >
          {pnlAmount >= 0 ? "+" : "-"}${Math.abs(pnlAmount).toFixed(2)}
        </div>
        <div className="text-xs font-mono mb-5" style={{ color: accentColor }}>
          {pnlPercent >= 0 ? "+" : ""}
          {pnlPercent.toFixed(1)}%
        </div>

        <dl className="space-y-1.5 text-xs text-left mb-5">
          <div className="flex justify-between">
            <dt className="text-tertiary">Entry</dt>
            <dd className="text-atnx-yellow font-mono">
              {position.entryIndex}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-tertiary">Exit</dt>
            <dd className="text-atnx-yellow font-mono">
              {position.currentIndex}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-tertiary">Size</dt>
            <dd className="text-primary font-mono">
              ${position.size.toFixed(2)}
            </dd>
          </div>
        </dl>

        <div className="w-full bg-surface rounded-full h-1.5 mb-5">
          <div
            className="h-1.5 rounded-full transition-all duration-500"
            style={{ width: `${barWidth}%`, backgroundColor: accentColor }}
          />
        </div>

        <button
          type="button"
          onClick={onClose}
          className="w-full py-2.5 rounded-xl border border-surface text-sm text-primary hover:border-atnx-cyan/50 cursor-pointer transition-colors"
        >
          Back to portfolio
        </button>
      </div>
    </div>
  );
}

// Close confirmation: shows what closing now returns, and waits for a yes.
export function ConfirmCloseModal({
  position,
  onConfirm,
  onCancel,
}: {
  position: CloseModalProps["position"];
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const leverage = position.leverage ?? 1;
  const { pnlUsd, pnlPercent } = positionPnl({
    sizeUsd: position.size,
    entryVi: position.entryIndex,
    currentVi: position.currentIndex,
    direction: position.type,
    leverage,
  });
  const isProfit = pnlUsd >= 0;
  const tone = isProfit
    ? "text-atnx-cyan light:text-atnx-cyan-light"
    : "text-atnx-magenta light:text-atnx-magenta-light";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
      onClick={() => !busy && onCancel()}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-close-title"
        onClick={(e) => e.stopPropagation()}
        className="bg-elevated border border-surface rounded-2xl p-6 w-full max-w-sm mx-4"
      >
        <h2 id="confirm-close-title" className="font-display text-lg font-bold text-primary">
          Close position?
        </h2>
        <p className="text-xs text-secondary mt-1">
          {position.name} &middot; {position.type.toUpperCase()} {leverage}&times;
        </p>

        <dl className="mt-5 space-y-1.5 text-xs">
          <div className="flex justify-between">
            <dt className="text-tertiary">Position</dt>
            <dd className="text-primary font-mono tabular-nums">
              ${position.size.toFixed(2)} at {position.entryIndex} VI
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-tertiary">Closes at</dt>
            <dd className="text-atnx-yellow light:text-atnx-yellow-light font-mono tabular-nums">
              {position.currentIndex} VI
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-tertiary">PnL</dt>
            <dd className={`font-mono font-bold tabular-nums ${tone}`}>
              {isProfit ? "+" : "-"}${Math.abs(pnlUsd).toFixed(2)} ({isProfit ? "+" : ""}
              {pnlPercent.toFixed(1)}%)
            </dd>
          </div>
        </dl>

        <div className="mt-6 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            autoFocus
            className="py-2.5 rounded-xl border border-surface text-sm text-primary hover:bg-surface cursor-pointer transition-colors disabled:opacity-50"
          >
            No, keep it
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="py-2.5 rounded-xl bg-atnx-magenta text-white text-sm font-bold hover:brightness-110 cursor-pointer transition disabled:opacity-50"
          >
            {busy ? "Closing…" : "Yes, close"}
          </button>
        </div>
      </div>
    </div>
  );
}
