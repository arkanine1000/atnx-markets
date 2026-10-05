"use client";

// The admin's VI tab: every market with its diagnostics, one market's
// breakdown and moves (vi-market.tsx), and the sources' health and
// cost. Everything is explained on the server (lib/vi/explain.ts) and
// loaded through the read-only actions when the tab is used; this file
// formats times and lays the sentences out.
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { loadViHealthAction, loadViOverviewAction } from "./actions";
import type { ViHealth, ViOverview } from "@/lib/vi/diagnostics";
import type { SourceCoverage, ViMarketRow } from "@/lib/vi/explain";
import { FLAG_TEXT, type ViFlag } from "@/lib/vi/labels";
import { useSort, SortTh } from "./table";
import { ViMarketPanel } from "./vi-market";

export const formatDate = (ts: string) => new Date(ts).toLocaleString();
export function ago(ts: string | null, now: number): string {
  if (!ts) return "—";
  const ms = now - Date.parse(ts);
  if (!Number.isFinite(ms)) return "—";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 48 * 3_600_000) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.round(ms / 86_400_000)} d`;
}
export const ageText = (ms: number | null) => (ms === null || !Number.isFinite(ms) ? "—" : ms < 60_000 ? "<1 min" : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : ms < 48 * 3_600_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} d`);
export const usd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
const FLAG_TONE: Record<ViFlag, string> = {
  dominant: "text-atnx-yellow border-atnx-yellow/40",
  generic: "text-atnx-yellow border-atnx-yellow/40",
  catching_up: "text-atnx-yellow border-atnx-yellow/40",
  zero: "text-atnx-magenta border-atnx-magenta/40",
  stale: "text-atnx-magenta border-atnx-magenta/40",
  scoring: "text-tertiary border-surface",
  no_momentum: "text-tertiary border-surface",
};

export function FlagChips({ flags }: { flags: ViFlag[] }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {flags.map((f) => (
        <span key={f} title={FLAG_TEXT[f].long} className={`text-[10px] uppercase tracking-wider border rounded px-1 ${FLAG_TONE[f]}`}>
          {FLAG_TEXT[f].short}
        </span>
      ))}
    </span>
  );
}

type View = "markets" | "health";
const SUB_TAB = "px-3 py-1.5 rounded-md cursor-pointer transition-colors";

export function ViTab() {
  const [view, setView] = useState<View>("markets");
  const [overview, setOverview] = useState<ViOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<ViHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const started = useRef(false);

  async function loadOverview() {
    setLoading(true);
    setError(null);
    const r = await loadViOverviewAction();
    if (r.success) setOverview(r.data);
    else setError(r.error);
    setLoading(false);
  }
  async function loadHealth() {
    setHealthLoading(true);
    setHealthError(null);
    const r = await loadViHealthAction();
    if (r.success) setHealth(r.data);
    else setHealthError(r.error);
    setHealthLoading(false);
  }
  useEffect(() => {
    // StrictMode runs effects twice in development; one load is enough.
    if (started.current) return;
    started.current = true;
    const m = window.location.hash.match(/#vi=([0-9a-f-]{36})/i);
    if (m) setSelectedId(m[1]);
    void loadOverview();
  }, []);
  useEffect(() => {
    if (view === "health" && !health && !healthLoading) void loadHealth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  function open(id: string | null) {
    setSelectedId(id);
    const url = new URL(window.location.href);
    url.hash = id ? `vi=${id}` : "";
    window.history.replaceState(null, "", url.toString());
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div className="flex gap-1 rounded-lg border border-surface p-0.5">
          {(["markets", "health"] as View[]).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)} className={`${SUB_TAB} ${view === v ? "bg-elevated text-primary font-bold" : "text-secondary link-quiet"}`}>
              {v === "markets" ? "Markets" : "Sources & cost"}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => { void loadOverview(); if (health) void loadHealth(); }} disabled={loading} className="h-7 px-3 rounded-lg border border-surface text-secondary btn-quiet cursor-pointer disabled:opacity-50">
          {loading ? "Loading…" : "Refresh"}
        </button>
        {overview && <span className="text-tertiary">as of {formatDate(overview.asOf)} · {overview.rows.length} markets, {overview.live} live</span>}
        {error && <span className="text-atnx-magenta">{error}</span>}
      </div>

      {view === "markets" && (
        <>
          {selectedId && <ViMarketPanel id={selectedId} onClose={() => open(null)} />}
          {overview ? <ViMarketList rows={overview.rows} now={Date.parse(overview.asOf)} selectedId={selectedId} onOpen={open} /> : !error && <p className="text-xs text-tertiary py-8 text-center">Reading the breakdown of every market…</p>}
        </>
      )}
      {view === "health" && <ViHealthView health={health} coverage={overview?.coverage ?? []} loading={healthLoading} error={healthError} />}
    </div>
  );
}

type Col = "name" | "vi" | "d24" | "tier" | "top" | "answering" | "stale" | "flags" | "updated";

function ViMarketList({ rows, now, selectedId, onOpen }: { rows: ViMarketRow[]; now: number; selectedId: string | null; onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [flag, setFlag] = useState<ViFlag | "">("");
  const filtered = useMemo(() => rows.filter((r) => (!q || r.name.toLowerCase().includes(q.toLowerCase())) && (!flag || r.flags.includes(flag))), [rows, q, flag]);
  const { sorted, sort, toggle } = useSort<ViMarketRow, Col>(
    filtered,
    {
      name: (r) => r.name,
      vi: (r) => r.vi,
      d24: (r) => r.d24,
      tier: (r) => r.vi,
      top: (r) => r.topShare,
      answering: (r) => r.answering,
      stale: (r) => r.staleSources.length,
      flags: (r) => r.flags.length,
      updated: (r) => (r.updatedAt ? Date.parse(r.updatedAt) : null),
    },
    { key: "vi", dir: "desc" }
  );
  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-2 text-xs">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a market" className="h-7 px-2 rounded-md border border-surface bg-transparent text-primary outline-none focus:border-atnx-cyan/60" />
        <select value={flag} onChange={(e) => setFlag(e.target.value as ViFlag | "")} className="h-7 px-2 rounded-md border border-surface bg-transparent text-secondary">
          <option value="">Any flag</option>
          {(Object.keys(FLAG_TEXT) as ViFlag[]).map((f) => (
            <option key={f} value={f}>{FLAG_TEXT[f].short}</option>
          ))}
        </select>
        <span className="text-tertiary self-center">{filtered.length} of {rows.length}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-tertiary font-mono uppercase tracking-wider">
              <SortTh column="name" sort={sort} onSort={toggle}>Market</SortTh>
              <SortTh column="vi" sort={sort} onSort={toggle} align="right">VI</SortTh>
              <SortTh column="d24" sort={sort} onSort={toggle} align="right">24h</SortTh>
              <SortTh column="tier" sort={sort} onSort={toggle}>Tier</SortTh>
              <SortTh column="top" sort={sort} onSort={toggle}>Top source</SortTh>
              <SortTh column="answering" sort={sort} onSort={toggle} align="right">Answering</SortTh>
              <SortTh column="stale" sort={sort} onSort={toggle} align="right">Stale</SortTh>
              <SortTh column="flags" sort={sort} onSort={toggle}>Flags</SortTh>
              <SortTh column="updated" sort={sort} onSort={toggle} align="right">Updated</SortTh>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan={9} className="py-8 text-center text-tertiary">No market matches.</td></tr>
            )}
            {sorted.map((r) => (
              <tr key={r.id} onClick={() => onOpen(r.id)} className={`border-t border-surface cursor-pointer hover-lift ${selectedId === r.id ? "bg-elevated" : ""}`}>
                <td className="py-2 px-2">
                  <span className="text-primary">{r.name}</span>
                  <Link href={`/app/markets/${r.id}`} onClick={(e) => e.stopPropagation()} className="ml-2 text-tertiary link-quiet" title="Open the market page">↗</Link>
                  {r.category && <span className="ml-2 text-tertiary">{r.category}</span>}
                </td>
                <td className="py-2 px-2 text-right font-mono text-atnx-yellow">{r.vi}</td>
                <td className={`py-2 px-2 text-right font-mono ${r.d24 === null ? "text-tertiary" : r.d24 >= 0 ? "text-atnx-cyan" : "text-atnx-magenta"}`}>{r.d24 === null ? "—" : `${r.d24 >= 0 ? "+" : ""}${r.d24}%`}</td>
                <td className="py-2 px-2 text-secondary">{r.tier}</td>
                <td className="py-2 px-2 text-secondary">{r.topLabel ? `${r.topLabel} · ${Math.round((r.topShare ?? 0) * 100)}%` : "—"}</td>
                <td className="py-2 px-2 text-right font-mono text-secondary">{r.answering}/{r.asked}</td>
                <td className="py-2 px-2 text-right font-mono text-secondary" title={r.staleSources.join(", ")}>{r.staleSources.length || "—"}</td>
                <td className="py-2 px-2"><FlagChips flags={r.flags} /></td>
                <td className="py-2 px-2 text-right text-tertiary" title={r.updatedAt ? formatDate(r.updatedAt) : ""}>{ago(r.updatedAt, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-surface bg-surface p-3">
      <div className="text-[10px] font-mono uppercase tracking-wider text-tertiary">{label}</div>
      <div className="text-lg font-bold text-primary mt-1">{value}</div>
      {sub && <div className="text-xs text-secondary mt-0.5">{sub}</div>}
    </div>
  );
}

function ViHealthView({ health, coverage, loading, error }: { health: ViHealth | null; coverage: SourceCoverage[]; loading: boolean; error: string | null }) {
  const now = health ? Date.parse(health.asOf) : NaN;
  const spendTotal = health ? health.spend.reduce((s, r) => s + r.usd, 0) : 0;
  const usedOf = (key: string) => health?.use[key] ?? 0;
  return (
    <div className="space-y-6">
      {error && <p className="text-xs text-atnx-magenta">{error}</p>}
      {loading && !health && <p className="text-xs text-tertiary">Reading the samples of today and the writes of the last day…</p>}
      {health && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile label="Fast refresh" value={health.cron.fastLastAt ? `${ago(health.cron.fastLastAt, now)} ago` : "no write"} sub={`${health.cron.hours[0]?.fastSlots ?? 0} five-minute slots this hour`} />
            <Tile label="Slow refresh" value={health.cron.slowLastAt ? `${ago(health.cron.slowLastAt, now)} ago` : "no snapshot"} sub={`${health.cron.hours.find((h) => h.slowMarkets > 0)?.slowMarkets ?? 0} of ${health.live} live markets last pass`} />
            <Tile label="GDELT job" value={health.lastSampleAt.gdelt ? `${ago(health.lastSampleAt.gdelt, now)} ago` : "no sample"} sub="hourly BigQuery count" />
            <Tile label="Spend today" value={usd(spendTotal)} sub="Apify and twitterapi.io, estimated" />
          </div>
          <ul className="text-xs text-secondary space-y-1">
            {health.cron.sentences.map((s) => <li key={s}>{s}</li>)}
          </ul>
        </>
      )}

      <div>
        <h3 className="text-xs font-mono uppercase tracking-wider text-tertiary mb-2">Sources across every market</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-tertiary font-mono uppercase tracking-wider">
                <th className="py-2 px-2 text-left">Source</th>
                <th className="py-2 px-2 text-left">Cadence</th>
                <th className="py-2 px-2 text-right">Answering</th>
                <th className="py-2 px-2 text-right">Seeing</th>
                <th className="py-2 px-2 text-right">Unknown</th>
                <th className="py-2 px-2 text-right">Not asked</th>
                <th className="py-2 px-2 text-right">Stale / late</th>
                <th className="py-2 px-2 text-right">Median age</th>
                <th className="py-2 px-2 text-right">Oldest</th>
                <th className="py-2 px-2 text-right">Spend today</th>
                <th className="py-2 px-2 text-right">Use vs budget</th>
              </tr>
            </thead>
            <tbody>
              {coverage.map((c) => {
                const spend = health?.spend.find((s) => s.source === c.source);
                const b = health?.budgets[c.source as keyof ViHealth["budgets"]];
                const use = c.source === "tiktok_search" ? `${usedOf("tiktok_search")} searches, ${usedOf("tiktok_search_reads")} re-reads` : b ? `${usedOf(c.source)} of ${b.budget} ${b.unit}` : "";
                return (
                  <tr key={c.source} className="border-t border-surface">
                    <td className="py-2 px-2 text-primary">{c.label}</td>
                    <td className="py-2 px-2 text-tertiary">{c.cadenceText}</td>
                    <td className="py-2 px-2 text-right font-mono text-secondary">{c.answering}</td>
                    <td className="py-2 px-2 text-right font-mono text-secondary">{c.seeing}</td>
                    <td className="py-2 px-2 text-right font-mono text-secondary">{c.unknown}</td>
                    <td className="py-2 px-2 text-right font-mono text-tertiary">{c.notAsked}</td>
                    <td className={`py-2 px-2 text-right font-mono ${c.stale ? "text-atnx-magenta" : c.late ? "text-atnx-yellow" : "text-secondary"}`}>{c.stale} / {c.late}</td>
                    <td className="py-2 px-2 text-right font-mono text-secondary">{ageText(c.medianAgeMs)}</td>
                    <td className="py-2 px-2 text-right font-mono text-secondary">{ageText(c.oldestAgeMs)}</td>
                    <td className="py-2 px-2 text-right font-mono text-secondary" title={spend?.units.map((u) => `${u.n} ${u.label}`).join(", ")}>{spend ? usd(spend.usd) : "free"}</td>
                    <td className="py-2 px-2 text-right text-tertiary">{b && c.source === "tiktok_search" ? `${use} (budget ${b.budget} / ${(b as { reads?: number }).reads ?? "—"})` : use}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {health && (
        <div>
          <h3 className="text-xs font-mono uppercase tracking-wider text-tertiary mb-2">The last 24 hours, by hour</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-tertiary font-mono uppercase tracking-wider">
                  <th className="py-2 px-2 text-left">Hour</th>
                  <th className="py-2 px-2 text-right">Fast slots (of 12)</th>
                  <th className="py-2 px-2 text-right">Markets written</th>
                  <th className="py-2 px-2 text-right">Slow snapshots</th>
                </tr>
              </thead>
              <tbody>
                {health.cron.hours.map((h) => (
                  <tr key={h.hour} className={`border-t border-surface ${h.ok ? "" : "text-atnx-magenta"}`}>
                    <td className="py-1.5 px-2">{new Date(h.hour).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{h.fastSlots}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{h.fastMarkets}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{h.slowMarkets} / {health.live}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
