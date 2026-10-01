"use client";

import { useEffect, useState } from "react";

// Share a market outward. Phones get the native share sheet; elsewhere the
// link goes to the clipboard. Either way the URL is the market page, which
// is how a capture travels to the next person.
export function ShareButton({
  title,
  text,
  path,
  className = "",
  compact = false,
}: {
  title: string;
  text?: string;
  path: string;
  className?: string;
  // Icon only below sm, where the label would push the row wide.
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  async function share() {
    const url = new URL(path, window.location.origin).toString();
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title, text, url });
        return;
      } catch (err) {
        // The user closed the sheet: nothing to do. Anything else falls
        // through to the clipboard.
        if ((err as Error).name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      window.prompt("Copy this link", url);
    }
  }

  return (
    <button
      type="button"
      onClick={share}
      aria-label={copied ? "Link copied" : "Share this market"}
      title={copied ? "Link copied" : "Share"}
      className={`inline-flex items-center justify-center gap-1.5 h-8 ${compact && !copied ? "w-8 px-0 sm:w-auto sm:px-3" : "px-3"} rounded-full border border-surface bg-surface text-xs font-bold text-secondary btn-quiet cursor-pointer transition-colors ${className}`}
    >
      <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden="true">
        <path
          d="M12 3v12M7 8l5-5 5 5M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className={compact && !copied ? "hidden sm:inline" : undefined}>
        {copied ? "Copied" : "Share"}
      </span>
    </button>
  );
}
