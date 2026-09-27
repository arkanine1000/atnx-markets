"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { LeaderboardRow } from "@/lib/leaderboard";
import { STARTING_BALANCE } from "@/lib/leaderboard";
import type { Treasury } from "@/lib/treasury";
import {
  softDeleteMarket,
  restoreMarket,
  editMarketName,
  softDeleteCapture,
  reassignCapture,
  approveCapture,
  setParentMarket,
  purgeMarket,
  decideHandle,
} from "./actions";
import type { HandleRow } from "./page";

interface MarketRow {
  id: string;
  entity_name: string;
  entity_type: string | null;
  current_vi: number;
  total_captures: number;
  network: "simulated" | "devnet" | "mainnet";
  parent_market_id: string | null;
  deleted_at: string | null;
  created_at: string;
}

interface ReviewCaptureRow {
  id: string;
  image_url: string | null;
  confidence_score: number | null;
  resolution_status: "pending" | "resolved" | "review" | "new_entity";
  created_at: string;
  user_id: string | null;
  market_id: string | null;
  market: { entity_name: string } | null;
  user: { handle: string } | null;
}

interface ModerationLogRow {
  id: string;
  admin_user_id: string;
  action: string;
  target_type: string;
  target_id: string;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  admin: { handle: string } | null;
}

interface WaitlistRow {
  id: string;
  email: string;
  source: string;
  created_at: string;
}

type Tab = "markets" | "captures" | "handles" | "log" | "waitlist" | "trading";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
function signedUsd(n: number): string {
  return `${n >= 0 ? "+" : "-"}${usd.format(Math.abs(n))}`;
}

function formatDate(ts: string): string {
  return new Date(ts).toLocaleString();
}

function promptReason(action: string): string | null {
  const reason = window.prompt(`Reason for ${action} (optional):`, "");
  // Null means the user cancelled; empty string is allowed.
  return reason;
}

type SortDir = "asc" | "desc";
type SortValue = string | number | null;
interface SortState<K extends string> {
  key: K;
  dir: SortDir;
}

// Client-side sorting for the admin tables. Each tab already holds its
// whole list, so a header click reorders what is loaded, no refetch.
function useSort<R, K extends string>(
  rows: R[],
  columns: Record<K, (row: R) => SortValue>,
  initial: SortState<NoInfer<K>>
) {
  const [sort, setSort] = useState(initial);
  const get = columns[sort.key];
  const sorted = [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    // Empty values sink to the bottom whichever way the column runs.
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const cmp =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
    return sort.dir === "asc" ? cmp : -cmp;
  });

  function toggle(key: K) {
    setSort((s) => {
      if (s.key === key) return { key, dir: s.dir === "asc" ? "desc" : "asc" };
      // Text starts A to Z; numbers and dates start largest or newest.
      const sample = rows.map(columns[key]).find((v) => v !== null);
      return { key, dir: typeof sample === "string" ? "asc" : "desc" };
    });
  }

  return { sorted, sort, toggle };
}

function SortTh<K extends string>({
  column,
  sort,
  onSort,
  align = "left",
  children,
}: {
  column: K;
  sort: SortState<K>;
  onSort: (key: K) => void;
  align?: "left" | "right";
  children: React.ReactNode;
}) {
  const active = sort.key === column;
  return (
    <th
      className={`py-2 px-2 ${align === "right" ? "text-right" : "text-left"}`}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`uppercase tracking-wider cursor-pointer hover:text-primary transition-colors ${
          active ? "text-primary" : ""
        }`}
      >
        {children}
        {active && (sort.dir === "asc" ? " ▴" : " ▾")}
      </button>
    </th>
  );
}

const time = (ts: string) => Date.parse(ts);

export function AdminDashboard({
  handles,
  markets,
  reviewCaptures,
  log,
  waitlist,
  traders,
  treasury,
}: {
  handles: HandleRow[];
  markets: MarketRow[];
  reviewCaptures: ReviewCaptureRow[];
  log: ModerationLogRow[];
  waitlist: WaitlistRow[];
  traders: LeaderboardRow[];
  treasury: Treasury;
}) {
  const [tab, setTab] = useState<Tab>("markets");

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 w-full">
      <header className="flex items-center justify-between mb-6 gap-4">
        <div>
          <h1 className="wordmark text-2xl text-atnx-cyan tracking-[0.15em]">
            ATNX ADMIN
          </h1>
          <p className="text-xs text-secondary tracking-wide">
            Moderation &amp; taxonomy
          </p>
        </div>
        <Link
          href="/app"
          className="text-xs px-3 py-1.5 rounded border border-surface text-secondary hover:border-atnx-cyan/50 transition-colors"
        >
          &larr; Back to dashboard
        </Link>
      </header>

      <div className="flex gap-1 text-xs mb-4 border-b border-surface">
        {(["markets", "captures", "handles", "log", "waitlist", "trading"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 border-b-2 -mb-px cursor-pointer transition-colors ${
              tab === t
                ? "border-atnx-magenta text-atnx-magenta font-bold"
                : "border-transparent text-secondary hover:text-primary"
            }`}
          >
            {t === "markets"
              ? `Markets (${markets.length})`
              : t === "captures"
                ? `Review queue (${reviewCaptures.length})`
                : t === "handles"
                  ? `Handles (${handles.filter((h) => h.review && h.status === "candidate").length})`
                : t === "log"
                  ? `Moderation log (${log.length})`
                  : t === "waitlist"
                    ? `Waitlist (${waitlist.length})`
                    : `Trading (${traders.length})`}
          </button>
        ))}
      </div>

      {tab === "markets" && <MarketsTab markets={markets} />}
      {tab === "captures" && (
        <CapturesTab captures={reviewCaptures} markets={markets} />
      )}
      {tab === "handles" && <HandlesTab rows={handles} />}
      {tab === "log" && <LogTab log={log} />}
      {tab === "waitlist" && <WaitlistTab rows={waitlist} />}
      {tab === "trading" && <TradingTab rows={traders} treasury={treasury} />}
    </div>
  );
}

function MarketsTab({ markets }: { markets: MarketRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const byId = new Map(markets.map((m) => [m.id, m]));
  const parentName = (m: MarketRow) =>
    m.parent_market_id ? (byId.get(m.parent_market_id)?.entity_name ?? m.parent_market_id) : null;
  const { sorted, sort, toggle } = useSort(
    markets,
    {
      name: (m) => m.entity_name,
      type: (m) => m.entity_type,
      about: parentName,
      captures: (m) => m.total_captures,
      vi: (m) => m.current_vi,
      network: (m) => m.network,
      status: (m) => (m.deleted_at === null ? "active" : "deleted"),
      created: (m) => time(m.created_at),
    },
    { key: "created", dir: "desc" }
  );

  function run(id: string, fn: () => Promise<{ success: boolean; error?: string }>) {
    setBusyId(id);
    startTransition(async () => {
      const res = await fn();
      setBusyId(null);
      if (!res.success) {
        window.alert(`Failed: ${res.error}`);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-tertiary font-mono uppercase tracking-wider">
            <SortTh column="name" sort={sort} onSort={toggle}>Name</SortTh>
            <SortTh column="type" sort={sort} onSort={toggle}>Type</SortTh>
            <SortTh column="about" sort={sort} onSort={toggle}>About</SortTh>
            <SortTh column="captures" sort={sort} onSort={toggle} align="right">Captures</SortTh>
            <SortTh column="vi" sort={sort} onSort={toggle} align="right">VI</SortTh>
            <SortTh column="network" sort={sort} onSort={toggle}>Network</SortTh>
            <SortTh column="status" sort={sort} onSort={toggle}>Status</SortTh>
            <SortTh column="created" sort={sort} onSort={toggle}>Created</SortTh>
            <th className="text-right py-2 px-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => {
            const isDeleted = m.deleted_at !== null;
            const busy = pending && busyId === m.id;
            return (
              <tr
                key={m.id}
                className={`border-t border-surface ${
                  isDeleted ? "opacity-50" : ""
                }`}
              >
                <td className="py-2 px-2 font-mono">
                  {isDeleted ? (
                    // A soft-deleted market's page answers 404.
                    <span className="text-atnx-cyan">{m.entity_name}</span>
                  ) : (
                    <Link
                      href={`/app/markets/${m.id}`}
                      className="text-atnx-cyan hover:underline"
                    >
                      {m.entity_name}
                    </Link>
                  )}
                </td>
                <td className="py-2 px-2 text-secondary">
                  {m.entity_type ?? "\u2014"}
                </td>
                <td className="py-2 px-2 text-secondary">
                  {parentName(m) ?? "\u2014"}
                </td>
                <td className="py-2 px-2 text-right font-mono">
                  {m.total_captures}
                </td>
                <td className="py-2 px-2 text-right font-mono text-atnx-yellow">
                  {Math.round(m.current_vi)}
                </td>
                <td className="py-2 px-2 text-secondary">{m.network}</td>
                <td className="py-2 px-2">
                  {isDeleted ? (
                    <span className="text-atnx-magenta">deleted</span>
                  ) : (
                    <span className="text-atnx-cyan">active</span>
                  )}
                </td>
                <td className="py-2 px-2 text-tertiary">
                  {formatDate(m.created_at)}
                </td>
                <td className="py-2 px-2 text-right whitespace-nowrap">
                  <button
                    disabled={busy}
                    onClick={() => {
                      const next = window.prompt(
                        "New name:",
                        m.entity_name
                      );
                      if (!next || next === m.entity_name) return;
                      const reason = promptReason("edit name");
                      if (reason === null) return;
                      run(m.id, () => editMarketName(m.id, next, reason));
                    }}
                    className="text-atnx-cyan hover:text-atnx-cyan-dim mr-3 cursor-pointer disabled:opacity-40"
                  >
                    Edit
                  </button>
                  {!isDeleted && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        // Live markets that could be the subject: not this
                        // one, and not one that already has a parent.
                        const options = markets
                          .filter(
                            (o) =>
                              o.deleted_at === null &&
                              o.id !== m.id &&
                              o.parent_market_id === null
                          )
                          .map((o) => `${o.entity_name} — ${o.id}`)
                          .join("\n");
                        const target = window.prompt(
                          `What is "${m.entity_name}" about? Paste a market id, or leave empty to clear:\n\n${options}`,
                          m.parent_market_id ?? ""
                        );
                        if (target === null) return;
                        const parentId = target.trim() || null;
                        if (parentId === m.parent_market_id) return;
                        const reason = promptReason(parentId ? "set parent" : "clear parent");
                        if (reason === null) return;
                        run(m.id, () => setParentMarket(m.id, parentId, reason));
                      }}
                      className="text-atnx-cyan hover:text-atnx-cyan-dim mr-3 cursor-pointer disabled:opacity-40"
                    >
                      About
                    </button>
                  )}
                  {isDeleted ? (
                    <>
                      <button
                        disabled={busy}
                        onClick={() => {
                          const reason = promptReason("restore");
                          if (reason === null) return;
                          run(m.id, () => restoreMarket(m.id, reason));
                        }}
                        className="text-atnx-cyan hover:text-atnx-cyan-dim mr-3 cursor-pointer disabled:opacity-40"
                      >
                        Restore
                      </button>
                      {/* Permanent, no prompt: it only appears on rows already
                          soft-deleted. The server refuses one with trades; the
                          admin is then asked whether to take the trades too. */}
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(m.id, async () => {
                            const res = await purgeMarket(m.id);
                            if (res.success || !res.error?.includes("trade(s) on record")) return res;
                            const go = window.confirm(
                              `${res.error}.\n\nPurge it anyway? Its trades are deleted and every account is put back as if they never happened: open stakes and all fees refunded, realized wins taken back and losses returned, the creator's and treasury's fee shares reversed. This cannot be undone.`
                            );
                            return go ? purgeMarket(m.id, { withTrades: true }) : { success: true };
                          })
                        }
                        title="Delete permanently: the market, its captures, images and VI history. If anything was traded on it, asks whether to delete the trades too and unwind them from every balance."
                        className="text-atnx-magenta hover:opacity-80 cursor-pointer disabled:opacity-40"
                      >
                        Purge
                      </button>
                    </>
                  ) : (
                    <button
                      disabled={busy}
                      onClick={() => {
                        const reason = promptReason("soft delete");
                        if (reason === null) return;
                        run(m.id, () => softDeleteMarket(m.id, reason));
                      }}
                      className="text-atnx-magenta hover:opacity-80 cursor-pointer disabled:opacity-40"
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {markets.length === 0 && (
            <tr>
              <td colSpan={9} className="py-8 text-center text-tertiary">
                No markets yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function CapturesTab({
  captures,
  markets,
}: {
  captures: ReviewCaptureRow[];
  markets: MarketRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  function run(
    id: string,
    fn: () => Promise<{ success: boolean; error?: string }>
  ) {
    setBusyId(id);
    startTransition(async () => {
      const res = await fn();
      setBusyId(null);
      if (!res.success) {
        window.alert(`Failed: ${res.error}`);
        return;
      }
      router.refresh();
    });
  }

  const activeMarkets = markets.filter((m) => m.deleted_at === null);
  const { sorted, sort, toggle } = useSort(
    captures,
    {
      user: (c) => c.user?.handle ?? null,
      market: (c) => c.market?.entity_name ?? null,
      confidence: (c) => c.confidence_score,
      captured: (c) => time(c.created_at),
    },
    { key: "captured", dir: "desc" }
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-tertiary font-mono uppercase tracking-wider">
            <th className="text-left py-2 px-2">Thumb</th>
            <SortTh column="user" sort={sort} onSort={toggle}>User</SortTh>
            <SortTh column="market" sort={sort} onSort={toggle}>Matched to</SortTh>
            <SortTh column="confidence" sort={sort} onSort={toggle} align="right">Confidence</SortTh>
            <SortTh column="captured" sort={sort} onSort={toggle}>Captured</SortTh>
            <th className="text-right py-2 px-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => {
            const busy = pending && busyId === c.id;
            const confidence = c.confidence_score;
            const confColor =
              confidence === null
                ? "text-tertiary"
                : confidence >= 0.9
                  ? "text-atnx-cyan"
                  : confidence >= 0.85
                    ? "text-atnx-yellow"
                    : "text-atnx-magenta";
            return (
              <tr key={c.id} className="border-t border-surface">
                <td className="py-2 px-2">
                  {c.image_url ? (
                    <img
                      src={c.image_url}
                      alt=""
                      className="w-12 h-12 object-cover rounded border border-surface"
                    />
                  ) : (
                    <div className="w-12 h-12 bg-surface rounded" />
                  )}
                </td>
                <td className="py-2 px-2 text-secondary font-mono">
                  {c.user?.handle ?? "\u2014"}
                </td>
                <td className="py-2 px-2 text-atnx-cyan font-mono">
                  {c.market_id && c.market ? (
                    <Link href={`/app/markets/${c.market_id}`} className="hover:underline">
                      {c.market.entity_name}
                    </Link>
                  ) : (
                    "\u2014"
                  )}
                </td>
                <td className={`py-2 px-2 text-right font-mono ${confColor}`}>
                  {confidence === null
                    ? "new"
                    : `${(confidence * 100).toFixed(1)}%`}
                </td>
                <td className="py-2 px-2 text-tertiary">
                  {formatDate(c.created_at)}
                </td>
                <td className="py-2 px-2 text-right whitespace-nowrap">
                  <button
                    disabled={busy}
                    onClick={() => {
                      const reason = promptReason("approve");
                      if (reason === null) return;
                      run(c.id, () => approveCapture(c.id, reason));
                    }}
                    className="text-atnx-cyan hover:text-atnx-cyan-dim mr-3 cursor-pointer disabled:opacity-40"
                  >
                    Approve
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      const options = activeMarkets
                        .map((m) => `${m.entity_name} — ${m.id}`)
                        .join("\n");
                      const target = window.prompt(
                        `Reassign to market id:\n\n${options}`,
                        c.market_id ?? ""
                      );
                      if (!target) return;
                      const reason = promptReason("reassign");
                      if (reason === null) return;
                      run(c.id, () =>
                        reassignCapture(c.id, target.trim(), reason)
                      );
                    }}
                    className="text-atnx-yellow hover:opacity-80 mr-3 cursor-pointer disabled:opacity-40"
                  >
                    Reassign
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      const reason = promptReason("soft delete");
                      if (reason === null) return;
                      run(c.id, () => softDeleteCapture(c.id, reason));
                    }}
                    className="text-atnx-magenta hover:opacity-80 cursor-pointer disabled:opacity-40"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            );
          })}
          {captures.length === 0 && (
            <tr>
              <td colSpan={6} className="py-8 text-center text-tertiary">
                Review queue is empty.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function LogTab({ log }: { log: ModerationLogRow[] }) {
  const { sorted, sort, toggle } = useSort(
    log,
    {
      when: (r) => time(r.created_at),
      admin: (r) => r.admin?.handle ?? r.admin_user_id,
      action: (r) => r.action,
      target: (r) => `${r.target_type}:${r.target_id}`,
      reason: (r) => r.reason || null,
    },
    { key: "when", dir: "desc" }
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-tertiary font-mono uppercase tracking-wider">
            <SortTh column="when" sort={sort} onSort={toggle}>When</SortTh>
            <SortTh column="admin" sort={sort} onSort={toggle}>Admin</SortTh>
            <SortTh column="action" sort={sort} onSort={toggle}>Action</SortTh>
            <SortTh column="target" sort={sort} onSort={toggle}>Target</SortTh>
            <SortTh column="reason" sort={sort} onSort={toggle}>Reason</SortTh>
            <th className="text-left py-2 px-2">Metadata</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.id} className="border-t border-surface">
              <td className="py-2 px-2 text-tertiary whitespace-nowrap">
                {formatDate(row.created_at)}
              </td>
              <td className="py-2 px-2 text-atnx-cyan font-mono">
                {row.admin?.handle ?? row.admin_user_id.slice(0, 8)}
              </td>
              <td className="py-2 px-2 text-atnx-yellow font-mono">
                {row.action}
              </td>
              <td className="py-2 px-2 text-secondary font-mono">
                {row.target_type}:{row.target_id.slice(0, 8)}
              </td>
              <td className="py-2 px-2 text-secondary">
                {row.reason ?? "\u2014"}
              </td>
              <td className="py-2 px-2 text-tertiary font-mono break-all max-w-xs">
                {row.metadata ? JSON.stringify(row.metadata) : "\u2014"}
              </td>
            </tr>
          ))}
          {log.length === 0 && (
            <tr>
              <td colSpan={6} className="py-8 text-center text-tertiary">
                No admin actions logged yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// Landing-page signups, newest first, with the addresses one click from
// the clipboard so a batch of invites can go out from any mail client.
function WaitlistTab({ rows }: { rows: WaitlistRow[] }) {
  const [copied, setCopied] = useState(false);
  const { sorted, sort, toggle } = useSort(
    rows,
    {
      when: (r) => time(r.created_at),
      email: (r) => r.email,
      source: (r) => r.source,
    },
    { key: "when", dir: "desc" }
  );
  async function copyAll() {
    try {
      await navigator.clipboard.writeText(rows.map((r) => r.email).join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy the addresses:", rows.map((r) => r.email).join(", "));
    }
  }
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-xs text-secondary">
          {rows.length} {rows.length === 1 ? "address" : "addresses"} from
          the landing page.
        </p>
        <button
          type="button"
          onClick={copyAll}
          disabled={rows.length === 0}
          className="text-xs px-3 py-1.5 rounded border border-surface text-secondary hover:border-atnx-cyan/50 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {copied ? "Copied" : "Copy all emails"}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-tertiary font-mono uppercase tracking-wider">
              <SortTh column="when" sort={sort} onSort={toggle}>When</SortTh>
              <SortTh column="email" sort={sort} onSort={toggle}>Email</SortTh>
              <SortTh column="source" sort={sort} onSort={toggle}>Source</SortTh>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.id} className="border-t border-surface">
                <td className="py-2 px-2 text-tertiary whitespace-nowrap">
                  {formatDate(row.created_at)}
                </td>
                <td className="py-2 px-2 text-primary font-mono break-all">
                  {row.email}
                </td>
                <td className="py-2 px-2 text-secondary font-mono">
                  {row.source}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className="py-8 text-center text-tertiary">
                  Nobody has joined the waitlist yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// The whole simulated book: the treasury and what it has taken in, who
// leads, and every trader's equity, realized and unrealized result, fees
// earned, trade counts and volume. The public board shows only rank,
// fees and PnL; this is where the rest went.
function TradingTab({ rows, treasury }: { rows: LeaderboardRow[]; treasury: Treasury }) {
  const leader = rows[0];
  const totalVolume = rows.reduce((sum, r) => sum + r.volumeUsd, 0);
  const totalTrades = rows.reduce((sum, r) => sum + r.totalTrades, 0);
  const openPositions = rows.reduce((sum, r) => sum + r.openPositions, 0);
  const creatorFees = rows.reduce((sum, r) => sum + r.feesEarnedUsd, 0);
  const tone = (n: number) =>
    n > 0 ? "text-atnx-cyan" : n < 0 ? "text-atnx-magenta" : "text-tertiary";
  const { sorted, sort, toggle } = useSort(
    rows,
    {
      rank: (r) => r.rank,
      trader: (r) => r.handle,
      trades: (r) => r.totalTrades,
      open: (r) => r.openPositions,
      volume: (r) => r.volumeUsd,
      realized: (r) => r.realizedPnl,
      unrealized: (r) => r.unrealizedPnl,
      fees: (r) => r.feesEarnedUsd,
      equity: (r) => r.equity,
      return: (r) => r.returnPct,
    },
    { key: "rank", dir: "asc" }
  );
  const tiles: { label: string; value: string; sub: string }[] = [
    {
      label: "Treasury",
      value: usd.format(treasury.balanceUsd),
      sub: `${treasury.feeCount} ${treasury.feeCount === 1 ? "fee" : "fees"} taken`,
    },
    {
      label: "Paid to creators",
      value: usd.format(creatorFees),
      sub: "half of every open's 1% fee",
    },
    {
      label: "Leader",
      value: leader ? `@${leader.handle}` : "\u2014",
      sub: leader ? `${leader.returnPct >= 0 ? "+" : ""}${leader.returnPct.toFixed(1)}% on ${usd.format(STARTING_BALANCE)}` : "no trades yet",
    },
    {
      label: "Traders",
      value: String(rows.length),
      sub: "with at least one trade",
    },
    {
      label: "Volume",
      value: usd.format(totalVolume),
      sub: `${totalTrades} ${totalTrades === 1 ? "trade" : "trades"} \u00b7 ${openPositions} open`,
    },
  ];
  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg border border-surface bg-surface p-3 min-w-0">
            <div className="text-[10px] font-mono uppercase tracking-wider text-tertiary mb-1">
              {t.label}
            </div>
            <div className="font-display font-bold tabular-nums text-primary text-lg truncate">
              {t.value}
            </div>
            <div className="text-[11px] text-tertiary mt-0.5 truncate">{t.sub}</div>
          </div>
        ))}
      </div>
      <p className="text-xs text-secondary mb-3">
        Simulated USDC. Ranked by equity: cash plus open positions marked to
        the live VI, creator fees included. Everyone starts with{" "}
        {usd.format(STARTING_BALANCE)}.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-tertiary font-mono uppercase tracking-wider">
              <SortTh column="rank" sort={sort} onSort={toggle} align="right">#</SortTh>
              <SortTh column="trader" sort={sort} onSort={toggle}>Trader</SortTh>
              <SortTh column="trades" sort={sort} onSort={toggle} align="right">Trades</SortTh>
              <SortTh column="open" sort={sort} onSort={toggle} align="right">Open</SortTh>
              <SortTh column="volume" sort={sort} onSort={toggle} align="right">Volume</SortTh>
              <SortTh column="realized" sort={sort} onSort={toggle} align="right">Realized</SortTh>
              <SortTh column="unrealized" sort={sort} onSort={toggle} align="right">Unrealized</SortTh>
              <SortTh column="fees" sort={sort} onSort={toggle} align="right">Fees earned</SortTh>
              <SortTh column="equity" sort={sort} onSort={toggle} align="right">Equity</SortTh>
              <SortTh column="return" sort={sort} onSort={toggle} align="right">Return</SortTh>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.userId} className="border-t border-surface font-mono tabular-nums">
                <td className="py-2 px-2 text-right text-tertiary">{row.rank}</td>
                <td className="py-2 px-2 text-left text-primary font-sans font-bold">
                  @{row.handle}
                </td>
                <td className="py-2 px-2 text-right text-secondary">{row.totalTrades}</td>
                <td className="py-2 px-2 text-right text-secondary">{row.openPositions}</td>
                <td className="py-2 px-2 text-right text-secondary">{usd.format(row.volumeUsd)}</td>
                <td className={`py-2 px-2 text-right ${tone(row.realizedPnl)}`}>
                  {signedUsd(row.realizedPnl)}
                </td>
                <td className={`py-2 px-2 text-right ${tone(row.unrealizedPnl)}`}>
                  {signedUsd(row.unrealizedPnl)}
                </td>
                <td className={`py-2 px-2 text-right ${tone(row.feesEarnedUsd)}`}>
                  {row.feesEarnedUsd > 0 ? signedUsd(row.feesEarnedUsd) : "\u2014"}
                </td>
                <td className="py-2 px-2 text-right text-primary font-bold">
                  {usd.format(row.equity)}
                </td>
                <td className={`py-2 px-2 text-right ${tone(row.returnPct)}`}>
                  {row.returnPct >= 0 ? "+" : ""}
                  {row.returnPct.toFixed(1)}%
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="py-8 text-center text-tertiary">
                  Nobody has traded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Creator channels. The review queue first: channels big enough to be the
// market's own that the resolver could not prove; verify the right one or
// reject. Then what is verified, with a way to undo a wrong one.
function HandlesTab({ rows }: { rows: HandleRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const queue = rows.filter((r) => r.review && r.status === "candidate");
  const verified = rows.filter((r) => r.status === "verified");

  function run(id: string, fn: () => Promise<{ success: boolean; error?: string }>) {
    setBusyId(id);
    startTransition(async () => {
      const res = await fn();
      setBusyId(null);
      if (!res.success) {
        window.alert(`Failed: ${res.error}`);
        return;
      }
      router.refresh();
    });
  }
  const subs = (n: number | null) => (n === null ? "hidden" : n.toLocaleString());
  // One tab for both platforms (supabase/017 allows youtube, tiktok, x).
  const accountUrl = (platform: HandleRow["platform"], id: string | null, handle: string | null) =>
    platform === "x" ? `https://x.com/${handle ?? id}` : `https://www.youtube.com/channel/${id}`;
  const audienceWord = (platform: HandleRow["platform"]) => (platform === "x" ? "followers" : "subs");
  const countWord = (platform: HandleRow["platform"]) => (platform === "x" ? "posts" : "videos");
  const key = (r: HandleRow) => `${r.market_id}:${r.platform}`;

  return (
    <div className="space-y-8 text-xs">
      <section>
        <h2 className="font-mono uppercase tracking-wider text-tertiary mb-2">Needs a decision ({queue.length})</h2>
        {queue.length === 0 && <p className="text-secondary">Nothing to review.</p>}
        {queue.map((r) => {
          const busy = pending && busyId === key(r);
          return (
            <div key={key(r)} className="border border-surface rounded p-3 mb-3">
              <div className="flex items-baseline justify-between gap-4 mb-2">
                <Link href={`/app/markets/${r.market_id}`} className="font-mono text-atnx-cyan hover:underline">
                  {r.market?.entity_name ?? r.market_id}
                  <span className="ml-2 text-tertiary uppercase">{r.platform}</span>
                </Link>
                <span className="text-tertiary">{r.confidence}</span>
              </div>
              <table className="w-full">
                <tbody>
                  {(r.evidence?.candidates ?? []).map((c) => (
                    <tr key={c.id} className="border-t border-surface">
                      <td className="py-1.5 px-2 font-mono">
                        <a href={accountUrl(r.platform, c.id, c.handle)} target="_blank" rel="noopener" className="text-atnx-cyan hover:underline">
                          @{c.handle ?? c.id}
                        </a>
                      </td>
                      <td className="py-1.5 px-2 text-secondary">{c.title}</td>
                      <td className="py-1.5 px-2 text-right font-mono">{subs(c.subscribers)} {audienceWord(r.platform)}</td>
                      <td className="py-1.5 px-2 text-right font-mono">{c.videos} {countWord(r.platform)}</td>
                      <td className="py-1.5 px-2 text-tertiary">{c.evidence.join(", ")}</td>
                      <td className="py-1.5 px-2 text-right whitespace-nowrap">
                        <button
                          disabled={busy}
                          onClick={() => run(key(r), () => decideHandle(r.market_id, "verify", { id: c.id, handle: c.handle, subscribers: c.subscribers }, r.platform))}
                          className="text-atnx-cyan hover:text-atnx-cyan-dim cursor-pointer disabled:opacity-40"
                        >
                          Verify
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button
                disabled={busy}
                onClick={() => run(key(r), () => decideHandle(r.market_id, "reject", undefined, r.platform))}
                className="mt-2 text-atnx-magenta hover:underline cursor-pointer disabled:opacity-40"
              >
                None of these
              </button>
            </div>
          );
        })}
      </section>

      <section>
        <h2 className="font-mono uppercase tracking-wider text-tertiary mb-2">Verified ({verified.length})</h2>
        <table className="w-full">
          <tbody>
            {verified.map((r) => (
              <tr key={key(r)} className="border-t border-surface">
                <td className="py-1.5 px-2 font-mono text-atnx-cyan">{r.market?.entity_name ?? r.market_id}</td>
                <td className="py-1.5 px-2 font-mono">
                  <span className="text-tertiary uppercase mr-2">{r.platform}</span>
                  <a href={accountUrl(r.platform, r.platform_id, r.handle)} target="_blank" rel="noopener" className="hover:underline">
                    @{r.handle ?? r.platform_id}
                  </a>
                </td>
                <td className="py-1.5 px-2 text-right font-mono">{subs(r.audience)} {audienceWord(r.platform)}</td>
                <td className="py-1.5 px-2 text-tertiary">{r.confidence === "admin" ? "admin" : r.confidence}</td>
                <td className="py-1.5 px-2 text-tertiary">{r.verified_at ? formatDate(r.verified_at) : "\u2014"}</td>
                <td className="py-1.5 px-2 text-right">
                  <button
                    disabled={pending && busyId === key(r)}
                    onClick={() => {
                      if (!window.confirm(`Stop scoring ${r.market?.entity_name} on @${r.handle} (${r.platform})?`)) return;
                      run(key(r), () => decideHandle(r.market_id, "reject", undefined, r.platform));
                    }}
                    className="text-atnx-magenta hover:underline cursor-pointer disabled:opacity-40"
                  >
                    Reject
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
