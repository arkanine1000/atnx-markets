"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { boundedViMarketsAbi } from "@/lib/bm/abi";
import { txUrl } from "@/lib/bm/chains";
import type { BmMarketRow } from "@/lib/supabase/database-bm";
import { fmtUsdg, shortAddress } from "./format";
import { liveRow, useBmChain } from "./useBounded";

interface Row {
  key: string;
  block: bigint;
  tx: string;
  trader: string;
  kind: "buy" | "sell";
  side: "UP" | "DOWN";
  usdg: bigint;
  shares: bigint;
}

// The market's trades, read straight from the contract's Bought and Sold
// events on the wallet's chain (or the default one).
export function ChainTradeLog({ bounded }: { bounded: BmMarketRow[] }) {
  const { chain } = useBmChain();
  const row = liveRow(bounded, chain.key);
  const client = usePublicClient({ chainId: chain.chainId });
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client || !row?.onchain_market_id) return;
    const id = BigInt(row.onchain_market_id);
    const fromBlock = row.created_block ? BigInt(row.created_block) : chain.deployBlock;
    let cancelled = false;
    async function load() {
      try {
        const [bought, sold] = await Promise.all([
          client!.getContractEvents({ address: chain.markets, abi: boundedViMarketsAbi, eventName: "Bought", args: { id }, fromBlock }),
          client!.getContractEvents({ address: chain.markets, abi: boundedViMarketsAbi, eventName: "Sold", args: { id }, fromBlock }),
        ]);
        const out: Row[] = [
          ...bought.map((e) => ({
            key: `${e.transactionHash}-${e.logIndex}`,
            block: e.blockNumber,
            tx: e.transactionHash,
            trader: e.args.trader!,
            kind: "buy" as const,
            side: e.args.side === 0 ? ("UP" as const) : ("DOWN" as const),
            usdg: e.args.invest!,
            shares: e.args.shares!,
          })),
          ...sold.map((e) => ({
            key: `${e.transactionHash}-${e.logIndex}`,
            block: e.blockNumber,
            tx: e.transactionHash,
            trader: e.args.trader!,
            kind: "sell" as const,
            side: e.args.side === 0 ? ("UP" as const) : ("DOWN" as const),
            usdg: e.args.payout!,
            shares: e.args.shares!,
          })),
        ].sort((a, b) => (a.block === b.block ? 0 : a.block > b.block ? -1 : 1));
        if (!cancelled) {
          setRows(out.slice(0, 50));
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message.split("\n")[0]);
      }
    }
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [client, row?.onchain_market_id, row?.created_block, chain]);

  if (!row?.onchain_market_id) return <p className="text-xs text-tertiary">No bounded market is open on {chain.label}.</p>;
  if (error) return <p className="text-xs text-atnx-magenta">{error}</p>;
  if (rows === null) return <p className="text-xs text-tertiary">Loading trades…</p>;
  if (rows.length === 0) return <p className="text-xs text-tertiary">No trades yet. Be the first.</p>;

  return (
    <ul className="divide-y divide-surface text-xs font-mono tabular-nums">
      {rows.map((r) => (
        <li key={r.key} className="flex items-center justify-between gap-3 py-2">
          <span className="text-secondary">{shortAddress(r.trader)}</span>
          <span className={r.side === "UP" ? "text-atnx-cyan" : "text-atnx-magenta"}>
            {r.kind === "buy" ? "bought" : "sold"} {fmtUsdg(r.shares)} {r.side}
          </span>
          <span className="text-primary">{fmtUsdg(r.usdg)} USDG</span>
          <a href={txUrl(chain, r.tx)} target="_blank" rel="noreferrer" className="text-tertiary hover:text-atnx-cyan">
            ↗
          </a>
        </li>
      ))}
    </ul>
  );
}
