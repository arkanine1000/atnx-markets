"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAccount, useConfig, useReadContract, useWriteContract } from "wagmi";
import { ConnectButton } from "./ConnectButton";
import { waitForTransactionReceipt } from "wagmi/actions";
import { boundedViMarketsAbi } from "@/lib/bm/abi";
import { isDeployed } from "@/lib/bm/chains";
import { quoteSell } from "@/lib/bm/fpmm";
import type { BmMarketListing } from "@/lib/bm/listing";
import { fmtCents, fmtUsdg } from "./format";
import { useBmChain } from "./useBounded";

// The wallet's UP and DOWN shares across every bounded market on the
// chain it is connected to, read in two calls (balancesOf, getMarkets).
// Open markets show what a sell would pay now; resolved ones offer the
// redeem. Nothing here is stored off-chain.
export function OnchainPortfolio({ markets }: { markets: BmMarketListing[] }) {
  const { chain, onOurChain } = useBmChain();
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const config = useConfig();
  const [busy, setBusy] = useState<string | null>(null);

  const onChain = useMemo(
    () => markets.filter((m) => m.chain === chain.key && m.onchainMarketId),
    [markets, chain.key],
  );
  const ids = useMemo(() => onChain.map((m) => BigInt(m.onchainMarketId!)), [onChain]);
  const enabled = isDeployed(chain) && !!address && ids.length > 0;

  const balances = useReadContract({
    address: chain.markets,
    abi: boundedViMarketsAbi,
    functionName: "balancesOf",
    args: address ? [address, ids] : undefined,
    chainId: chain.chainId,
    query: { enabled, refetchInterval: 10_000 },
  });
  const states = useReadContract({
    address: chain.markets,
    abi: boundedViMarketsAbi,
    functionName: "getMarkets",
    args: [ids],
    chainId: chain.chainId,
    query: { enabled: isDeployed(chain) && ids.length > 0, refetchInterval: 10_000 },
  });
  const fee = useReadContract({
    address: chain.markets,
    abi: boundedViMarketsAbi,
    functionName: "feeBps",
    chainId: chain.chainId,
    query: { enabled: isDeployed(chain), staleTime: 60_000 },
  });
  const feeBps = fee.data !== undefined ? BigInt(fee.data) : 100n;

  const rows = useMemo(() => {
    if (!balances.data || !states.data) return [];
    return onChain
      .map((m, i) => {
        const [up, down] = balances.data![i];
        const s = states.data![i];
        const pools = { poolUp: s.poolUp, poolDown: s.poolDown };
        const resolved = s.status === 2;
        const winner = s.winner === 0 ? "up" : "down";
        const priceUp = Number(s.poolDown) / Math.max(1, Number(s.poolUp) + Number(s.poolDown));
        const positions = (["up", "down"] as const)
          .map((side) => {
            const shares = side === "up" ? up : down;
            if (shares === 0n) return null;
            const worth = resolved ? (winner === side ? shares : 0n) : quoteSell(pools, side, shares, feeBps).payout;
            return { side, shares, worth, price: side === "up" ? priceUp : 1 - priceUp, won: resolved && winner === side };
          })
          .filter((p): p is NonNullable<typeof p> => p !== null);
        return { m, resolved, winner, positions, resolvedVi: Number(s.resolvedViE2) / 100 };
      })
      .filter((r) => r.positions.length > 0);
  }, [onChain, balances.data, states.data, feeBps]);

  const totalWorth = rows.reduce((acc, r) => acc + r.positions.reduce((a, p) => a + p.worth, 0n), 0n);
  async function redeem(id: string, key: string) {
    setBusy(key);
    try {
      const hash = await writeContractAsync({
        address: chain.markets,
        abi: boundedViMarketsAbi,
        functionName: "redeem",
        args: [BigInt(id)],
        chainId: chain.chainId,
      });
      await waitForTransactionReceipt(config, { hash, chainId: chain.chainId });
      void balances.refetch();
    } finally {
      setBusy(null);
    }
  }

  if (!isConnected || !address) {
    return (
      <div className="rounded-2xl border border-surface bg-surface p-5">
        <p className="text-sm text-secondary mb-3">Your UP and DOWN shares live in your wallet. Connect it to see them.</p>
        <ConnectButton className="max-w-xs" />
      </div>
    );
  }
  if (!onOurChain) {
    return <p className="text-sm text-secondary">Switch your wallet to {chain.label} from the wallet menu.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] font-mono uppercase tracking-[0.15em] text-tertiary">{chain.label}</div>
        <div className="text-sm font-mono tabular-nums">
          <span className="text-tertiary">worth now </span>
          <span className="text-primary font-bold">{fmtUsdg(totalWorth)} USDG</span>
        </div>
      </div>
      {balances.isLoading || states.isLoading ? (
        <p className="text-sm text-tertiary">Reading the chain…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-secondary">
          No shares on this chain yet. Pick a market on <Link href="/app" className="text-atnx-cyan">Markets</Link> and buy UP or DOWN.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.m.id} className="rounded-2xl border border-surface bg-surface p-3.5">
              <div className="flex items-center gap-3">
                {r.m.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.m.thumbnailUrl} alt="" className="w-10 h-10 rounded-lg object-cover border border-surface bg-black shrink-0" />
                ) : (
                  <div className="w-10 h-10 rounded-lg border border-surface bg-elevated shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <Link href={`/app/markets/${r.m.atnxMarketId}`} className="text-sm font-bold text-primary truncate block hover:text-atnx-cyan">
                    {r.m.name}
                  </Link>
                  <div className="text-[11px] text-tertiary font-mono tabular-nums">
                    {r.resolved ? (
                      <span className={r.winner === "up" ? "text-atnx-cyan" : "text-atnx-magenta"}>
                        resolved {r.winner.toUpperCase()} at VI {Math.round(r.resolvedVi)}
                      </span>
                    ) : (
                      <>
                        VI {Math.round(r.m.currentVi)} · bounds {r.m.lower}–{r.m.upper}
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-2.5 space-y-1.5">
                {r.positions.map((p) => (
                  <div key={p.side} className="flex items-center justify-between gap-3 text-xs font-mono tabular-nums">
                    <span className={p.side === "up" ? "text-atnx-cyan" : "text-atnx-magenta"}>
                      {fmtUsdg(p.shares)} {p.side.toUpperCase()}
                      {!r.resolved && <span className="text-tertiary"> @ {fmtCents(p.price)}</span>}
                    </span>
                    {r.resolved ? (
                      p.won ? (
                        <button
                          type="button"
                          disabled={busy === `${r.m.id}-${p.side}`}
                          onClick={() => redeem(r.m.onchainMarketId!, `${r.m.id}-${p.side}`)}
                          className="h-7 px-3 rounded-lg btn-cyan font-bold cursor-pointer disabled:opacity-50"
                        >
                          {busy === `${r.m.id}-${p.side}` ? "Redeeming…" : `Redeem ${fmtUsdg(p.worth)} USDG`}
                        </button>
                      ) : (
                        <span className="text-tertiary">lost</span>
                      )
                    ) : (
                      <span className="text-primary">sells for {fmtUsdg(p.worth)} USDG</span>
                    )}
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
