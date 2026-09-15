import Link from "next/link";
import { Suspense } from "react";
import { DotMatrixLogo } from "@/components/DotMatrixLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LaunchAppButton } from "@/components/LaunchAppButton";
import { TopMarketsStrip } from "@/components/landing/TopMarketsStrip";
import { EXTENSION_URL } from "@/lib/links";

// Static page, re-rendered at most once a minute so the live markets strip
// stays fresh without a database hit per visitor.
export const revalidate = 60;

const STEPS = [
  {
    n: "01",
    title: "Capture",
    color: "text-atnx-cyan",
    border: "hover:border-atnx-cyan/40",
    body: "Press Ctrl+Shift+X on any page and drag a box around anything: a post, a meme, a product, a headline.",
  },
  {
    n: "02",
    title: "Identify",
    color: "text-atnx-magenta",
    border: "hover:border-atnx-magenta/40",
    body: "AI vision names what you caught, reads the numbers on screen, and files it under the right market.",
  },
  {
    n: "03",
    title: "Trade",
    color: "text-atnx-yellow",
    border: "hover:border-atnx-yellow/40",
    body: "Every market carries a live Virality Index. Go long or short on where attention is heading, with simulated funds.",
  },
];

export default function LandingPage() {
  return (
    <main className="min-h-screen flex flex-col">
      <div className="fixed top-5 right-5 z-50">
        <ThemeToggle />
      </div>

      {/* Hero */}
      <section className="min-h-[88svh] flex flex-col items-center justify-center px-5 pt-16 pb-10 text-center">
        <DotMatrixLogo />

        <h1 className="mt-8 text-2xl md:text-3xl font-sans text-primary tracking-[0.04em]">
          Trade Attention, Not Tokens
        </h1>
        <p className="mt-2 text-sm text-tertiary">
          Capture anything on the internet. AI names it. You trade it.
        </p>

        <div className="mt-9 flex flex-col sm:flex-row items-center gap-3 sm:gap-4">
          <LaunchAppButton />
          {EXTENSION_URL ? (
            <a
              href={EXTENSION_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="px-8 py-3 rounded-lg border border-atnx-cyan text-atnx-cyan font-mono font-bold transition-colors hover:bg-atnx-cyan hover:text-black"
            >
              Get the Chrome extension
            </a>
          ) : (
            <span
              className="px-8 py-3 rounded-lg border border-surface text-tertiary font-mono text-sm"
              title="The Chrome Web Store listing is in review"
            >
              Chrome extension · coming soon
            </span>
          )}
        </div>

        <p className="mt-5 text-xs text-tertiary">
          Free to browse. Sign in to capture and trade. No real money.
        </p>

        <a
          href="#how"
          aria-label="How it works"
          className="mt-14 text-tertiary hover:text-primary transition-colors animate-[live-pulse_2.4s_ease-in-out_infinite]"
        >
          ↓
        </a>
      </section>

      {/* How it works */}
      <section id="how" className="w-full max-w-5xl mx-auto px-5 py-16 scroll-mt-10">
        <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-tertiary text-center mb-8">
          How it works
        </h2>
        <ol className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((s) => (
            <li
              key={s.n}
              className={`bg-surface border border-surface rounded-xl p-6 transition-colors ${s.border}`}
            >
              <div className={`text-xs font-bold tracking-[0.2em] ${s.color}`}>{s.n}</div>
              <h3 className="mt-2 text-lg font-bold text-primary">{s.title}</h3>
              <p className="mt-2 text-sm text-secondary leading-relaxed">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Live markets */}
      <div className="pb-16">
        <Suspense fallback={null}>
          <TopMarketsStrip />
        </Suspense>
      </div>

      <footer className="mt-auto border-t border-surface">
        <div className="max-w-5xl mx-auto px-5 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-tertiary">
          <span>© {new Date().getFullYear()} ATNX · Attention Exchange</span>
          <nav className="flex gap-5">
            <Link href="/app" className="hover:text-primary transition-colors">
              App
            </Link>
            <Link href="/privacy" className="hover:text-primary transition-colors">
              Privacy
            </Link>
            {EXTENSION_URL && (
              <a
                href={EXTENSION_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-primary transition-colors"
              >
                Chrome extension
              </a>
            )}
          </nav>
        </div>
      </footer>
    </main>
  );
}
