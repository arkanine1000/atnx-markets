"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useAccount, useConfig, useConnect, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { openBoundedMarketAction } from "@/app/app/actions/bm";
import { Card, Segmented } from "@/components/ui";
import { boundedViMarketsAbi, mockUsdgAbi } from "@/lib/bm/abi";
import { bounds } from "@/lib/bm/bounds";
import { isDeployed, txUrl } from "@/lib/bm/chains";
import { price as poolPrice, quoteBuy, quoteSell, type Side } from "@/lib/bm/fpmm";
import type { BmMarketRow } from "@/lib/supabase/database-bm";
import { fmtCents, fmtUsdg, parseUsdg, shortHash } from "./format";
import { liveRow, resolvedRows, useBmChain, useOnchainMarket } from "./useBounded";

// The order ticket for a bounded market: UP or DOWN, an amount of mock
// USDG, a quote from the pool, then approve (once) and buy; or sell what
// you hold. When no bounded market is open on the wallet's chain, the
// ticket offers to open one from the current VI. After a resolution it
// offers the redeem.

const QUICK = [10, 50, 100, 500];
const SLIPPAGE_BPS = 100n; // 1% below the quote

interface Props {
  atnxMarketId: string;
  name: string;
  score: number;
  scoring?: boolean;
  bounded: BmMarketRow[];
  initialSide?: Side;
  onToast?: (message: string, detail: string | undefined, type: Side) => void;
}

export function BoundedTicket({ atnxMarketId, name, score, scoring = false, bounded, initialSide = "up", onToast }: Props) {
  const router = useRouter();
  const { chain, onOurChain } = useBmChain();
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const config = useConfig();

  const row = liveRow(bounded, chain.key);
  const resolved = resolvedRows(bounded, chain.key);
  const oc = useOnchainMarket(chain, row);

  const [side, setSide] = useState<Side>(initialSide);
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("25");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [opening, startOpening] = useTransition();

  // A row still opening on chain: re-read the page until it is open.
  useEffect(() => {
    if (!row || row.state === "open") return;
    const t = setInterval(() => router.refresh(), 8_000);
    return () => clearInterval(t);
  }, [row, router]);

  const units = useMemo(() => parseUsdg(amount), [amount]);
  const held = side === "up" ? oc.up : oc.down;

  const quote = useMemo(() => {
    if (!oc.pools || !units || units <= 0n) return null;
    if (mode === "buy") {
      const q = quoteBuy(oc.pools, side, units, oc.feeBps);
      const before = poolPrice(oc.pools, side);
      const after = poolPrice(q.after, side);
      return { kind: "buy" as const, shares: q.shares, fee: q.fee, avg: q.shares > 0n ? Number(units) / Number(q.shares) : 0, before, after };
    }
    const q = quoteSell(oc.pools, side, units, oc.feeBps);
    const before = poolPrice(oc.pools, side);
    const after = poolPrice(q.after, side);
    return { kind: "sell" as const, payout: q.payout, fee: q.fee, avg: units > 0n ? Number(q.payout) / Number(units) : 0, before, after };
  }, [oc.pools, oc.feeBps, units, side, mode]);

  const connector = connectors.find((c) => c.type === "injected") ?? connectors[0];

  async function run(label: string, fn: () => Promise<`0x${string}`>, toast: [string, string | undefined]) {
    setBusy(label);
    setError(null);
    try {
      const hash = await fn();
      setLastTx(hash);
      await waitForTransactionReceipt(config, { hash, chainId: chain.chainId });
      oc.refetch();
      onToast?.(toast[0], toast[1], side);
      return true;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      setError(msg.split("\n")[0].slice(0, 140));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    if (!oc.id || !units || units <= 0n || !quote || !address) return;
    const id = oc.id;
    if (quote.kind === "buy") {
      if (oc.allowance < units) {
        const ok = await run(
          "Approving…",
          () =>
            writeContractAsync({
              address: chain.usdg,
              abi: mockUsdgAbi,
              functionName: "approve",
              args: [chain.markets, 2n ** 256n - 1n],
              chainId: chain.chainId,
            }),
          ["USDG approved", "You can buy now"],
        );
        if (!ok) return;
      }
      const minShares = (quote.shares * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      await run(
        "Buying…",
        () =>
          writeContractAsync({
            address: chain.markets,
            abi: boundedViMarketsAbi,
            functionName: "buy",
            args: [id, side === "up" ? 0 : 1, units, minShares],
            chainId: chain.chainId,
          }),
        [`Bought ${fmtUsdg(quote.shares)} ${side.toUpperCase()}`, `${name} · ${fmtUsdg(units)} USDG`],
      );
    } else {
      const minReturn = (quote.payout * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      await run(
        "Selling…",
        () =>
          writeContractAsync({
            address: chain.markets,
            abi: boundedViMarketsAbi,
            functionName: "sell",
            args: [id, side === "up" ? 0 : 1, units, minReturn],
            chainId: chain.chainId,
          }),
        [`Sold ${fmtUsdg(units)} ${side.toUpperCase()}`, `${name} · ${fmtUsdg(quote.payout)} USDG back`],
      );
    }
  }

  function openMarket() {
    setError(null);
    startOpening(async () => {
      const r = await openBoundedMarketAction(atnxMarketId, chain.key, address ?? "");
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  }

  // ---------------------------------------------------------------- render

  const header = (
    <div className="flex items-center justify-between mb-3">
      <div className="text-[10px] font-mono uppercase tracking-[0.15em] text-tertiary">UP / DOWN · {chain.short}</div>
      {row && oc.priceUp !== null && (
        <div className="text-[11px] font-mono tabular-nums flex items-center gap-2">
          <span className="text-atnx-cyan">UP {fmtCents(oc.priceUp)}</span>
          <span className="text-atnx-magenta">DOWN {fmtCents(1 - oc.priceUp)}</span>
        </div>
      )}
    </div>
  );

  if (!isDeployed(chain)) {
    return (
      <Card className="p-4">
        {header}
        <p className="text-xs text-secondary">The contracts are not deployed on {chain.label} yet.</p>
      </Card>
    );
  }

  if (!isConnected || !address) {
    return (
      <Card className="p-4">
        {header}
        {row && (
          <BoundsLine row={row} />
        )}
        <button
          type="button"
          onClick={() => connector && connect({ connector })}
          disabled={!connector || connecting}
          className="btn-cyan w-full h-11 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50"
        >
          {connecting ? "Connecting…" : connector ? "Connect wallet to trade" : "No wallet extension found"}
        </button>
        <p className="text-[11px] text-tertiary mt-2">
          Testnet only. Shares settle in mock USDG, which has no value; mint it from the wallet menu.
        </p>
      </Card>
    );
  }

  if (!onOurChain) {
    return (
      <Card className="p-4">
        {header}
        <p className="text-xs text-secondary mb-3">Your wallet is on another network.</p>
        <button
          type="button"
          onClick={() => switchChain({ chainId: chain.chainId })}
          disabled={switching}
          className="btn-cyan w-full h-11 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50"
        >
          {switching ? "Switching…" : `Switch to ${chain.label}`}
        </button>
      </Card>
    );
  }

  if (!row) {
    const b = score > 0 ? bounds(score) : null;
    return (
      <Card className="p-4">
        {header}
        {resolved.length > 0 && <RedeemList rows={resolved} chainKey={chain.key} onDone={oc.refetch} />}
        {scoring ? (
          <p className="text-xs text-secondary">The first score is still being computed. A market can open once it is live.</p>
        ) : b ? (
          <>
            <p className="text-xs text-secondary mb-3">
              No UP/DOWN market is open on {name} here. Open one from the current VI of <span className="text-primary font-mono">{Math.round(score)}</span>:
              UP pays at <span className="text-atnx-cyan font-mono">{b.upper}</span>, DOWN pays at <span className="text-atnx-magenta font-mono">{b.lower}</span>.
              The treasury seeds the pool.
            </p>
            <button
              type="button"
              onClick={openMarket}
              disabled={opening}
              className="btn-cyan w-full h-11 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50"
            >
              {opening ? "Opening on chain…" : "Open UP/DOWN market"}
            </button>
          </>
        ) : (
          <p className="text-xs text-secondary">This market has no score yet.</p>
        )}
        {error && <p className="text-xs text-atnx-magenta mt-2">{error}</p>}
      </Card>
    );
  }

  if (row.state !== "open" || !oc.pools) {
    return (
      <Card className="p-4">
        {header}
        <BoundsLine row={row} />
        <p className="text-xs text-secondary animate-pulse">
          {row.state === "pending" ? "Opening on chain…" : row.state === "resolving" ? "Resolving…" : "Loading the pool…"}
        </p>
        {oc.error && <p className="text-[11px] text-atnx-magenta mt-2">{oc.error.message.split("\n")[0]}</p>}
      </Card>
    );
  }

  const insufficient = mode === "buy" ? !!units && units > oc.usdg : !!units && units > held;
  const canSubmit = !!units && units > 0n && !!quote && !insufficient && !busy && (quote.kind === "buy" ? quote.shares > 0n : quote.payout > 0n);
  const isUp = side === "up";

  return (
    <Card className="p-4">
      {header}
      <BoundsLine row={row} />

      <Segmented
        ariaLabel="Side"
        value={side}
        onChange={(v) => setSide(v as Side)}
        options={[
          { value: "up", label: `UP ${oc.priceUp !== null ? fmtCents(oc.priceUp) : ""}` },
          { value: "down", label: `DOWN ${oc.priceUp !== null ? fmtCents(1 - oc.priceUp) : ""}` },
        ]}
        className="w-full mb-3"
      />

      <div className="flex items-center justify-between text-[11px] mb-1">
        <div className="inline-flex rounded-full border border-surface overflow-hidden">
          {(["buy", "sell"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setAmount(m === "sell" ? fmtUsdg(held).replace(/,/g, "") : "25");
              }}
              className={`px-3 py-1 font-bold cursor-pointer transition-colors ${
                mode === m ? "bg-elevated text-primary" : "text-tertiary hover:text-primary"
              }`}
            >
              {m === "buy" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
        <span className="text-tertiary font-mono tabular-nums">
          {mode === "buy" ? `${fmtUsdg(oc.usdg)} USDG` : `${fmtUsdg(held)} ${side.toUpperCase()}`}
        </span>
      </div>

      <div className="flex items-center gap-2 rounded-xl border border-surface bg-elevated px-3 h-11">
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="flex-1 bg-transparent outline-none font-mono text-base text-primary tabular-nums"
          aria-label={mode === "buy" ? "Amount of USDG" : "Shares to sell"}
        />
        <span className="text-[11px] font-mono text-tertiary">{mode === "buy" ? "USDG" : side.toUpperCase()}</span>
      </div>
      <div className="flex gap-1.5 mt-2">
        {mode === "buy"
          ? QUICK.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setAmount(String(q))}
                className="flex-1 h-7 rounded-lg border border-surface text-[11px] font-mono text-secondary hover:text-primary hover:border-atnx-cyan/40 cursor-pointer"
              >
                {q}
              </button>
            ))
          : [25, 50, 100].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setAmount(fmtUsdg((held * BigInt(p)) / 100n, 6).replace(/,/g, ""))}
                className="flex-1 h-7 rounded-lg border border-surface text-[11px] font-mono text-secondary hover:text-primary hover:border-atnx-cyan/40 cursor-pointer"
              >
                {p}%
              </button>
            ))}
      </div>

      {quote && units && units > 0n && (
        <dl className="mt-3 space-y-1 text-[11px] font-mono tabular-nums">
          {quote.kind === "buy" ? (
            <>
              <Row k="You get" v={`${fmtUsdg(quote.shares)} ${side.toUpperCase()}`} />
              <Row k="Avg price" v={fmtCents(quote.avg)} />
              <Row k="Pays if right" v={`${fmtUsdg(quote.shares)} USDG`} />
            </>
          ) : (
            <>
              <Row k="You get" v={`${fmtUsdg(quote.payout)} USDG`} />
              <Row k="Avg price" v={fmtCents(quote.avg)} />
            </>
          )}
          <Row k={`Fee (${Number(oc.feeBps) / 100}%)`} v={`${fmtUsdg(quote.fee)} USDG`} />
          <Row k="Price" v={`${fmtCents(quote.before)} → ${fmtCents(quote.after)}`} />
        </dl>
      )}

      {insufficient && (
        <p className="text-[11px] text-atnx-magenta mt-2">
          {mode === "buy" ? "Not enough USDG. Mint some from the wallet menu." : "You do not hold that many shares."}
        </p>
      )}
      {error && <p className="text-[11px] text-atnx-magenta mt-2 break-words">{error}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        className={`mt-3 w-full h-11 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-40 ${isUp ? "btn-cyan" : "btn-magenta"}`}
      >
        {busy ??
          (mode === "buy"
            ? oc.allowance < (units ?? 0n)
              ? `Approve USDG, then buy ${side.toUpperCase()}`
              : `Buy ${side.toUpperCase()}`
            : `Sell ${side.toUpperCase()}`)}
      </button>

      {lastTx && (
        <a href={txUrl(chain, lastTx)} target="_blank" rel="noreferrer" className="block mt-2 text-[11px] text-secondary hover:text-atnx-cyan font-mono">
          Last tx {shortHash(lastTx)} ↗
        </a>
      )}

      {(oc.up > 0n || oc.down > 0n) && (
        <div className="mt-3 pt-3 border-t border-surface text-[11px] font-mono tabular-nums space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-tertiary">Your shares</div>
          {oc.up > 0n && <Row k="UP" v={`${fmtUsdg(oc.up)} · worth ${fmtUsdg(quoteSell(oc.pools, "up", oc.up, oc.feeBps).payout)}`} />}
          {oc.down > 0n && <Row k="DOWN" v={`${fmtUsdg(oc.down)} · worth ${fmtUsdg(quoteSell(oc.pools, "down", oc.down, oc.feeBps).payout)}`} />}
        </div>
      )}

      {resolved.length > 0 && (
        <div className="mt-3 pt-3 border-t border-surface">
          <RedeemList rows={resolved} chainKey={chain.key} onDone={oc.refetch} />
        </div>
      )}

      <p className="text-[10px] text-tertiary mt-3 leading-relaxed">
        Resolves when the VI holds at or past a bound for three prints. Until then, sell to take profit or cut a loss.{" "}
        <Link href="/app/portfolio" className="hover:text-atnx-cyan">Portfolio</Link>
      </p>
    </Card>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-tertiary">{k}</dt>
      <dd className="text-primary">{v}</dd>
    </div>
  );
}

function BoundsLine({ row }: { row: BmMarketRow }) {
  return (
    <div className="flex items-center justify-between text-[11px] font-mono tabular-nums mb-3">
      <span>
        <span className="text-atnx-magenta">DOWN pays @ {row.lower_bound}</span>
      </span>
      <span className="text-tertiary">from VI {Math.round(row.start_vi)}</span>
      <span>
        <span className="text-atnx-cyan">UP pays @ {row.upper_bound}</span>
      </span>
    </div>
  );
}

// Resolved markets on this chain where the viewer holds winning shares.
function RedeemList({ rows, chainKey, onDone }: { rows: BmMarketRow[]; chainKey: string; onDone: () => void }) {
  const { chain } = useBmChain();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const config = useConfig();
  const [busy, setBusy] = useState<string | null>(null);
  const ids = useMemo(() => rows.map((r) => BigInt(r.onchain_market_id!)), [rows]);
  const balances = useReadContract({
    address: chain.markets,
    abi: boundedViMarketsAbi,
    functionName: "balancesOf",
    args: address ? [address, ids] : undefined,
    chainId: chain.chainId,
    query: { enabled: !!address && ids.length > 0 && chain.key === chainKey, refetchInterval: 10_000 },
  });
  const claimable = rows
    .map((r, i) => {
      const b = balances.data?.[i];
      const win = r.resolved_side === "up" ? b?.[0] ?? 0n : b?.[1] ?? 0n;
      return { row: r, win };
    })
    .filter((x) => x.win > 0n);
  if (claimable.length === 0) return null;

  async function redeem(row: BmMarketRow) {
    setBusy(row.id);
    try {
      const hash = await writeContractAsync({
        address: chain.markets,
        abi: boundedViMarketsAbi,
        functionName: "redeem",
        args: [BigInt(row.onchain_market_id!)],
        chainId: chain.chainId,
      });
      await waitForTransactionReceipt(config, { hash, chainId: chain.chainId });
      void balances.refetch();
      onDone();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-[10px] font-mono uppercase tracking-wider text-tertiary">Resolved · redeem</div>
      {claimable.map(({ row, win }) => (
        <div key={row.id} className="flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums">
          <span className={row.resolved_side === "up" ? "text-atnx-cyan" : "text-atnx-magenta"}>
            {row.resolved_side?.toUpperCase()} won at VI {Math.round(row.resolved_vi ?? 0)}
          </span>
          <button
            type="button"
            disabled={busy === row.id}
            onClick={() => redeem(row)}
            className="h-7 px-3 rounded-lg btn-cyan font-bold cursor-pointer disabled:opacity-50"
          >
            {busy === row.id ? "Redeeming…" : `Redeem ${fmtUsdg(win)} USDG`}
          </button>
        </div>
      ))}
    </div>
  );
}
