"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { boundedViMarketsAbi } from "@/lib/bm/abi";
import type { BmMarketRow } from "@/lib/supabase/database-bm";
import { liveRow, useBmChain } from "./useBounded";

export interface TradeMark {
  time: number; // ms since epoch, the block's timestamp
  side: "up" | "down";
  kind: "buy" | "sell";
  shares: bigint;
  usdg: bigint;
  tx: string;
}

// The viewer's own trades on the live bounded market, from the contract's
// Bought and Sold events filtered by trader, with block times so they can
// sit on the VI chart. Refreshed every 30 s and whenever the wallet or the
// market changes.
export function useMyTrades(bounded: BmMarketRow[]): TradeMark[] {
  const { chain } = useBmChain();
  const { address } = useAccount();
  const client = usePublicClient({ chainId: chain.chainId });
  const row = liveRow(bounded, chain.key);
  const [marks, setMarks] = useState<TradeMark[]>([]);
  const onchainId = row?.onchain_market_id ?? null;
  const fromBlock = row?.created_block ? BigInt(row.created_block) : chain.deployBlock;

  useEffect(() => {
    if (!client || !address || !onchainId) return;
    const id = BigInt(onchainId);
    let cancelled = false;
    async function load() {
      try {
        const [bought, sold] = await Promise.all([
          client!.getContractEvents({ address: chain.markets, abi: boundedViMarketsAbi, eventName: "Bought", args: { id, trader: address }, fromBlock }),
          client!.getContractEvents({ address: chain.markets, abi: boundedViMarketsAbi, eventName: "Sold", args: { id, trader: address }, fromBlock }),
        ]);
        const blocks = Array.from(new Set([...bought, ...sold].map((e) => e.blockNumber)));
        const times = new Map<bigint, number>();
        await Promise.all(
          blocks.map(async (b) => {
            const blk = await client!.getBlock({ blockNumber: b });
            times.set(b, Number(blk.timestamp) * 1000);
          }),
        );
        const out: TradeMark[] = [
          ...bought.map((e) => ({ time: times.get(e.blockNumber) ?? 0, side: e.args.side === 0 ? ("up" as const) : ("down" as const), kind: "buy" as const, shares: e.args.shares!, usdg: e.args.invest!, tx: e.transactionHash })),
          ...sold.map((e) => ({ time: times.get(e.blockNumber) ?? 0, side: e.args.side === 0 ? ("up" as const) : ("down" as const), kind: "sell" as const, shares: e.args.shares!, usdg: e.args.payout!, tx: e.transactionHash })),
        ].sort((a, b) => a.time - b.time);
        if (!cancelled) setMarks(out);
      } catch (err) {
        console.warn("[bm] own trades failed", (err as Error).message);
      }
    }
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [client, address, onchainId, fromBlock, chain]);

  return marks;
}
