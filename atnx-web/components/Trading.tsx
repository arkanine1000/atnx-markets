"use client";

import { useState, useEffect } from "react";
import {
  LineChart,
  Line,
  ResponsiveContainer,
  YAxis,
  ReferenceLine,
  ReferenceDot,
} from "recharts";
import { useDemoContext } from "@/context/DemoContext";
import { useFakeTicker } from "@/hooks/useFakeTicker";

interface TrendSparklineProps {
  dataPoints: { date: string; value: number }[];
  color?: string;
  height?: number;
  entryIndex?: number;
  positionType?: "long" | "short";
}

export function TrendSparkline({
  dataPoints,
  color = "#00FF66",
  height = 50,
  entryIndex,
  positionType,
}: TrendSparklineProps) {
  const { isLiveMode } = useDemoContext();
  const liveData = useFakeTicker(dataPoints, isLiveMode);
  const displayData = isLiveMode ? liveData : dataPoints;

  if (!displayData || displayData.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center text-atnx-text-muted text-xs"
      >
        No trend data
      </div>
    );
  }

  // Find the closest data point to the entry index for the ReferenceDot
  let entryPointIdx: number | undefined;
  if (entryIndex !== undefined) {
    let minDist = Infinity;
    displayData.forEach((pt, i) => {
      const dist = Math.abs(pt.value - entryIndex / 10); // score is 0-1000, chart is 0-100
      if (dist < minDist) {
        minDist = dist;
        entryPointIdx = i;
      }
    });
  }

  const entryColor = positionType === "short" ? "#FF0040" : "#00FF66";
  const entryY = entryIndex !== undefined ? entryIndex / 10 : undefined; // Normalize to 0-100

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={displayData}>
          <YAxis domain={[0, 100]} hide />
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          {entryY !== undefined && (
            <ReferenceLine
              y={entryY}
              stroke={entryColor}
              strokeDasharray="3 3"
              strokeOpacity={0.5}
            />
          )}
          {entryPointIdx !== undefined && entryY !== undefined && (
            <ReferenceDot
              x={entryPointIdx}
              y={displayData[entryPointIdx]?.value ?? entryY}
              r={4}
              fill={entryColor}
              stroke="none"
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// Score color helper
export function getScoreColor(score: number): string {
  if (score >= 800) return "#FF0040";
  if (score >= 600) return "#FF6600";
  if (score >= 400) return "#FFD700";
  if (score >= 200) return "#00FF66";
  return "#888888";
}

// Trend indicator helper
export function getTrendIndicator(trend?: string): {
  icon: string;
  label: string;
} {
  switch (trend) {
    case "spiking":
      return { icon: "\u25B2", label: "SPIKING" };
    case "rising":
      return { icon: "\u2197", label: "RISING" };
    case "stable":
      return { icon: "\u2192", label: "STABLE" };
    case "falling":
      return { icon: "\u2198", label: "FALLING" };
    default:
      return { icon: "\u2605", label: "NEW" };
  }
}

// Trade modal
interface TradeModalProps {
  capture: {
    id: string;
    analysis: { name?: string; category?: string };
    viralityScore: number;
    trends: { trend: string } | null;
  };
  onClose: () => void;
}

export function TradeModal({ capture, onClose }: TradeModalProps) {
  const { openPosition } = useDemoContext();
  const [posType, setPosType] = useState<"long" | "short">("long");
  const [amount, setAmount] = useState("100");

  const amountNum = parseFloat(amount) || 0;
  const fee = amountNum * 0.005;
  const name = capture.analysis.name || "Unknown";
  const score = capture.viralityScore;
  const trendInfo = getTrendIndicator(capture.trends?.trend);
  const scoreColor = getScoreColor(score);

  function handleSubmit() {
    if (amountNum <= 0) return;
    openPosition({
      type: posType,
      name,
      category: capture.analysis.category || "other",
      entryIndex: score,
      currentIndex: score,
      size: amountNum,
      openedAt: new Date().toISOString(),
      captureId: capture.id,
    });
    onClose();
    // Toast is handled by the parent
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
    >
      <div className="bg-atnx-surface border border-atnx-border rounded-xl p-6 w-full max-w-md mx-4 relative">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-atnx-text-muted hover:text-atnx-text text-lg cursor-pointer"
        >
          ✕
        </button>

        {/* Header */}
        <h2 className="text-lg font-bold text-atnx-text mb-1">
          TRADE: {name}
        </h2>
        <div className="flex items-center gap-3 mb-4 text-sm">
          <span className="text-atnx-text-muted">
            Current Virality Index:{" "}
            <span className="font-bold" style={{ color: scoreColor }}>
              {score}
            </span>
          </span>
          <span style={{ color: scoreColor }} className="text-xs font-bold">
            {trendInfo.icon} {trendInfo.label}
          </span>
        </div>

        {/* Position type */}
        <div className="mb-4">
          <label className="text-xs text-atnx-text-muted uppercase tracking-wider block mb-2">
            Position Type
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => setPosType("long")}
              className={`flex-1 py-2.5 rounded font-bold text-sm cursor-pointer transition-colors ${
                posType === "long"
                  ? "bg-green-500/20 text-green-400 border-2 border-green-500"
                  : "bg-atnx-bg text-atnx-text-muted border border-atnx-border hover:border-green-500/50"
              }`}
            >
              LONG
            </button>
            <button
              onClick={() => setPosType("short")}
              className={`flex-1 py-2.5 rounded font-bold text-sm cursor-pointer transition-colors ${
                posType === "short"
                  ? "bg-red-500/20 text-red-400 border-2 border-red-500"
                  : "bg-atnx-bg text-atnx-text-muted border border-atnx-border hover:border-red-500/50"
              }`}
            >
              SHORT
            </button>
          </div>
        </div>

        {/* Amount */}
        <div className="mb-3">
          <label className="text-xs text-atnx-text-muted uppercase tracking-wider block mb-2">
            Amount (USDC)
          </label>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            min="1"
            className="w-full bg-atnx-bg border border-atnx-border rounded px-3 py-2.5 text-atnx-text font-mono text-sm focus:border-atnx-green outline-none"
          />
        </div>

        {/* Quick amounts */}
        <div className="flex gap-2 mb-4">
          {[10, 50, 100, 500].map((val) => (
            <button
              key={val}
              onClick={() => setAmount(String(val))}
              className="flex-1 py-1.5 text-xs bg-atnx-bg border border-atnx-border rounded text-atnx-text-muted hover:border-atnx-green/50 cursor-pointer transition-colors"
            >
              ${val}
            </button>
          ))}
        </div>

        {/* Summary */}
        <div className="border-t border-atnx-border pt-3 mb-4 space-y-1 text-sm">
          <div className="flex justify-between text-atnx-text-muted">
            <span>Entry Index</span>
            <span className="text-atnx-text font-mono">{score}</span>
          </div>
          <div className="flex justify-between text-atnx-text-muted">
            <span>Estimated Fee (0.5%)</span>
            <span className="text-atnx-text font-mono">
              ${fee.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={amountNum <= 0}
          className={`w-full py-3 rounded font-bold text-sm cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            posType === "long"
              ? "bg-green-500 hover:bg-green-600 text-black"
              : "bg-red-500 hover:bg-red-600 text-white"
          }`}
        >
          OPEN {posType.toUpperCase()} POSITION &mdash; ${amountNum.toFixed(2)}
        </button>
      </div>
    </div>
  );
}

// Dashboard toast notification
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

  const borderColor =
    type === "short" || type === "close-loss" ? "#FF0040" : "#00FF66";

  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 animate-slide-in">
      <div
        className="bg-atnx-surface px-5 py-3 rounded-lg shadow-lg flex items-center gap-3"
        style={{ borderWidth: 1, borderColor }}
      >
        <span className="text-lg">
          {type === "close-loss" ? "\u274C" : "\u2705"}
        </span>
        <div>
          <div className="text-sm font-bold text-atnx-text">{message}</div>
          <div className="text-xs text-atnx-text-muted">{detail}</div>
        </div>
      </div>
    </div>
  );
}

// Close position profit/loss modal
interface CloseModalProps {
  position: {
    type: "long" | "short";
    name: string;
    entryIndex: number;
    currentIndex: number;
    size: number;
  };
  onClose: () => void;
}

export function ClosePositionModal({ position, onClose }: CloseModalProps) {
  const indexChange = position.currentIndex - position.entryIndex;
  const changePercent = (indexChange / position.entryIndex) * 100;
  const direction = position.type === "long" ? 1 : -1;
  const pnlPercent = changePercent * direction;
  const pnlAmount = position.size * (pnlPercent / 100);
  const isProfit = pnlAmount >= 0;
  const accentColor = isProfit ? "#00FF66" : "#FF0040";
  const barWidth = Math.min(100, Math.abs(pnlPercent));

  useEffect(() => {
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
    >
      <div
        className="bg-atnx-surface rounded-xl p-8 w-full max-w-sm mx-4 text-center"
        style={{ borderWidth: 1, borderColor: accentColor }}
      >
        <div className="text-3xl mb-3">{isProfit ? "\uD83C\uDF89" : "\uD83D\uDCC9"}</div>
        <h2 className="text-lg font-bold text-atnx-text mb-4">
          Position Closed
        </h2>

        <p className="text-sm text-atnx-text-muted mb-4">
          {position.name} &mdash; {position.type.toUpperCase()}
        </p>

        <div className="space-y-2 text-sm mb-5">
          <div className="flex justify-between text-atnx-text-muted">
            <span>Entry</span>
            <span className="text-atnx-text font-mono">
              {position.entryIndex}
            </span>
          </div>
          <div className="flex justify-between text-atnx-text-muted">
            <span>Exit</span>
            <span className="text-atnx-text font-mono">
              {position.currentIndex}
            </span>
          </div>
          <div className="flex justify-between text-atnx-text-muted">
            <span>Change</span>
            <span className="font-mono font-bold" style={{ color: accentColor }}>
              {pnlPercent >= 0 ? "+" : ""}
              {pnlPercent.toFixed(1)}%
            </span>
          </div>
          <div className="border-t border-atnx-border my-2" />
          <div className="flex justify-between text-atnx-text-muted">
            <span>Size</span>
            <span className="text-atnx-text font-mono">
              ${position.size.toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between font-bold">
            <span style={{ color: accentColor }}>
              {isProfit ? "Profit" : "Loss"}
            </span>
            <span className="font-mono" style={{ color: accentColor }}>
              {pnlAmount >= 0 ? "+" : ""}${pnlAmount.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Progress bar */}
        <div className="w-full bg-atnx-bg rounded-full h-2 mb-5">
          <div
            className="h-2 rounded-full transition-all duration-500"
            style={{
              width: `${barWidth}%`,
              backgroundColor: accentColor,
            }}
          />
        </div>

        <button
          onClick={onClose}
          className="text-sm text-atnx-green hover:text-atnx-green-dark cursor-pointer"
        >
          Back to Portfolio
        </button>
      </div>
    </div>
  );
}
