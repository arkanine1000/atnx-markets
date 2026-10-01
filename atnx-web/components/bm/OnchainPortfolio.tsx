"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAccount, useConfig, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { boundedViMarketsAbi, mockUsdgAbi } from "@/lib/bm/abi";
import { isDeployed } from "@/lib/bm/chains";
import { quoteSell } from "@/lib/bm/fpmm";
import type { BmMarketListing } from "@/lib/bm/listing";
import { Card, Chip, EmptyState, Readout, StatTile } from "@/components/ui";
import { ConnectButton } from "./ConnectButton";
import { fmtCents, fmtUsdg } from "./format";
import { useBmChain } from "./useBounded";

// The wallet's UP and DOWN shares across every bounded market on the
// chain it is connected to, read in two contract calls (balancesOf,
// getMarkets). Open positions show what a sell pays now; resolved ones
// offer the redeem. Nothing here is stored off-chain.

interface Position {
  market: BmMarketListing;
  side: "up" | "down";
  shares: bigint;
  price: number; // what one share trades at now, 0..1
  worth: bigint; // what a sell pays now, or the payout once resolved
  resolved: boolean;
  won: boolean;
  resolvedVi: number;
}

export function OnchainPortfolio({ markets }: { markets: BmMarketListing[] }) {
  const { chain, onOurChain } = useBmChain();
  const { address, isConnected } = useAccount();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const config = useConfig();
  const [busy, setBusy] = useState<string | null>(null);

  const onChain = useMemo(() => markets.filter((m) => m.chain === chain.key && m.onchainMarketId), [markets, chain.key]);
  const ids = useMemo(() => onChain.map((m) => BigInt(m.onchainMarketId!)), [onChain]);
  const ready = isDeployed(chain) && !!address;

  const balances = useReadContract({
    address: chain.markets,
    abi: boundedViMarketsAbi,
    functionName: "balancesOf",
    args: address ? [address, ids] : undefined,
    chainId: chain.chainId,
    query: { enabled: ready && ids.length > 0, refetchInterval: 10_000 },
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
  const usdg = useReadContract({
    address: chain.usdg,
    abi: mockUsdgAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: chain.chainId,
    query: { enabled: ready, refetchInterval: 10_000 },
  });
  const feeBps = fee.data !== undefined ? BigInt(fee.data) : 100n;

  const positions = useMemo<Position[]>(() => {
    if (!balances.data || !states.data) return [];
    const out: Position[] = [];
    onChain.forEach((m, i) => {
      const [up, down] = balances.data![i];
      const s = states.data![i];
      const pools = { poolUp: s.poolUp, poolDown: s.poolDown };
      const resolved = s.status === 2;
      const winner = s.winner === 0 ? "up" : "down";
      const total = Number(s.poolUp) + Number(s.poolDown);
      const priceUp = total > 0 ? Number(s.poolDown) / total : 0.5;
      for (const side of ["up", "down"] as const) {
        const shares = side === "up" ? up : down;
        if (shares === 0n) continue;
        const won = resolved && winner === side;
        out.push({
          market: m,
          side,
          shares,
          price: side === "up" ? priceUp : 1 - priceUp,
          worth: resolved ? (won ? shares : 0n) : quoteSell(pools, side, shares, feeBps).payout,
          resolved,
          won,
          resolvedVi: Number(s.resolvedViE2) / 100,
        });
      }
    });
    // Redeemable first, then open, then lost.
    return out.sort((a, b) => Number(b.won) - Number(a.won) || Number(a.resolved) - Number(b.resolved));
  }, [onChain, balances.data, states.data, feeBps]);

  const open = positions.filter((p) => !p.resolved);
  const redeemable = positions.filter((p) => p.won);
  const worth = open.reduce((a, p) => a + p.worth, 0n);
  const claim = redeemable.reduce((a, p) => a + p.worth, 0n);
  const cash = usdg.data ?? 0n;

  async function redeem(p: Position) {
    const key = `${p.market.id}-${p.side}`;
    setBusy(key);
    try {
      const hash = await writeContractAsync({
        address: chain.markets,
        abi: boundedViMarketsAbi,
        functionName: "redeem",
        args: [BigInt(p.market.onchainMarketId!)],
        chainId: chain.chainId,
      });
      await waitForTransactionReceipt(config, { hash, chainId: chain.chainId });
      void balances.refetch();
      void usdg.refetch();
    } finally {
      setBusy(null);
    }
  }

  if (!isConnected || !address) {
    return (
      <EmptyState
        title="Connect a wallet to see your positions"
        body="UP and DOWN shares live in your wallet. One share pays 1 mock USDG if its side resolves."
        action={<ConnectButton pill label="Connect wallet" />}
      />
    );
  }
  if (!onOurChain) {
    return (
      <EmptyState
        title="Wrong network"
        body={`Your wallet is on a network this app does not use. Switch to ${chain.label} to see your positions.`}
        action={
          <button type="button" onClick={() => switchChain({ chainId: chain.chainId })} disabled={switching} className="text-xs px-5 py-2.5 rounded-full btn-magenta font-bold cursor-pointer disabled:opacity-60">
            {switching ? "Switching…" : `Switch to ${chain.label}`}
          </button>
        }
      />
    );
  }

  const loading = ids.length > 0 && (balances.isLoading || states.isLoading);

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 mb-6">
        <StatTile label="Positions worth" value={`${fmtUsdg(worth)} USDG`} hero sub={<span>what a sell pays now</span>} className="col-span-2 md:col-span-1" />
        <StatTile label="Cash" value={`${fmtUsdg(cash)} USDG`} sub={<span>mock USDG in the wallet</span>} />
        <StatTile label="Open" value={String(open.length)} sub={<span>{open.length === 1 ? "position" : "positions"} on {chain.short}</span>} />
        <StatTile
          label="To redeem"
          value={<span className={claim > 0n ? "text-atnx-cyan light:text-atnx-cyan-light" : ""}>{fmtUsdg(claim)} USDG</span>}
          sub={<span>{redeemable.length} resolved {redeemable.length === 1 ? "win" : "wins"}</span>}
        />
      </div>

      {loading ? (
        <EmptyState title="Reading the chain" body="Your shares are being looked up on the contract." />
      ) : positions.length === 0 ? (
        <EmptyState
          title="No positions yet"
          body="Pick a market and take a side. UP if you think attention reaches the upper bound first, DOWN if the lower."
          action={
            <Link href="/app" className="inline-block text-xs px-5 py-2.5 rounded-full btn-magenta font-bold">
              Browse markets
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {positions.map((p) => (
            <PositionCard key={`${p.market.id}-${p.side}`} p={p} busy={busy === `${p.market.id}-${p.side}`} onRedeem={() => redeem(p)} />
          ))}
        </div>
      )}
    </div>
  );
}

function PositionCard({ p, busy, onRedeem }: { p: Position; busy: boolean; onRedeem: () => void }) {
  const isUp = p.side === "up";
  const tone = isUp ? "text-atnx-cyan light:text-atnx-cyan-light" : "text-atnx-magenta light:text-atnx-magenta-light";
  const href = `/app/markets/${p.market.atnxMarketId}`;
  return (
    <Card className={`p-4 sm:p-5 ${p.resolved && !p.won ? "opacity-70" : "card-hover"}`}>
      <div className="flex items-start gap-3">
        {p.market.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.market.thumbnailUrl} alt="" className="w-12 h-12 rounded-xl object-cover border border-surface bg-black shrink-0" />
        ) : (
          <div className="w-12 h-12 rounded-xl border border-surface bg-elevated shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <Link href={href} className="font-bold text-primary text-[15px] hover:text-atnx-cyan transition-colors break-words">
            {p.market.name}
          </Link>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <Chip tone={isUp ? "cyan" : "magenta"}>{p.side.toUpperCase()}</Chip>
            {p.resolved ? (
              <span className="text-[11px] text-tertiary">
                resolved {p.won ? "in your favour" : "against you"} at VI {Math.round(p.resolvedVi)}
              </span>
            ) : (
              <span className="text-[11px] text-tertiary">
                pays at VI {isUp ? p.market.upper : p.market.lower}
              </span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={`font-display text-2xl font-bold leading-none tabular-nums ${p.resolved && !p.won ? "text-tertiary" : tone}`}>
            {fmtUsdg(p.worth)}
          </div>
          <div className="text-[11px] text-tertiary mt-1">{p.resolved ? (p.won ? "to redeem" : "lost") : "sells for"}</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mt-4 pt-3 border-t border-surface">
        <Readout label="Shares" value={fmtUsdg(p.shares)} valueClassName="text-primary" />
        <Readout label="Price now" value={p.resolved ? (p.won ? "1.00" : "0.00") : fmtCents(p.price)} valueClassName="text-primary" />
        <Readout label="Pays if right" value={`${fmtUsdg(p.shares)}`} valueClassName="text-atnx-yellow light:text-atnx-yellow-light" />
      </div>

      <div className="mt-3 pt-3 border-t border-surface flex items-center justify-between">
        <Link href={href} className="text-[11px] text-tertiary hover:text-atnx-cyan transition-colors">
          View market {"↗"}
        </Link>
        {p.resolved ? (
          p.won ? (
            <button type="button" onClick={onRedeem} disabled={busy} className="text-xs px-4 py-2 rounded-full btn-cyan font-bold cursor-pointer disabled:opacity-60">
              {busy ? "Redeeming…" : `Redeem ${fmtUsdg(p.worth)} USDG`}
            </button>
          ) : (
            <span className="text-xs text-tertiary">Nothing to redeem</span>
          )
        ) : (
          <Link href={href} className="text-xs px-4 py-2 rounded-full bg-atnx-magenta text-white font-bold shadow-[0_0_16px_rgba(255,0,229,0.25)] hover:brightness-110 transition">
            Trade
          </Link>
        )}
      </div>
    </Card>
  );
}
