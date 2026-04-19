"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { UserMenu } from "@/components/UserMenu";

export function Nav() {
  const pathname = usePathname();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Logo variant matches the theme so it reads well on both backgrounds.
  // Default to the dark-mode asset during SSR; swap after hydrate.
  const activeTheme = mounted ? resolvedTheme ?? theme : "dark";
  const logoSrc =
    activeTheme === "light" ? "/logo_light.png" : "/logo_dark.png";

  const dashboardActive =
    pathname === "/app" || pathname.startsWith("/app/markets");
  const portfolioActive = pathname === "/app/portfolio";

  return (
    <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-6 gap-3 sm:gap-4">
      <Link href="/" className="group shrink-0 flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logoSrc}
          alt="ATNX logo"
          width={40}
          height={40}
          className="w-10 h-10 rounded-md shrink-0 object-contain"
        />
        <div>
          <h1 className="text-2xl font-bold text-atnx-cyan tracking-widest group-hover:text-atnx-cyan-dim transition-colors leading-none">
            ATNX
          </h1>
          <p className="text-xs text-secondary tracking-wide mt-1">
            Attention Exchange
          </p>
        </div>
      </Link>

      <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
        <nav className="flex gap-1 text-xs">
          <Link
            href="/app"
            className={`px-3 py-1.5 rounded border transition-colors ${
              dashboardActive
                ? "bg-atnx-magenta text-black border-atnx-magenta font-bold"
                : "bg-surface text-secondary border-surface hover:border-atnx-cyan/50"
            }`}
          >
            Dashboard
          </Link>
          <Link
            href="/app/portfolio"
            className={`px-3 py-1.5 rounded border transition-colors ${
              portfolioActive
                ? "bg-atnx-magenta text-black border-atnx-magenta font-bold"
                : "bg-surface text-secondary border-surface hover:border-atnx-cyan/50"
            }`}
          >
            Portfolio
          </Link>
        </nav>

        <UserMenu />

        {/* Theme toggle — far right, after UserMenu */}
        {mounted && (
          <button
            onClick={() => setTheme(activeTheme === "dark" ? "light" : "dark")}
            className="text-sm px-2 py-1.5 rounded border border-surface hover:border-atnx-cyan cursor-pointer transition-colors bg-surface"
            title={`Switch to ${activeTheme === "dark" ? "light" : "dark"} mode`}
          >
            {activeTheme === "dark" ? "\u2600\uFE0F" : "\uD83C\uDF19"}
          </button>
        )}
      </div>
    </header>
  );
}
