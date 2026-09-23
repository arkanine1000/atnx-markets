"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  softDeleteMarket,
  restoreMarket,
  editMarketName,
  softDeleteCapture,
  reassignCapture,
  approveCapture,
  setParentMarket,
} from "./actions";

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

type Tab = "markets" | "captures" | "log";

function formatDate(ts: string): string {
  return new Date(ts).toLocaleString();
}

function promptReason(action: string): string | null {
  const reason = window.prompt(`Reason for ${action} (optional):`, "");
  // Null means the user cancelled; empty string is allowed.
  return reason;
}

export function AdminDashboard({
  markets,
  reviewCaptures,
  log,
}: {
  markets: MarketRow[];
  reviewCaptures: ReviewCaptureRow[];
  log: ModerationLogRow[];
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
        {(["markets", "captures", "log"] as Tab[]).map((t) => (
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
                : `Moderation log (${log.length})`}
          </button>
        ))}
      </div>

      {tab === "markets" && <MarketsTab markets={markets} />}
      {tab === "captures" && (
        <CapturesTab captures={reviewCaptures} markets={markets} />
      )}
      {tab === "log" && <LogTab log={log} />}
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
                <td className="py-2 px-2 text-atnx-cyan font-mono">
                  {m.entity_name}
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
                    <button
                      disabled={busy}
                      onClick={() => {
                        const reason = promptReason("restore");
                        if (reason === null) return;
                        run(m.id, () => restoreMarket(m.id, reason));
                      }}
                      className="text-atnx-cyan hover:text-atnx-cyan-dim cursor-pointer disabled:opacity-40"
                    >
                      Restore
                    </button>
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
                  {c.market?.entity_name ?? "\u2014"}
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
