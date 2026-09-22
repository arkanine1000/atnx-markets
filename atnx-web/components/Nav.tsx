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

interface NavLink {
  href: string;
  label: string;
  // Leading "+" for the create action, the convention modern apps use.
  plus?: boolean;
  match: (p: string) => boolean;
  icon: (active: boolean) => React.ReactNode;
}

const LINKS: NavLink[] = [
  {
    href: "/app",
    label: "Markets",
    match: (p: string) => p === "/app" || p.startsWith("/app/markets"),
    icon: () => <MarketsIcon />,
  },
  {
    href: "/app/submit",
    label: "Create",
    plus: true,
    match: (p: string) => p === "/app/submit",
    icon: () => <PlusIcon size={22} />,
  },
  {
    href: "/app/portfolio",
    label: "Portfolio",
    match: (p: string) => p === "/app/portfolio",
    icon: () => null,
  },
  {
    href: "/app/leaderboard",
    label: "Leaderboard",
    match: (p: string) => p === "/app/leaderboard",
    icon: () => <TrophyIcon />,
  },
];

// Phones get a bottom bar with the three actions a thumb reaches for:
// Markets, Create (a plain + like YouTube's), Leaderboard. Portfolio lives
// under the account menu there. The desktop pill keeps all four.
const BOTTOM_BAR = ["/app", "/app/submit", "/app/leaderboard"];

function PlusIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d="M8 3v10M3 8h10"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
      />
    </svg>
  );
}

function MarketsIcon() {
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true">
      <path
        d="M4 17l5-6 4 3 7-8"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15 6h5v5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrophyIcon() {
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true">
      <path
        d="M7 4h10v4a5 5 0 0 1-10 0V4zM7 6H4v1.5A3.5 3.5 0 0 0 7.5 11M17 6h3v1.5a3.5 3.5 0 0 1-3.5 5M12 13v4M8.5 20h7M12 17c-1.5 0-3 1-3 3h6c0-2-1.5-3-3-3z"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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
    <>
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
            className="hidden sm:inline-flex items-center gap-0.5 p-1 rounded-full bg-surface border border-surface text-xs"
          >
            {LINKS.filter((l) => !l.plus).map((l) => {
              const active = l.match(pathname);
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  aria-current={active ? "page" : undefined}
                  className={`inline-flex items-center gap-1 px-3.5 py-1.5 rounded-full font-bold whitespace-nowrap transition-colors ${
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
            {/* Create: the one action, as a magenta + beside the account,
                the same button the phone bottom bar carries. */}
            <Link
              href="/app/submit"
              aria-label="Create"
              title="Create a market"
              aria-current={pathname === "/app/submit" ? "page" : undefined}
              className={`hidden sm:inline-flex h-8 w-8 rounded-full items-center justify-center text-white transition-all ${
                pathname === "/app/submit"
                  ? "bg-atnx-magenta-dim ring-2 ring-atnx-cyan/60 shadow-[0_0_20px_rgba(0,212,255,0.3)]"
                  : "bg-atnx-magenta shadow-[0_0_18px_rgba(255,0,229,0.4)] hover:bg-atnx-magenta-dim hover:shadow-[0_0_24px_rgba(255,0,229,0.55)] active:scale-95"
              }`}
            >
              <PlusIcon size={18} />
            </Link>
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

      <nav
        aria-label="App"
        className="sm:hidden fixed inset-x-0 bottom-0 z-40 nav-blur border-t border-surface pb-[env(safe-area-inset-bottom)]"
      >
        <div className="h-16 grid grid-cols-3 items-center max-w-sm mx-auto px-6">
          {LINKS.filter((l) => BOTTOM_BAR.includes(l.href)).map((l) => {
            const active = l.match(pathname);
            if (l.plus) {
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  aria-label={l.label}
                  aria-current={active ? "page" : undefined}
                  className={`justify-self-center h-12 w-12 -mt-1 rounded-full inline-flex items-center justify-center text-white transition-all ${
                    active
                      ? "bg-atnx-magenta-dim ring-2 ring-atnx-cyan/60 shadow-[0_0_24px_rgba(0,212,255,0.3)]"
                      : "bg-atnx-magenta shadow-[0_0_24px_rgba(255,0,229,0.35)] active:scale-95"
                  }`}
                >
                  {l.icon(active)}
                </Link>
              );
            }
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`justify-self-center inline-flex flex-col items-center gap-0.5 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] transition-colors ${
                  active
                    ? "text-atnx-cyan light:text-atnx-cyan-light"
                    : "text-tertiary"
                }`}
              >
                {l.icon(active)}
                {l.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
