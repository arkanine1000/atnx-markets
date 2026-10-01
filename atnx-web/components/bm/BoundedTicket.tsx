"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useAccount, useConfig, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { openBoundedMarketAction } from "@/app/app/actions/bm";
import { Card } from "@/components/ui";
import { boundedViMarketsAbi, mockUsdgAbi } from "@/lib/bm/abi";
import { bounds } from "@/lib/bm/bounds";
import { USDG_UNIT, isDeployed, txUrl } from "@/lib/bm/chains";
import { quoteBuy, quoteSell, type Pools, type Side } from "@/lib/bm/fpmm";
import type { BmMarketRow } from "@/lib/supabase/database-bm";
import { ConnectButton } from "./ConnectButton";
import { fmtCents, fmtUsdg, parseUsdg, shortHash } from "./format";
import { liveRow, resolvedRows, useBmChain, useOnchainMarket } from "./useBounded";

// The ticket, for people who have never traded: pick a side, type an
// amount, read one line that says what you get if you are right, press
// the button. Everything else (shares, average price, fee, price impact)
// sits behind "Details". Selling appears only once you hold shares.

const QUICK = [10, 50, 100];
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

function priceOf(p: Pools, side: Side): number {
  const total = Number(p.poolUp + p.poolDown);
  if (total === 0) return 0.5;
  const up = Number(p.poolDown) / total;
  return side === "up" ? up : 1 - up;
}

export function BoundedTicket({ atnxMarketId, name, score, scoring = false, bounded, initialSide = "up", onToast }: Props) {
  const router = useRouter();
  const { chain, onOurChain } = useBmChain();
  const { address, isConnected } = useAccount();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const config = useConfig();

  const row = liveRow(bounded, chain.key);
  const resolved = resolvedRows(bounded, chain.key);
  const oc = useOnchainMarket(chain, row);

  const [side, setSide] = useState<Side>(initialSide);
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("25");
  const [details, setDetails] = useState(false);
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
  const holdsAnything = oc.up > 0n || oc.down > 0n;

  const quote = useMemo(() => {
    if (!oc.pools || !units || units <= 0n) return null;
    const before = priceOf(oc.pools, side);
    if (mode === "buy") {
      const q = quoteBuy(oc.pools, side, units, oc.feeBps);
      return { kind: "buy" as const, shares: q.shares, fee: q.fee, avg: q.shares > 0n ? Number(units) / Number(q.shares) : 0, before, after: priceOf(q.after, side) };
    }
    const q = quoteSell(oc.pools, side, units, oc.feeBps);
    return { kind: "sell" as const, payout: q.payout, fee: q.fee, avg: units > 0n ? Number(q.payout) / Number(units) : 0, before, after: priceOf(q.after, side) };
  }, [oc.pools, oc.feeBps, units, side, mode]);

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
      setError(friendly((err as Error).message ?? String(err)));
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
          "Approving USDG…",
          () => writeContractAsync({ address: chain.usdg, abi: mockUsdgAbi, functionName: "approve", args: [chain.markets, 2n ** 256n - 1n], chainId: chain.chainId }),
          ["USDG approved", "One more confirmation to buy"],
        );
        if (!ok) return;
      }
      const minShares = (quote.shares * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      const ok = await run(
        "Buying…",
        () => writeContractAsync({ address: chain.markets, abi: boundedViMarketsAbi, functionName: "buy", args: [id, side === "up" ? 0 : 1, units, minShares], chainId: chain.chainId }),
        [`Bought ${side.toUpperCase()}`, `${fmtUsdg(quote.shares)} shares of ${name} for ${fmtUsdg(units)} USDG`],
      );
      if (ok) setAmount("25");
    } else {
      const minReturn = (quote.payout * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      const ok = await run(
        "Selling…",
        () => writeContractAsync({ address: chain.markets, abi: boundedViMarketsAbi, functionName: "sell", args: [id, side === "up" ? 0 : 1, units, minReturn], chainId: chain.chainId }),
        [`Sold ${side.toUpperCase()}`, `${fmtUsdg(quote.payout)} USDG back`],
      );
      if (ok) {
        setMode("buy");
        setAmount("25");
      }
    }
  }

  async function mint() {
    if (!address) return;
    await run(
      "Minting…",
      () => writeContractAsync({ address: chain.usdg, abi: mockUsdgAbi, functionName: "mint", args: [address, 1_000n * USDG_UNIT], chainId: chain.chainId }),
      ["Minted 1,000 USDG", "Testnet money, no value"],
    );
  }

  function openMarket() {
    setError(null);
    startOpening(async () => {
      const r = await openBoundedMarketAction(atnxMarketId, chain.key, address ?? "");
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  }

  function startSelling(s: Side) {
    setSide(s);
    setMode("sell");
    const h = s === "up" ? oc.up : oc.down;
    setAmount(fmtUsdg(h, 6).replace(/,/g, ""));
    setError(null);
  }

  // ---------------------------------------------------------------- states

  if (!isDeployed(chain)) {
    return (
      <Card className="p-4">
        <p className="text-sm text-secondary">Trading is not live on {chain.label} yet.</p>
      </Card>
    );
  }

  if (!isConnected || !address) {
    return (
      <Card className="p-4 sm:p-5">
        {row ? <Question name={name} row={row} /> : <p className="text-sm text-secondary mb-4">Connect a wallet to trade on {name}.</p>}
        <ConnectButton label="Connect wallet to trade" />
        <p className="text-[11px] text-tertiary mt-3">Testnet only. Everything settles in mock USDG, which has no value.</p>
      </Card>
    );
  }

  if (!onOurChain) {
    return (
      <Card className="p-4 sm:p-5">
        <p className="text-sm text-secondary mb-4">Your wallet is on another network.</p>
        <button type="button" onClick={() => switchChain({ chainId: chain.chainId })} disabled={switching} className="btn-cyan w-full h-12 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50">
          {switching ? "Switching…" : `Switch to ${chain.label}`}
        </button>
      </Card>
    );
  }

  if (!row) {
    const b = score > 0 ? bounds(score) : null;
    return (
      <Card className="p-4 sm:p-5">
        {resolved.length > 0 && <RedeemList rows={resolved} chainKey={chain.key} onDone={oc.refetch} />}
        {scoring ? (
          <p className="text-sm text-secondary">The first score is still being computed. A market can open once it is live.</p>
        ) : b ? (
          <>
            <p className="text-sm text-primary font-bold mb-1">No market open on {name} yet.</p>
            <p className="text-sm text-secondary mb-4">
              Open one from today&apos;s index of {Math.round(score)}: <span className="text-atnx-cyan">UP</span> wins if it reaches{" "}
              <span className="tabular-nums font-bold text-primary">{b.upper}</span>, <span className="text-atnx-magenta">DOWN</span> wins if it falls to{" "}
              <span className="tabular-nums font-bold text-primary">{b.lower}</span>. The treasury seeds the pool.
            </p>
            <button type="button" onClick={openMarket} disabled={opening} className="btn-cyan w-full h-12 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50">
              {opening ? "Opening on chain…" : "Open the market"}
            </button>
          </>
        ) : (
          <p className="text-sm text-secondary">This market has no score yet.</p>
        )}
        {error && <p className="text-xs text-atnx-magenta mt-3">{error}</p>}
      </Card>
    );
  }

  if (row.state !== "open" || !oc.pools) {
    return (
      <Card className="p-4 sm:p-5">
        <Question name={name} row={row} />
        <p className="text-sm text-secondary animate-pulse">{row.state === "pending" ? "Opening on chain…" : row.state === "resolving" ? "Resolving…" : "Loading the pool…"}</p>
        {oc.error && <p className="text-[11px] text-atnx-magenta mt-2">{oc.error.message.split("\n")[0]}</p>}
      </Card>
    );
  }

  // ------------------------------------------------------------- the ticket

  const isUp = side === "up";
  const pools = oc.pools;
  const insufficient = mode === "buy" ? !!units && units > oc.usdg : !!units && units > held;
  const canSubmit = !!units && units > 0n && !!quote && !insufficient && !busy && (quote.kind === "buy" ? quote.shares > 0n : quote.payout > 0n);
  const stake = units ?? 0n;
  const profit = quote?.kind === "buy" ? quote.shares - stake : 0n;
  const profitPct = quote?.kind === "buy" && stake > 0n ? (Number(profit) / Number(stake)) * 100 : 0;
  const needsApproval = mode === "buy" && !!units && oc.allowance < units;
  const accent = isUp ? "btn-cyan" : "btn-magenta";
  const maxBuy = fmtUsdg((oc.usdg * 99n) / 100n, 2).replace(/,/g, "");

  return (
    <Card className="p-4 sm:p-5">
      {mode === "buy" ? (
        <>
          <Question name={name} row={row} />
          <div className="grid grid-cols-2 gap-2 mb-4" role="radiogroup" aria-label="Side">
            <SideButton side="up" price={priceOf(pools, "up")} selected={isUp} onClick={() => setSide("up")} />
            <SideButton side="down" price={priceOf(pools, "down")} selected={!isUp} onClick={() => setSide("down")} />
          </div>
        </>
      ) : (
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-bold text-primary">
            Sell <span className={isUp ? "text-atnx-cyan" : "text-atnx-magenta"}>{side.toUpperCase()}</span>
          </div>
          <button type="button" onClick={() => { setMode("buy"); setAmount("25"); }} className="text-xs text-secondary hover:text-primary cursor-pointer">
            Back to buying
          </button>
        </div>
      )}

      <div className="flex items-center justify-between text-xs mb-1.5">
        <span className="text-secondary">{mode === "buy" ? "Amount" : "Shares to sell"}</span>
        <span className="text-tertiary">
          {mode === "buy" ? (
            <>You have <span className="tabular-nums font-bold text-secondary">{fmtUsdg(oc.usdg, 0)}</span> USDG</>
          ) : (
            <>You hold <span className="tabular-nums font-bold text-secondary">{fmtUsdg(held)}</span> {side.toUpperCase()}</>
          )}
        </span>
      </div>
      <label className="flex items-center gap-2 rounded-xl border border-surface bg-elevated px-3 h-12 focus-within:border-atnx-cyan/60">
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="flex-1 bg-transparent outline-none font-mono text-lg text-primary tabular-nums min-w-0"
          aria-label={mode === "buy" ? "Amount of USDG" : "Shares to sell"}
        />
        <span className="text-xs text-tertiary">{mode === "buy" ? "USDG" : side.toUpperCase()}</span>
      </label>
      <div className="flex gap-1.5 mt-2">
        {mode === "buy"
          ? [...QUICK.map((q) => [String(q), String(q)] as const), ["Max", maxBuy] as const].map(([label, value]) => (
              <button key={label} type="button" onClick={() => setAmount(value)} className="flex-1 h-8 rounded-lg border border-surface text-xs text-secondary hover:text-primary hover:border-atnx-cyan/40 cursor-pointer">
                {label}
              </button>
            ))
          : [25, 50, 100].map((p) => (
              <button key={p} type="button" onClick={() => setAmount(fmtUsdg((held * BigInt(p)) / 100n, 6).replace(/,/g, ""))} className="flex-1 h-8 rounded-lg border border-surface text-xs text-secondary hover:text-primary hover:border-atnx-cyan/40 cursor-pointer">
                {p === 100 ? "All" : `${p}%`}
              </button>
            ))}
      </div>

      {quote && units && units > 0n && (
        <div className="mt-4 rounded-xl bg-elevated/60 border border-surface px-3 py-2.5">
          {quote.kind === "buy" ? (
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-secondary">If {side.toUpperCase()} wins you get</span>
              <span className="text-right">
                <span className="font-display font-bold text-xl tabular-nums text-primary">{fmtUsdg(quote.shares)}</span>
                <span className="text-xs text-tertiary"> USDG</span>
                <span className={`block text-[11px] tabular-nums ${profit >= 0n ? "text-atnx-cyan" : "text-atnx-magenta"}`}>
                  {profit >= 0n ? "+" : ""}{fmtUsdg(profit)} ({profitPct >= 0 ? "+" : ""}{profitPct.toFixed(0)}%)
                </span>
              </span>
            </div>
          ) : (
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-secondary">You get back</span>
              <span>
                <span className="font-display font-bold text-xl tabular-nums text-primary">{fmtUsdg(quote.payout)}</span>
                <span className="text-xs text-tertiary"> USDG</span>
              </span>
            </div>
          )}
          <button type="button" onClick={() => setDetails((v) => !v)} aria-expanded={details} className="mt-1.5 text-[11px] text-tertiary hover:text-primary cursor-pointer">
            {details ? "▾ Hide details" : "▸ Details"}
          </button>
          {details && (
            <dl className="mt-1.5 pt-2 border-t border-surface space-y-1 text-[11px]">
              {quote.kind === "buy" && <Row k="Shares" v={`${fmtUsdg(quote.shares)} ${side.toUpperCase()}`} />}
              <Row k="Average price" v={`${fmtCents(quote.avg)} a share`} />
              <Row k={`Fee (${Number(oc.feeBps) / 100}%)`} v={`${fmtUsdg(quote.fee)} USDG`} />
              <Row k="Price after" v={`${fmtCents(quote.before)} → ${fmtCents(quote.after)}`} />
            </dl>
          )}
        </div>
      )}

      {insufficient && mode === "buy" && (
        <div className="mt-3 flex items-center justify-between gap-3 text-xs">
          <span className="text-atnx-magenta">Not enough USDG.</span>
          <button type="button" onClick={mint} disabled={!!busy} className="h-8 px-3 rounded-lg border border-surface text-secondary hover:text-primary cursor-pointer disabled:opacity-50">
            {busy === "Minting…" ? "Minting…" : "Mint 1,000 test USDG"}
          </button>
        </div>
      )}
      {insufficient && mode === "sell" && <p className="text-xs text-atnx-magenta mt-3">You do not hold that many shares.</p>}
      {error && <p className="text-xs text-atnx-magenta mt-3 break-words">{error}</p>}

      <button type="button" onClick={submit} disabled={!canSubmit} className={`mt-4 w-full h-12 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-40 ${accent}`}>
        {busy ??
          (mode === "buy"
            ? needsApproval
              ? `Approve, then buy ${side.toUpperCase()}`
              : `Buy ${side.toUpperCase()}${units && units > 0n ? ` for ${fmtUsdg(units, 0)} USDG` : ""}`
            : `Sell ${units && units > 0n ? `${fmtUsdg(units)} ` : ""}${side.toUpperCase()}`)}
      </button>
      {needsApproval && !busy && <p className="text-[11px] text-tertiary mt-2">First time only: your wallet asks you to let this market use your USDG, then to buy.</p>}
      {lastTx && (
        <a href={txUrl(chain, lastTx)} target="_blank" rel="noreferrer" className="block mt-2 text-[11px] text-tertiary hover:text-atnx-cyan">
          View last transaction {shortHash(lastTx)} ↗
        </a>
      )}

      {holdsAnything && mode === "buy" && (
        <div className="mt-4 pt-3 border-t border-surface space-y-2">
          {(["up", "down"] as const).map((s) => {
            const h = s === "up" ? oc.up : oc.down;
            if (h === 0n) return null;
            const worth = quoteSell(pools, s, h, oc.feeBps).payout;
            return (
              <div key={s} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-secondary">
                  You hold <span className="tabular-nums font-bold text-primary">{fmtUsdg(h)}</span> <span className={s === "up" ? "text-atnx-cyan" : "text-atnx-magenta"}>{s.toUpperCase()}</span>
                  <span className="text-tertiary"> · sells for {fmtUsdg(worth)} USDG</span>
                </span>
                <button type="button" onClick={() => startSelling(s)} className="h-8 px-3 rounded-lg border border-surface text-secondary hover:text-primary cursor-pointer shrink-0">
                  Sell
                </button>
              </div>
            );
          })}
        </div>
      )}

      {resolved.length > 0 && (
        <div className="mt-4 pt-3 border-t border-surface">
          <RedeemList rows={resolved} chainKey={chain.key} onDone={oc.refetch} />
        </div>
      )}
    </Card>
  );
}

// "Will Halloween's index reach 1300 or fall to 850 first?"
function Question({ name, row }: { name: string; row: BmMarketRow }) {
  return (
    <p className="text-sm font-bold text-primary leading-snug mb-3">
      Will {name}&apos;s index reach <span className="text-atnx-cyan tabular-nums">{row.upper_bound}</span> or fall to{" "}
      <span className="text-atnx-magenta tabular-nums">{row.lower_bound}</span> first?
    </p>
  );
}

function SideButton({ side, price, selected, onClick }: { side: Side; price: number; selected: boolean; onClick: () => void }) {
  const up = side === "up";
  const ring = up ? "border-atnx-cyan shadow-[0_0_18px_rgba(0,212,255,0.25)]" : "border-atnx-magenta shadow-[0_0_18px_rgba(255,0,229,0.25)]";
  const tone = up ? "text-atnx-cyan" : "text-atnx-magenta";
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={`h-16 rounded-xl border bg-elevated flex flex-col items-center justify-center gap-0.5 cursor-pointer transition-all ${
        selected ? ring : "border-surface opacity-70 hover:opacity-100"
      }`}
    >
      <span className={`font-display font-bold text-lg leading-none ${tone}`}>{up ? "↗ UP" : "↘ DOWN"}</span>
      <span className="text-[11px] text-tertiary tabular-nums">{fmtCents(price)} a share</span>
    </button>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-tertiary">{k}</dt>
      <dd className="text-secondary tabular-nums">{v}</dd>
    </div>
  );
}

function friendly(msg: string): string {
  const m = msg.split("\n")[0];
  if (/rejected|denied|cancel/i.test(m)) return "Cancelled in the wallet.";
  if (/insufficient funds/i.test(m)) return "Not enough ETH for gas on this network.";
  if (/Slippage/i.test(m)) return "The price moved while you were confirming. Try again.";
  return m.slice(0, 140);
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
      const hash = await writeContractAsync({ address: chain.markets, abi: boundedViMarketsAbi, functionName: "redeem", args: [BigInt(row.onchain_market_id!)], chainId: chain.chainId });
      await waitForTransactionReceipt(config, { hash, chainId: chain.chainId });
      void balances.refetch();
      onDone();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2 mb-3">
      {claimable.map(({ row, win }) => (
        <div key={row.id} className="flex items-center justify-between gap-3 text-xs">
          <span className="text-secondary">
            An earlier market resolved <span className={row.resolved_side === "up" ? "text-atnx-cyan" : "text-atnx-magenta"}>{row.resolved_side?.toUpperCase()}</span>. You won.
          </span>
          <button type="button" disabled={busy === row.id} onClick={() => redeem(row)} className="h-8 px-3 rounded-lg btn-cyan text-xs font-bold cursor-pointer disabled:opacity-50 shrink-0">
            {busy === row.id ? "Redeeming…" : `Redeem ${fmtUsdg(win)} USDG`}
          </button>
        </div>
      ))}
    </div>
  );
}
