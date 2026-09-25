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
            <th className="text-left py-2 px-2">Name</th>
            <th className="text-left py-2 px-2">Type</th>
            <th className="text-left py-2 px-2">About</th>
            <th className="text-right py-2 px-2">Captures</th>
            <th className="text-right py-2 px-2">VI</th>
            <th className="text-left py-2 px-2">Network</th>
            <th className="text-left py-2 px-2">Status</th>
            <th className="text-left py-2 px-2">Created</th>
            <th className="text-right py-2 px-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((m) => {
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
                  {m.parent_market_id
                    ? (byId.get(m.parent_market_id)?.entity_name ?? m.parent_market_id)
                    : "\u2014"}
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
                          soft-deleted, and the server refuses one with trades. */}
                      <button
                        disabled={busy}
                        onClick={() => run(m.id, () => purgeMarket(m.id))}
                        title="Delete permanently: the market, its captures, images and VI history. Refused if anything was traded on it."
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

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-tertiary font-mono uppercase tracking-wider">
            <th className="text-left py-2 px-2">Thumb</th>
            <th className="text-left py-2 px-2">User</th>
            <th className="text-left py-2 px-2">Matched to</th>
            <th className="text-right py-2 px-2">Confidence</th>
            <th className="text-left py-2 px-2">Captured</th>
            <th className="text-right py-2 px-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {captures.map((c) => {
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
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-tertiary font-mono uppercase tracking-wider">
            <th className="text-left py-2 px-2">When</th>
            <th className="text-left py-2 px-2">Admin</th>
            <th className="text-left py-2 px-2">Action</th>
            <th className="text-left py-2 px-2">Target</th>
            <th className="text-left py-2 px-2">Reason</th>
            <th className="text-left py-2 px-2">Metadata</th>
          </tr>
        </thead>
        <tbody>
          {log.map((row) => (
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
          the landing page, newest first.
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
              <th className="text-left py-2 px-2">When</th>
              <th className="text-left py-2 px-2">Email</th>
              <th className="text-left py-2 px-2">Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
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
              <th className="text-right py-2 px-2">#</th>
              <th className="text-left py-2 px-2">Trader</th>
              <th className="text-right py-2 px-2">Trades</th>
              <th className="text-right py-2 px-2">Open</th>
              <th className="text-right py-2 px-2">Volume</th>
              <th className="text-right py-2 px-2">Realized</th>
              <th className="text-right py-2 px-2">Unrealized</th>
              <th className="text-right py-2 px-2">Fees earned</th>
              <th className="text-right py-2 px-2">Equity</th>
              <th className="text-right py-2 px-2">Return</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
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

  return (
    <div className="space-y-8 text-xs">
      <section>
        <h2 className="font-mono uppercase tracking-wider text-tertiary mb-2">Needs a decision ({queue.length})</h2>
        {queue.length === 0 && <p className="text-secondary">Nothing to review.</p>}
        {queue.map((r) => {
          const busy = pending && busyId === r.market_id;
          return (
            <div key={r.market_id} className="border border-surface rounded p-3 mb-3">
              <div className="flex items-baseline justify-between gap-4 mb-2">
                <Link href={`/app/markets/${r.market_id}`} className="font-mono text-atnx-cyan hover:underline">
                  {r.market?.entity_name ?? r.market_id}
                </Link>
                <span className="text-tertiary">{r.confidence}</span>
              </div>
              <table className="w-full">
                <tbody>
                  {(r.evidence?.candidates ?? []).map((c) => (
                    <tr key={c.id} className="border-t border-surface">
                      <td className="py-1.5 px-2 font-mono">
                        <a href={`https://www.youtube.com/channel/${c.id}`} target="_blank" rel="noopener" className="text-atnx-cyan hover:underline">
                          @{c.handle ?? c.id}
                        </a>
                      </td>
                      <td className="py-1.5 px-2 text-secondary">{c.title}</td>
                      <td className="py-1.5 px-2 text-right font-mono">{subs(c.subscribers)} subs</td>
                      <td className="py-1.5 px-2 text-right font-mono">{c.videos} videos</td>
                      <td className="py-1.5 px-2 text-tertiary">{c.evidence.join(", ")}</td>
                      <td className="py-1.5 px-2 text-right whitespace-nowrap">
                        <button
                          disabled={busy}
                          onClick={() => run(r.market_id, () => decideHandle(r.market_id, "verify", { id: c.id, handle: c.handle, subscribers: c.subscribers }))}
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
                onClick={() => run(r.market_id, () => decideHandle(r.market_id, "reject"))}
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
              <tr key={r.market_id} className="border-t border-surface">
                <td className="py-1.5 px-2 font-mono text-atnx-cyan">{r.market?.entity_name ?? r.market_id}</td>
                <td className="py-1.5 px-2 font-mono">
                  <a href={`https://www.youtube.com/channel/${r.platform_id}`} target="_blank" rel="noopener" className="hover:underline">
                    @{r.handle ?? r.platform_id}
                  </a>
                </td>
                <td className="py-1.5 px-2 text-right font-mono">{subs(r.audience)} subs</td>
                <td className="py-1.5 px-2 text-tertiary">{r.confidence === "admin" ? "admin" : r.confidence}</td>
                <td className="py-1.5 px-2 text-tertiary">{r.verified_at ? formatDate(r.verified_at) : "\u2014"}</td>
                <td className="py-1.5 px-2 text-right">
                  <button
                    disabled={pending && busyId === r.market_id}
                    onClick={() => {
                      if (!window.confirm(`Stop scoring ${r.market?.entity_name} on @${r.handle}?`)) return;
                      run(r.market_id, () => decideHandle(r.market_id, "reject"));
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
