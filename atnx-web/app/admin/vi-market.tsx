"use client";

// One market's VI in plain words: the composite, each source, what was
// not asked, the raw readings behind a disclosure, and the last day or
// week of moves with each one attributed to the sources that changed.
import { useEffect, useState } from "react";
import Link from "next/link";
import { loadViMarketAction } from "./actions";
import type { ViMarketDetail } from "@/lib/vi/diagnostics";
import type { Freshness } from "@/lib/vi/labels";
import { FRESHNESS_TEXT } from "@/lib/vi/labels";
import { ViChart } from "@/components/charts/ViArea";
import { FlagChips, ago, ageText, formatDate, usd } from "./vi-tab";

const FRESH_TONE: Record<Freshness, string> = { fresh: "text-secondary", late: "text-atnx-yellow", stale: "text-atnx-magenta", expiring: "text-atnx-magenta", unknown: "text-tertiary" };
type Window = "24h" | "7d";

export function ViMarketPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const [window_, setWindow] = useState<Window>("24h");
  // What is shown and for which request it was loaded; loading is the
  // request changing under it, so the effect sets no state of its own.
  const [loaded, setLoaded] = useState<{ key: string; detail: ViMarketDetail | null; error: string | null } | null>(null);
  const key = `${id}:${window_}`;
  const loading = loaded?.key !== key;
  const detail = loaded?.detail ?? null;
  const error = loaded?.error ?? null;

  useEffect(() => {
    let ignore = false;
    loadViMarketAction(id, window_).then((r) => {
      if (ignore) return;
      if (r.success) setLoaded({ key, detail: r.data, error: r.data ? null : "Market not found" });
      else setLoaded({ key, detail: null, error: r.error });
    });
    return () => {
      ignore = true;
    };
  }, [id, window_, key]);

  const now = detail ? Date.parse(detail.asOf) : NaN;
  const e = detail?.explanation;
  const range = (from: string, to: string) => `${new Date(from).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} → ${new Date(to).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;

  return (
    <section className="rounded-lg border border-surface bg-surface p-4 space-y-5" aria-busy={loading}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {detail ? (
            <h3 className="text-base font-bold text-primary">
              {detail.market.name}
              <span className="ml-2 font-mono text-atnx-yellow">{Math.round(detail.market.currentVi ?? 0)}</span>
              <span className="ml-2 text-xs font-normal text-secondary">{e && e.composite.score !== null ? `${e.composite.sentences[0]?.startsWith("Level") ? "" : ""}` : ""}{detail.market.viState === "scoring" ? "scoring" : ""}</span>
              <Link href={`/app/markets/${detail.market.id}`} className="ml-2 text-xs font-normal text-tertiary link-quiet">market page ↗</Link>
            </h3>
          ) : (
            <h3 className="text-base font-bold text-secondary">{loading ? "Reading the breakdown…" : "Market"}</h3>
          )}
          {e && <div className="mt-1"><FlagChips flags={e.flags} /></div>}
        </div>
        <div className="flex items-center gap-2 text-xs">
          {detail && <span className="text-tertiary">as of {formatDate(detail.asOf)}</span>}
          <button type="button" onClick={onClose} className="h-7 px-3 rounded-lg border border-surface text-secondary btn-quiet cursor-pointer">Close</button>
        </div>
      </div>
      {error && <p className="text-xs text-atnx-magenta">{error}</p>}

      {e && (
        <>
          <ul className="text-sm text-primary space-y-1">
            {e.composite.sentences.map((s) => <li key={s}>{s}</li>)}
          </ul>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-tertiary font-mono uppercase tracking-wider">
                  <th className="py-2 px-2 text-left">Source</th>
                  <th className="py-2 px-2 text-left">Reading</th>
                  <th className="py-2 px-2 text-right">Own level</th>
                  <th className="py-2 px-2 text-right">Momentum</th>
                  <th className="py-2 px-2 text-right">Share</th>
                  <th className="py-2 px-2 text-right">Read</th>
                  <th className="py-2 px-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {e.sources.map((s) => (
                  <tr key={s.source} className={`border-t border-surface ${s.status === "unknown" ? "opacity-60" : ""}`}>
                    <td className="py-2 px-2 text-primary whitespace-nowrap">{s.label}</td>
                    <td className="py-2 px-2 text-secondary">{s.readingText}</td>
                    <td className="py-2 px-2 text-right font-mono text-secondary">{s.level ?? "—"}</td>
                    <td className="py-2 px-2 text-right font-mono text-secondary">{s.momentumText}</td>
                    <td className="py-2 px-2 text-right font-mono text-secondary">{s.share === null ? "—" : `${Math.round(s.share * 100)}%`}</td>
                    <td className={`py-2 px-2 text-right whitespace-nowrap ${FRESH_TONE[s.freshness]}`}>{ageText(s.ageMs)} · {FRESHNESS_TEXT[s.freshness]}</td>
                    <td className="py-2 px-2 text-right font-mono text-tertiary whitespace-nowrap" title={s.costFacts}>{s.costUsd === null ? "—" : s.costUsd === 0 ? "free" : `${usd(s.costUsd)} / ${usd(s.perDayUsd ?? 0)} a day`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <h4 className="text-xs font-mono uppercase tracking-wider text-tertiary mb-1">In plain words</h4>
            <ul className="text-xs text-secondary space-y-1">
              {e.sources.map((s) => <li key={s.source}>{s.sentence}</li>)}
            </ul>
            {e.notAsked.length > 0 && (
              <p className="text-xs text-tertiary mt-2">Not asked: {e.notAsked.map((n) => `${n.label} (${n.why})`).join("; ")}.</p>
            )}
          </div>

          <details className="text-xs">
            <summary className="cursor-pointer text-tertiary link-quiet">Raw readings</summary>
            <div className="mt-2 grid gap-3 md:grid-cols-2">
              {e.sources.map((s) => (
                <div key={s.source} className="rounded-md border border-surface p-2">
                  <div className="text-primary mb-1">{s.label} <span className="text-tertiary">· {s.unit}</span></div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                    {s.meta.map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-tertiary font-mono">{k}</dt>
                        <dd className="text-secondary break-all">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          </details>
        </>
      )}

      {detail && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-mono uppercase tracking-wider text-tertiary">Movement</h4>
            <div className="flex gap-1 text-xs rounded-lg border border-surface p-0.5">
              {(["24h", "7d"] as Window[]).map((w) => (
                <button key={w} type="button" onClick={() => setWindow(w)} className={`px-2.5 py-1 rounded-md cursor-pointer ${window_ === w ? "bg-elevated text-primary font-bold" : "text-secondary link-quiet"}`}>{w}</button>
              ))}
            </div>
          </div>
          {detail.series.length >= 2 ? (
            <ViChart dataPoints={detail.series} range={window_ === "24h" ? "1D" : "1W"} height={200} scoring={detail.market.viState === "scoring"} />
          ) : (
            <p className="text-xs text-tertiary">No score history in this window.</p>
          )}
          <ul className="text-sm text-primary space-y-1 mt-3">
            {detail.moves.headline.map((s) => <li key={s}>{s}</li>)}
          </ul>
          {!detail.historyAvailable && <p className="text-xs text-atnx-magenta mt-2">The hourly snapshot table is missing (apply supabase/020).</p>}
          {detail.historyAvailable && detail.snapshots === 0 && (
            <p className="text-xs text-tertiary mt-2">No hourly snapshots yet{detail.market.createdAt ? ` (created ${ago(detail.market.createdAt, now)} ago)` : ""}; the first slow refresh writes one at :07.</p>
          )}
          {detail.moves.note && <p className="text-xs text-tertiary mt-2">{detail.moves.note}</p>}
          {detail.moves.moves.length > 0 && (
            <ul className="text-xs text-secondary space-y-2 mt-3">
              {detail.moves.moves.map((m) => (
                <li key={`${m.from}-${m.to}`}>
                  <span className="font-mono text-tertiary mr-2">{range(m.from, m.to)}</span>
                  {m.sentence}
                </li>
              ))}
            </ul>
          )}
          {detail.moves.gaps.length > 0 && (
            <p className="text-xs text-tertiary mt-2">
              Gaps: {detail.moves.gaps.map((g) => `${range(g.from, g.to)} (${g.hours} h, no snapshot: the slow refresh skipped this market or the cron missed)`).join("; ")}.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
