"use client";

import { useState, useEffect, useRef } from "react";
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
  color = "#00D4FF",
  height = 50,
  entryIndex,
  positionType,
}: TrendSparklineProps) {
  const { isLiveMode } = useDemoContext();
  const liveData = useFakeTicker(dataPoints, isLiveMode);
  const displayData = isLiveMode ? liveData : dataPoints;

  // Skip rendering the ResponsiveContainer until the wrapper has a real width.
  // Parents with max-w-* only or `display: none` at breakpoints otherwise make
  // recharts log a width(-1)/height(-1) warning on first measurement.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [hasSize, setHasSize] = useState(false);
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.contentRect.width > 0 && e.contentRect.height > 0) {
          setHasSize(true);
          return;
        }
      }
      setHasSize(false);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!displayData || displayData.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center text-secondary text-xs"
      >
        No trend data
      </div>
    );
  }

  let entryPointIdx: number | undefined;
  if (entryIndex !== undefined) {
    let minDist = Infinity;
    displayData.forEach((pt, i) => {
      const dist = Math.abs(pt.value - entryIndex / 10);
      if (dist < minDist) {
        minDist = dist;
        entryPointIdx = i;
      }
    });
  }

  // Entry markers use magenta
  const entryColor = "#FF00E5";
  const entryY = entryIndex !== undefined ? entryIndex / 10 : undefined;

  return (
    <div ref={wrapperRef} style={{ height }} className="w-full">
      {hasSize && (
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
      )}
    </div>
  );
}

// Score color — always yellow, just vary intensity
export function getScoreColor(_score: number): string {
  return "#FFE500";
}

// Trend indicator — yellow for rising, secondary for stable, magenta for falling
export function getTrendIndicator(trend?: string): {
  icon: string;
  label: string;
  color: string;
} {
  switch (trend) {
    case "spiking":
      return { icon: "\u25B2", label: "SPIKING", color: "#FFE500" };
    case "rising":
      return { icon: "\u2197", label: "RISING", color: "#FFE500" };
    case "stable":
      return { icon: "\u2192", label: "STABLE", color: "#999999" };
    case "falling":
      return { icon: "\u2198", label: "FALLING", color: "#FF00E5" };
    default:
      return { icon: "\u2605", label: "NEW", color: "#FFE500" };
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
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
    >
      <div className="bg-elevated border border-surface rounded-xl p-6 w-full max-w-md mx-4 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-secondary hover:text-primary text-lg cursor-pointer"
        >
          ✕
        </button>

        <h2 className="text-lg font-bold text-atnx-cyan mb-1">
          TRADE: {name}
        </h2>
        <div className="flex items-center gap-3 mb-4 text-sm">
          <span className="text-secondary">
            Current Virality Index:{" "}
            <span className="font-bold text-atnx-yellow font-mono">
              {score}
            </span>
          </span>
          <span className="text-xs font-bold" style={{ color: trendInfo.color }}>
            {trendInfo.icon} {trendInfo.label}
          </span>
        </div>

        {/* Position type — cyan for long, magenta for short */}
        <div className="mb-4">
          <label className="text-xs text-secondary uppercase tracking-wider block mb-2">
            Position Type
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => setPosType("long")}
              className={`flex-1 py-2.5 rounded font-bold text-sm cursor-pointer transition-colors ${
                posType === "long"
                  ? "bg-atnx-cyan/15 text-atnx-cyan border-2 border-atnx-cyan"
                  : "bg-surface text-secondary border border-surface hover:border-atnx-cyan/50"
              }`}
            >
              LONG
            </button>
            <button
              onClick={() => setPosType("short")}
              className={`flex-1 py-2.5 rounded font-bold text-sm cursor-pointer transition-colors ${
                posType === "short"
                  ? "bg-atnx-magenta/15 text-atnx-magenta border-2 border-atnx-magenta"
                  : "bg-surface text-secondary border border-surface hover:border-atnx-magenta/50"
              }`}
            >
              SHORT
            </button>
          </div>
        </div>

        {/* Amount */}
        <div className="mb-3">
          <label className="text-xs text-secondary uppercase tracking-wider block mb-2">
            Amount (USDC)
          </label>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            min="1"
            className="w-full bg-surface border border-surface rounded px-3 py-2.5 text-primary font-mono text-sm focus:border-atnx-cyan outline-none"
          />
        </div>

        {/* Quick amounts */}
        <div className="flex gap-2 mb-4">
          {[10, 50, 100, 500].map((val) => (
            <button
              key={val}
              onClick={() => setAmount(String(val))}
              className="flex-1 py-1.5 text-xs bg-surface border border-surface rounded text-secondary hover:border-atnx-cyan/50 cursor-pointer transition-colors"
            >
              ${val}
            </button>
          ))}
        </div>

        {/* Summary */}
        <div className="border-t border-surface pt-3 mb-4 space-y-1 text-sm">
          <div className="flex justify-between text-secondary">
            <span>Entry Index</span>
            <span className="text-atnx-yellow font-mono">{score}</span>
          </div>
          <div className="flex justify-between text-secondary">
            <span>Estimated Fee (0.5%)</span>
            <span className="text-atnx-yellow font-mono">
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
              ? "bg-atnx-cyan hover:bg-atnx-cyan-dim text-black"
              : "bg-atnx-magenta hover:bg-atnx-magenta-dim text-black"
          }`}
        >
          OPEN {posType.toUpperCase()} POSITION &mdash; ${amountNum.toFixed(2)}
        </button>
      </div>
    </div>
  );
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

  const borderColor =
    type === "short" || type === "close-loss" ? "#FF00E5" : "#00D4FF";

  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 animate-slide-in">
      <div
        className="bg-elevated px-5 py-3 rounded-lg shadow-lg flex items-center gap-3"
        style={{ borderWidth: 1, borderColor }}
      >
        <span className="text-lg">
          {type === "close-loss" ? "\u274C" : "\u2705"}
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
  // Profit: cyan accent, Loss: magenta accent
  const accentColor = isProfit ? "#00D4FF" : "#FF00E5";
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
        className="bg-elevated rounded-xl p-8 w-full max-w-sm mx-4 text-center"
        style={{ borderWidth: 1, borderColor: accentColor }}
      >
        <div className="text-3xl mb-3">{isProfit ? "\uD83C\uDF89" : "\uD83D\uDCC9"}</div>
        <h2 className="text-lg font-bold text-primary mb-4">
          Position Closed
        </h2>

        <p className="text-sm text-secondary mb-4">
          {position.name} &mdash; {position.type.toUpperCase()}
        </p>

        <div className="space-y-2 text-sm mb-5">
          <div className="flex justify-between text-secondary">
            <span>Entry</span>
            <span className="text-atnx-cyan font-mono">
              {position.entryIndex}
            </span>
          </div>
          <div className="flex justify-between text-secondary">
            <span>Exit</span>
            <span className="text-atnx-cyan font-mono">
              {position.currentIndex}
            </span>
          </div>
          <div className="flex justify-between text-secondary">
            <span>Change</span>
            <span className="font-mono font-bold" style={{ color: accentColor }}>
              {pnlPercent >= 0 ? "+" : ""}
              {pnlPercent.toFixed(1)}%
            </span>
          </div>
          <div className="border-t border-surface my-2" />
          <div className="flex justify-between text-secondary">
            <span>Size</span>
            <span className="text-primary font-mono">
              ${position.size.toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between font-bold">
            <span style={{ color: accentColor }}>
              {isProfit ? "Profit" : "Loss"}
            </span>
            <span className="text-atnx-yellow font-mono">
              {pnlAmount >= 0 ? "+" : ""}${pnlAmount.toFixed(2)}
            </span>
          </div>
        </div>

        <div className="w-full bg-surface rounded-full h-2 mb-5">
          <div
            className="h-2 rounded-full transition-all duration-500"
            style={{ width: `${barWidth}%`, backgroundColor: accentColor }}
          />
        </div>

        <button
          onClick={onClose}
          className="text-sm text-atnx-cyan hover:text-atnx-cyan-dim cursor-pointer"
        >
          Back to Portfolio
        </button>
      </div>
    </div>
  );
}
