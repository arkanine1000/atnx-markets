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

  // Bottom right, clear of the navbar. Below lg the trade dock is up:
  // on phones it sits on the tab bar (4rem + 3.5rem), from sm on the edge.
  return (
    <div className="fixed right-4 sm:right-6 bottom-[calc(8rem+env(safe-area-inset-bottom))] sm:bottom-[calc(4.5rem+env(safe-area-inset-bottom))] lg:bottom-6 max-w-[calc(100%-2rem)] z-50 animate-slide-in">
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
          <div className="text-sm font-bold text-primary sm:whitespace-nowrap">
            {message}
          </div>
          {detail && <div className="text-xs text-secondary">{detail}</div>}
        </div>
      </div>
    </div>
  );
}
