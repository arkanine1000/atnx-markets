import Link from "next/link";
import { getCaptures, type Capture } from "@/lib/store";

// Live proof on the landing page: the five markets with the highest VI right
// now, from the same feed the dashboard uses. Rendered on the server and
// revalidated with the page, so it costs nothing per visitor.

function topMarkets(captures: Capture[], limit: number) {
  const byMarket = new Map<string, Capture>();
  for (const c of captures) {
    if (c.marketId && !byMarket.has(c.marketId)) byMarket.set(c.marketId, c);
  }
  return [...byMarket.values()]
    .sort((a, b) => b.viralityScore - a.viralityScore)
    .slice(0, limit);
}

// Never let a slow database hold the landing page hostage.
const FETCH_TIMEOUT_MS = 2500;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export async function TopMarketsStrip() {
  let markets: Capture[] = [];
  try {
    markets = topMarkets(await withTimeout(getCaptures(60), FETCH_TIMEOUT_MS), 5);
  } catch (err) {
    // No database configured (local preview) or a transient failure: the
    // section simply doesn't render rather than breaking the page.
    console.warn("[landing] top markets unavailable:", (err as Error).message);
    return null;
  }
  if (markets.length === 0) return null;

  return (
    <section className="w-full max-w-3xl mx-auto px-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-tertiary flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block w-2 h-2 rounded-full bg-atnx-magenta animate-[live-pulse_1.6s_ease-in-out_infinite]"
          />
          Live now
        </h2>
        <span className="text-xs text-tertiary">VI Score</span>
      </div>

      <ol className="bg-surface border border-atnx-yellow/30 rounded-xl overflow-hidden shadow-[0_0_0_1px_rgba(255,229,0,0.06),0_12px_40px_rgba(255,229,0,0.06)]">
        {markets.map((m, i) => (
          <li key={m.marketId} className="border-t border-surface first:border-t-0">
            <Link
              href={`/app/markets/${m.marketId}`}
              className="relative flex items-center gap-3 sm:gap-4 px-4 py-3 transition-colors hover:bg-atnx-yellow/5"
            >
              <span
                aria-hidden="true"
                className="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-r bg-atnx-yellow"
                style={{ opacity: 1 - (i / 4) * 0.75 }}
              />
              <span className="w-4 text-right text-sm font-bold text-atnx-yellow" style={{ opacity: 0.55 + (1 - (i / 4) * 0.75) * 0.45 }}>
                {i + 1}
              </span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={m.screenshot}
                alt=""
                loading="lazy"
                className="w-10 h-10 rounded-lg object-cover border border-atnx-yellow/30 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate text-sm font-bold text-primary">
                {m.analysis.name || "Untitled"}
              </span>
              <span className="shrink-0 text-base font-bold font-mono tabular-nums text-atnx-yellow">
                {m.viralityScore}
              </span>
            </Link>
          </li>
        ))}
      </ol>

      <p className="mt-3 text-center text-xs text-tertiary">
        Scores refresh every five minutes.{" "}
        <Link href="/app" className="text-atnx-cyan hover:underline">
          See every market →
        </Link>
      </p>
    </section>
  );
}
