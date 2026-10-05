"use client";

import { solAddressUrl, solTxUrl } from "@/lib/bm/chains";
import type { BmRoundRow, BmSeriesRow } from "@/lib/supabase/database-bm";
import { fmtSpan } from "./time";

// The series' finished rounds, newest first, from the registry: the
// target the round opened at, the settlement average, who won, the
// presale pots, and the transactions on the Solana explorer.
export function RoundHistory({ series, rounds }: { series: BmSeriesRow; rounds: BmRoundRow[] }) {
  const done = rounds.filter((r) => r.state === "settled" || r.state === "void").sort((a, b) => b.idx - a.idx);

  return (
    <div>
      <p className="text-[11px] text-tertiary mb-3">
        {fmtSpan(series.round_secs)} rounds{series.fast ? " (fast demo series)" : ""}, settled on the index averaged over the last {fmtSpan(series.settle_window_secs)}.
        {series.series_pubkey && (
          <>
            {" "}
            <a href={solAddressUrl(series.series_pubkey)} target="_blank" rel="noreferrer" className="link-quiet">
              Series on the explorer ↗
            </a>
          </>
        )}
      </p>
      {done.length === 0 ? (
        <p className="text-xs text-tertiary">No round has settled yet.</p>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-xs font-mono tabular-nums">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-tertiary text-left">
                <th className="font-normal px-1 py-1.5">Round</th>
                <th className="font-normal px-1 py-1.5 text-right">Target</th>
                <th className="font-normal px-1 py-1.5 text-right">Settled</th>
                <th className="font-normal px-1 py-1.5">Winner</th>
                <th className="font-normal px-1 py-1.5 text-right">Pots UP / DOWN</th>
                <th className="font-normal px-1 py-1.5 text-right">Tx</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface">
              {done.map((r) => {
                const tx = r.settle_tx ?? r.void_tx;
                return (
                  <tr key={r.id}>
                    <td className="px-1 py-2 text-secondary">
                      {r.round_pubkey ? (
                        <a href={solAddressUrl(r.round_pubkey)} target="_blank" rel="noreferrer" className="link-quiet">
                          {r.idx}
                        </a>
                      ) : (
                        r.idx
                      )}
                    </td>
                    <td className="px-1 py-2 text-right text-primary">{r.target_vi !== null ? Math.round(r.target_vi) : "—"}</td>
                    <td className="px-1 py-2 text-right text-primary">{r.settle_vi !== null ? Math.round(r.settle_vi) : "—"}</td>
                    <td className="px-1 py-2">
                      {r.state === "void" ? (
                        <span className="text-tertiary">void</span>
                      ) : (
                        <span className={r.winner === "up" ? "text-atnx-cyan light:text-atnx-cyan-light" : "text-atnx-magenta light:text-atnx-magenta-light"}>{r.winner?.toUpperCase() ?? "—"}</span>
                      )}
                    </td>
                    <td className="px-1 py-2 text-right text-secondary whitespace-nowrap">
                      {fmtPot(r.presale_up_usdg)} / {fmtPot(r.presale_down_usdg)}
                    </td>
                    <td className="px-1 py-2 text-right whitespace-nowrap">
                      {r.open_tx && (
                        <a href={solTxUrl(r.open_tx)} target="_blank" rel="noreferrer" className="text-tertiary link-quiet" title="Open transaction">
                          open ↗
                        </a>
                      )}
                      {tx && (
                        <a href={solTxUrl(tx)} target="_blank" rel="noreferrer" className="ml-2 text-tertiary link-quiet" title={r.state === "void" ? "Void transaction" : "Settle transaction"}>
                          {r.state === "void" ? "void" : "settle"} ↗
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function fmtPot(v: number | null): string {
  if (v === null) return "—";
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
