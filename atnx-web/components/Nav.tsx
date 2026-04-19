"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useDemoContext } from "@/context/DemoContext";
import { useEffect, useState } from "react";
import { UserMenu } from "@/components/UserMenu";

export function Nav({ captureCount }: { captureCount: number }) {
  const pathname = usePathname();
  const { isLiveMode, setLiveMode } = useDemoContext();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  return (
    <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-6 gap-3 sm:gap-4">
      <Link href="/" className="group shrink-0">
        <h1 className="text-2xl font-bold text-atnx-cyan tracking-widest group-hover:text-atnx-cyan-dim transition-colors">
          ATNX
        </h1>
        <p className="text-xs text-secondary tracking-wide">
          Attention Exchange
        </p>
      </Link>

      <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
        <nav className="flex gap-1 text-xs">
          <Link
            href="/app"
            className={`px-3 py-1.5 rounded border transition-colors ${
              pathname === "/app"
                ? "bg-atnx-magenta text-black border-atnx-magenta font-bold"
                : "bg-surface text-secondary border-surface hover:border-atnx-cyan/50"
            }`}
          >
            Dashboard
          </Link>
          <Link
            href="/app/portfolio"
            className={`px-3 py-1.5 rounded border transition-colors ${
              pathname === "/app/portfolio"
                ? "bg-atnx-magenta text-black border-atnx-magenta font-bold"
                : "bg-surface text-secondary border-surface hover:border-atnx-cyan/50"
            }`}
          >
            Portfolio
          </Link>
        </nav>

        <button
          onClick={() => setLiveMode(!isLiveMode)}
          className={`text-xs px-3 py-1.5 rounded border cursor-pointer transition-colors ${
            isLiveMode
              ? "bg-atnx-magenta/15 text-atnx-magenta border-atnx-magenta animate-live-pulse"
              : "bg-surface text-secondary border-surface hover:border-atnx-magenta/50"
          }`}
        >
          {isLiveMode ? "\u25CF LIVE" : "\u25B6 Live"}
        </button>

        {/* Theme toggle */}
        {mounted && (
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="text-sm px-2 py-1.5 rounded border border-surface hover:border-atnx-cyan cursor-pointer transition-colors bg-surface"
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? "\u2600\uFE0F" : "\uD83C\uDF19"}
          </button>
        )}

        <div className="text-xs text-atnx-magenta bg-surface px-3 py-1.5 rounded border border-atnx-magenta/30 font-bold whitespace-nowrap">
          {captureCount} Capture{captureCount !== 1 ? "s" : ""}
        </div>

        <UserMenu />
      </div>
    </header>
  );
}
