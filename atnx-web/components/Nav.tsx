"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { UserMenu } from "@/components/UserMenu";

// false during SSR / hydration, true once on the client. Avoids the
// set-state-in-effect pattern for the mount guard.
const noop = () => () => {};
function useMounted() {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

const LINKS = [
  {
    href: "/app",
    label: "Markets",
    match: (p: string) => p === "/app" || p.startsWith("/app/markets"),
  },
  {
    href: "/app/submit",
    label: "Submit",
    match: (p: string) => p === "/app/submit",
  },
  {
    href: "/app/portfolio",
    label: "Portfolio",
    match: (p: string) => p === "/app/portfolio",
  },
];

export function Nav() {
  const pathname = usePathname();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const mounted = useMounted();

  // Logo variant matches the theme so it reads well on both backgrounds.
  // Default to the dark-mode asset during SSR; swap after hydrate.
  const activeTheme = mounted ? (resolvedTheme ?? theme) : "dark";
  const logoSrc =
    activeTheme === "light" ? "/logo_light.png" : "/logo_dark.png";

  return (
    <header className="sticky top-0 z-40 -mx-4 px-4 mb-6 sm:mb-8 nav-blur border-b border-surface">
      <div className="h-14 sm:h-16 flex items-center justify-between gap-3">
        <Link href="/" className="group shrink-0 flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={logoSrc}
            alt="ATNX logo"
            width={32}
            height={32}
            className="w-8 h-8 rounded-md shrink-0 object-contain"
          />
          <div className="text-lg font-bold text-primary tracking-[0.2em] leading-none group-hover:text-atnx-cyan transition-colors">
            ATNX
          </div>
        </Link>

        <nav
          aria-label="App"
          className="inline-flex items-center gap-0.5 p-1 rounded-full bg-surface border border-surface text-xs"
        >
          {LINKS.map((l) => {
            const active = l.match(pathname);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`px-3.5 py-1.5 rounded-full font-bold transition-colors ${
                  active
                    ? "bg-atnx-magenta text-white shadow-[0_0_16px_rgba(255,0,229,0.25)]"
                    : "text-secondary hover:text-primary"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          <UserMenu />
          {mounted && (
            <button
              type="button"
              onClick={() =>
                setTheme(activeTheme === "dark" ? "light" : "dark")
              }
              className="h-8 w-8 inline-flex items-center justify-center rounded-full border border-surface bg-surface hover:border-atnx-cyan/50 cursor-pointer transition-colors text-sm"
              title={`Switch to ${activeTheme === "dark" ? "light" : "dark"} mode`}
              aria-label="Toggle theme"
            >
              {activeTheme === "dark" ? "☀️" : "🌙"}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
