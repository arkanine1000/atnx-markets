"use client";

import { useMemo } from "react";
import { useAccount, useReadContract } from "wagmi";
import { boundedViMarketsAbi, mockUsdgAbi } from "@/lib/bm/abi";
import { BM_CHAINS, DEFAULT_CHAIN, chainById, isDeployed, type BmChain } from "@/lib/bm/chains";
import { priceUp as poolPriceUp } from "@/lib/bm/fpmm";
import type { BmMarketRow } from "@/lib/supabase/database-bm";

const LIVE = new Set(["pending", "open", "resolving"]);

// The chain the ticket works on: the wallet's chain when it is one of
// ours, else the default. The wallet may be on neither, which the ticket
// shows as "switch".
export function useBmChain(): { chain: BmChain; walletChainId: number | undefined; onOurChain: boolean } {
  const { chainId } = useAccount();
  const ours = chainId ? chainById(chainId) : null;
  return {
    chain: ours ?? BM_CHAINS[DEFAULT_CHAIN],
    walletChainId: chainId,
    onOurChain: !!ours && isDeployed(ours),
  };
}

export function liveRow(rows: BmMarketRow[], chainKey: string): BmMarketRow | null {
  return rows.find((r) => r.chain === chainKey && LIVE.has(r.state)) ?? null;
}

export function resolvedRows(rows: BmMarketRow[], chainKey: string): BmMarketRow[] {
  return rows.filter((r) => r.chain === chainKey && r.state === "resolved" && r.onchain_market_id);
}

// Live on-chain state of one bounded market, refreshed every few seconds:
// the pools (hence the price), the fee, the viewer's shares and USDG.
export function useOnchainMarket(chain: BmChain, row: BmMarketRow | null) {
  const { address } = useAccount();
  const id = row?.onchain_market_id ? BigInt(row.onchain_market_id) : null;
  const enabled = isDeployed(chain) && id !== null;

  const market = useReadContract({
    address: chain.markets,
    abi: boundedViMarketsAbi,
    functionName: "getMarket",
    args: id !== null ? [id] : undefined,
    chainId: chain.chainId,
    query: { enabled, refetchInterval: 5_000 },
  });
  const fee = useReadContract({
    address: chain.markets,
    abi: boundedViMarketsAbi,
    functionName: "feeBps",
    chainId: chain.chainId,
    query: { enabled: isDeployed(chain), staleTime: 60_000 },
  });
  const shares = useReadContract({
    address: chain.markets,
    abi: boundedViMarketsAbi,
    functionName: "sharesOf",
    args: id !== null && address ? [id, address] : undefined,
    chainId: chain.chainId,
    query: { enabled: enabled && !!address, refetchInterval: 5_000 },
  });
  const usdg = useReadContract({
    address: chain.usdg,
    abi: mockUsdgAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: chain.chainId,
    query: { enabled: isDeployed(chain) && !!address, refetchInterval: 5_000 },
  });
  const allowance = useReadContract({
    address: chain.usdg,
    abi: mockUsdgAbi,
    functionName: "allowance",
    args: address ? [address, chain.markets] : undefined,
    chainId: chain.chainId,
    query: { enabled: isDeployed(chain) && !!address, refetchInterval: 5_000 },
  });

  const pools = useMemo(
    () => (market.data ? { poolUp: market.data.poolUp, poolDown: market.data.poolDown } : null),
    [market.data],
  );
  const priceUp = pools ? poolPriceUp(pools) : null;

  return {
    id,
    market: market.data ?? null,
    pools,
    priceUp,
    feeBps: fee.data !== undefined ? BigInt(fee.data) : 100n,
    up: shares.data?.[0] ?? 0n,
    down: shares.data?.[1] ?? 0n,
    usdg: usdg.data ?? 0n,
    allowance: allowance.data ?? 0n,
    loading: market.isLoading,
    error: market.error ?? null,
    refetch: () => {
      void market.refetch();
      void shares.refetch();
      void usdg.refetch();
      void allowance.refetch();
    },
  };
}
