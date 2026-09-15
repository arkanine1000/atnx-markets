"use client";

import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

const noop = () => () => {};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  // false during SSR / hydration, true on the client; avoids setState in an effect.
  const mounted = useSyncExternalStore(noop, () => true, () => false);

  if (!mounted) return null;

  return (
    <button
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      className="text-sm px-2.5 py-2 rounded-lg border border-surface hover:border-atnx-cyan cursor-pointer transition-colors bg-surface"
      title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
    >
      {theme === "dark" ? "\u2600\uFE0F" : "\uD83C\uDF19"}
    </button>
  );
}
