"use client";

import { useEffect } from "react";

// Toast notification
interface ToastProps {
  message: string;
  detail?: string;
  type: "long" | "short" | "up" | "down" | "close-profit" | "close-loss";
  onDismiss: () => void;
}

export function DemoToast({ message, detail, type, onDismiss }: ToastProps) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 3500);
    return () => clearTimeout(t);
  }, [onDismiss]);

  const bad = type === "short" || type === "down" || type === "close-loss";
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
