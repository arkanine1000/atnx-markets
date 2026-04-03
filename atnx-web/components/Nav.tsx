"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDemoContext } from "@/context/DemoContext";

export function Nav({ captureCount }: { captureCount: number }) {
  const pathname = usePathname();
  const { isLiveMode, setLiveMode } = useDemoContext();

  return (
    <header className="flex items-center justify-between mb-6 flex-wrap gap-4">
      <div>
        <h1 className="text-2xl font-bold text-atnx-green tracking-widest">
          ATNX
        </h1>
        <p className="text-xs text-atnx-text-muted tracking-wide">
          Attention Exchange
        </p>
      </div>

      <div className="flex items-center gap-3">
        <nav className="flex gap-1 text-xs">
          <Link
            href="/"
            className={`px-3 py-1.5 rounded border transition-colors ${
              pathname === "/"
                ? "bg-atnx-green text-atnx-bg border-atnx-green font-bold"
                : "bg-atnx-surface text-atnx-text-muted border-atnx-border hover:border-atnx-green/50"
            }`}
          >
            Dashboard
          </Link>
          <Link
            href="/portfolio"
            className={`px-3 py-1.5 rounded border transition-colors ${
              pathname === "/portfolio"
                ? "bg-atnx-green text-atnx-bg border-atnx-green font-bold"
                : "bg-atnx-surface text-atnx-text-muted border-atnx-border hover:border-atnx-green/50"
            }`}
          >
            Portfolio
          </Link>
        </nav>

        <button
          onClick={() => setLiveMode(!isLiveMode)}
          className={`text-xs px-3 py-1.5 rounded border cursor-pointer transition-colors ${
            isLiveMode
              ? "bg-green-500/20 text-green-400 border-green-500 animate-pulse"
              : "bg-atnx-surface text-atnx-text-muted border-atnx-border hover:border-green-500/50"
          }`}
        >
          {isLiveMode ? "\u25CF Live" : "\u25B6 Live"}
        </button>

        <div className="text-sm text-atnx-text-muted bg-atnx-surface px-3 py-1.5 rounded border border-atnx-border">
          {captureCount} Capture{captureCount !== 1 ? "s" : ""}
        </div>
      </div>
    </header>
  );
}
