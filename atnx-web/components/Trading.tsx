"use client";

import { useEffect } from "react";
import { positionPnl } from "@/lib/pnl";

// Trend indicator: yellow for rising, secondary for stable, magenta for falling.
// `className` is the theme-aware text colour; `color` is the raw dark-mode hex
// for places that need an inline style.
const YELLOW = "text-atnx-yellow light:text-atnx-yellow-light";
const MAGENTA = "text-atnx-magenta light:text-atnx-magenta-light";
export function getTrendIndicator(trend?: string): {
  icon: string;
  label: string;
  color: string;
  className: string;
} {
  switch (trend) {
    case "spiking":
      return {
        icon: "▲",
        label: "SPIKING",
        color: "#FFE500",
        className: YELLOW,
      };
    case "rising":
      return {
        icon: "↗",
        label: "RISING",
        color: "#FFE500",
        className: YELLOW,
      };
    case "stable":
      return {
        icon: "→",
        label: "STABLE",
        color: "#999999",
        className: "text-secondary",
      };
    case "falling":
      return {
        icon: "↘",
        label: "FALLING",
        color: "#FF00E5",
        className: MAGENTA,
      };
    default:
      return { icon: "★", label: "NEW", color: "#FFE500", className: YELLOW };
  }
}

// Toast notification
interface ToastProps {
  message: string;
  detail: string;
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
          <div className="text-sm font-bold text-primary">{message}</div>
          <div className="text-xs text-secondary">{detail}</div>
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
        <h2 className="text-lg font-bold text-primary">
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
