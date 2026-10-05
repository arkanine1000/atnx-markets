"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { startSeriesAction } from "@/app/app/actions/rounds";
import { Card, Segmented } from "@/components/ui";
import { fmtCents, fmtUsdg, parseUsdg, shortHash } from "@/components/bm/format";
import { USDG_UNIT, solTxUrl } from "@/lib/bm/chains";
import { DpmError, feeSplit, mprUp, presalePrice, quoteBuy, type BuyQuote } from "@/lib/bm/dpm";
import { USDG_MINT, type RoundSide, type SeriesAccount } from "@/lib/bm/sol-shared";
import type { BmRoundRow, BmSeriesRow } from "@/lib/supabase/database-bm";
import { SolConnectButton } from "./SolConnectButton";
import {
  MOCK_HINT,
  asOpened,
  fmtLeft,
  fmtSpan,
  friendlySolError,
  holdsAnything,
  liveRoundRow,
  presaleRoundRow,
  safePayoutIf,
  useClaimables,
  useNow,
  useRoundState,
  useSendRounds,
  useSolWallet,
  type Claimable,
  type RoundView,
  type RoundsBuilders,
} from "./useRounds";

// The rounds ticket. One question per round: will the index, averaged
// over the round's last minutes, end at or above where it opened? While
// round N trades, round N+1 takes presale commits; the segmented control
// switches between the two. Same mount contract as BoundedTicket.

const QUICK = [10, 50, 100];
const SLIPPAGE_BPS = 100n; // 1% below the quote
const MAX_VI_AGE_MIN = 30; // lib/bm/open.ts: a series starts only on a fresh VI
const FAUCET_USDG = 1_000n;

interface Props {
  atnxMarketId: string;
  name: string;
  score: number;
  scoring?: boolean;
  // When the market's VI was last written; a stale VI cannot start a series.
  viUpdatedAt?: string | null;
  series: BmSeriesRow | null;
  rounds: BmRoundRow[];
  initialSide?: RoundSide;
  onToast?: (message: string, detail: string | undefined, type: RoundSide) => void;
}

export function RoundTicket(props: Props) {
  if (!USDG_MINT) {
    return (
      <Card className="p-4">
        <p className="text-sm text-secondary">Rounds are not live on Solana devnet yet.</p>
      </Card>
    );
  }
  if (!props.series || !props.series.series_pubkey || props.series.state === "pending") return <StartSeries {...props} />;
  return <SeriesTicket {...props} series={props.series} />;
}

// "Will Halloween's index be higher in 24 hours?"
function Question({ name, roundSecs }: { name: string; roundSecs: number }) {
  return (
    <p className="text-sm font-bold text-primary leading-snug mb-3">
      Will {name}&apos;s index be higher in {fmtSpan(roundSecs)}?
    </p>
  );
}

// ------------------------------------------------------------ no series

function StartSeries({ atnxMarketId, name, score, scoring = false, viUpdatedAt, series }: Props) {
  const router = useRouter();
  const wallet = useSolWallet();
  const now = useNow();
  const [fast, setFast] = useState(false);
  const [starting, startStarting] = useTransition();
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = started || series?.state === "pending";

  // The action creates the series on chain before it returns; a refresh
  // then brings the registry row. Keep re-reading until it does (a row
  // left pending by a slow confirmation is picked up by the keeper).
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => router.refresh(), 8_000);
    return () => clearInterval(t);
  }, [pending, router]);

  const roundSecs = fast ? 3_600 : 86_400;
  const stale = !!viUpdatedAt && now !== null && now - new Date(viUpdatedAt).getTime() > MAX_VI_AGE_MIN * 60_000;
  const blocked = scoring
    ? "The first score is still being computed. Rounds can start once it is live."
    : score <= 0
      ? "This market has no score yet."
      : stale
        ? `The index has not updated in the last ${MAX_VI_AGE_MIN} minutes. Rounds start on a fresh reading.`
        : null;

  function start() {
    if (!wallet.publicKey) return;
    const finder = wallet.publicKey.toBase58();
    setError(null);
    startStarting(async () => {
      const r = await startSeriesAction(atnxMarketId, finder, fast);
      if (!r.ok) setError(r.code === "already_active" ? "Rounds are already running on this market. Reload the page." : r.error);
      else {
        setStarted(true);
        router.refresh();
      }
    });
  }

  if (pending) {
    return (
      <Card className="p-4 sm:p-5">
        <Question name={name} roundSecs={series?.round_secs ?? roundSecs} />
        <p className="text-sm text-secondary animate-pulse">Starting rounds on chain…</p>
        <p className="text-[11px] text-tertiary mt-2">The series and its first presale are being created on Solana devnet. This page updates on its own.</p>
      </Card>
    );
  }

  return (
    <Card className="p-4 sm:p-5">
      <p className="text-sm text-primary font-bold mb-1">Start rounds on {name}</p>
      <p className="text-sm text-secondary mb-4">
        Each round asks one question: will the index be higher {fmtSpan(roundSecs)} after the round opens? The first round takes commits for {fast ? "ten minutes" : "an hour"}, then opens at
        the index of that moment{score > 0 ? <> (now <span className="tabular-nums font-bold text-primary">{Math.round(score)}</span>)</> : null}. Whoever starts the
        series earns a share of its fees.
      </p>
      {process.env.NODE_ENV !== "production" && (
        <label className="flex items-center gap-2 text-xs text-secondary mb-3 cursor-pointer">
          <input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} className="accent-[var(--color-atnx-cyan)]" />
          Fast series (1 h rounds, 15-minute average, for demos)
        </label>
      )}
      {blocked ? (
        <p className="text-sm text-secondary">{blocked}</p>
      ) : !wallet.connected ? (
        <SolConnectButton label="Connect a Solana wallet to start" />
      ) : (
        <>
          <button
            type="button"
            onClick={start}
            disabled={starting || wallet.mock}
            className="btn-cyan w-full h-12 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50"
          >
            {starting ? "Starting…" : `Start rounds on ${name}`}
          </button>
          {wallet.mock && <p className="text-[11px] text-tertiary mt-2">{MOCK_HINT}</p>}
        </>
      )}
      {error && <p className="text-xs text-atnx-magenta mt-3 break-words">{error}</p>}
      <p className="text-[11px] text-tertiary mt-3">Solana devnet. Everything settles in mock USDG, which has no value.</p>
    </Card>
  );
}

// ------------------------------------------------------------- the ticket

type Pane = "live" | "presale";

function SeriesTicket({ name, score, series, rounds, initialSide = "up", onToast }: Props & { series: BmSeriesRow }) {
  const router = useRouter();
  const wallet = useSolWallet();
  const now = useNow();
  const state = useRoundState(series, rounds);
  const claims = useClaimables(series, rounds);
  const { send } = useSendRounds();

  const liveRow = liveRoundRow(rounds);
  const presaleRow = presaleRoundRow(rounds);
  const [pane, setPane] = useState<Pane>(liveRow ? "live" : "presale");
  const [side, setSide] = useState<RoundSide>(initialSide);
  const [amount, setAmount] = useState("25");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const snap = state.data;
  const live = snap?.live ?? null;
  const presale = snap?.presale ?? null;
  const acct = snap?.series ?? null;
  const shown: Pane = pane === "live" && live ? "live" : presale ? "presale" : live ? "live" : "presale";

  // Waiting on the keeper: a live round past its close, a row it is
  // moving (opening, settling), or a presale whose opening time passed.
  // Re-read the page so the registry rows and the round indexes follow.
  const closeAtMs = live ? live.account.closeAt * 1000 : null;
  const opensAtMs = presaleRow ? new Date(presaleRow.opens_at).getTime() : null;
  const waiting =
    now !== null &&
    ((closeAtMs !== null && now >= closeAtMs) ||
      liveRow?.state === "opening" ||
      liveRow?.state === "settling" ||
      (!live && opensAtMs !== null && now >= opensAtMs));
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => router.refresh(), 8_000);
    return () => clearInterval(t);
  }, [waiting, router]);

  const units = useMemo(() => parseUsdg(amount), [amount]);

  async function run(label: string, build: (b: RoundsBuilders, holder: PublicKey) => Promise<TransactionInstruction[]>, toast: [string, string | undefined]) {
    setBusy(label);
    setError(null);
    try {
      const sig = await send(build);
      setLastTx(sig);
      void state.refetch();
      void claims.refetch();
      onToast?.(toast[0], toast[1], side);
      return true;
    } catch (err) {
      setError(friendlySolError(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function faucet() {
    await run(
      "Getting USDG…",
      async (b, holder) => {
        const ata = getAssociatedTokenAddressSync(USDG_MINT!, holder);
        return [createAssociatedTokenAccountIdempotentInstruction(holder, ata, holder, USDG_MINT!), await b.faucet({ to: ata, amount: FAUCET_USDG * USDG_UNIT })];
      },
      ["Got 1,000 USDG", "Devnet money, no value"],
    );
  }

  // ---------------------------------------------------------------- states

  if (!wallet.connected || !wallet.publicKey) {
    return (
      <Card className="p-4 sm:p-5">
        <Question name={name} roundSecs={series.round_secs} />
        <RegistryLine liveRow={liveRow} presaleRow={presaleRow} now={now} />
        <SolConnectButton label="Connect Solana wallet to trade" />
        <p className="text-[11px] text-tertiary mt-3">Solana devnet. Everything settles in mock USDG, which has no value.</p>
      </Card>
    );
  }

  if (!snap || !acct) {
    return (
      <Card className="p-4 sm:p-5">
        <Question name={name} roundSecs={series.round_secs} />
        <p className="text-sm text-secondary animate-pulse">{state.error ? "Could not read the round." : "Loading the round…"}</p>
        {state.error && <p className="text-[11px] text-atnx-magenta mt-2 break-words">{state.error.message.split("\n")[0]}</p>}
      </Card>
    );
  }

  const holdsSomething = holdsAnything(live?.position ?? null) || holdsAnything(presale?.position ?? null) || claims.data.length > 0;

  if (snap.usdg === 0n && !holdsSomething) {
    return (
      <Card className="p-4 sm:p-5">
        <Question name={name} roundSecs={series.round_secs} />
        <p className="text-sm text-secondary mb-4">You need test USDG to take a side. One click creates your USDG account and puts 1,000 in it.</p>
        <button type="button" onClick={faucet} disabled={!!busy || wallet.mock} className="btn-cyan w-full h-12 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50">
          {busy ?? "Get 1,000 test USDG"}
        </button>
        {wallet.mock && <p className="text-[11px] text-tertiary mt-2">{MOCK_HINT}</p>}
        {error && <p className="text-xs text-atnx-magenta mt-3 break-words">{error}</p>}
        <p className="text-[11px] text-tertiary mt-3">The wallet pays a small devnet SOL fee. Get devnet SOL at faucet.solana.com if it has none.</p>
      </Card>
    );
  }

  const feeBps = BigInt(acct.feeBps);
  const finderBps = BigInt(acct.finderBps);
  const ref = state.ref;
  const options = [
    ...(live ? [{ value: "live" as const, label: `Round ${live.account.index} · Live` }] : []),
    ...(presale ? [{ value: "presale" as const, label: `Round ${presale.account.index} · Presale` }] : []),
  ];

  return (
    <Card className="p-4 sm:p-5">
      <Question name={name} roundSecs={acct.roundSecs} />
      {options.length > 1 ? (
        <Segmented ariaLabel="Round" value={shown} onChange={setPane} options={options} className="w-full mb-4" itemClassName="flex-1" />
      ) : options.length === 1 ? (
        <div className="text-[11px] font-mono uppercase tracking-wider text-tertiary mb-3">{options[0].label}</div>
      ) : (
        <p className="text-sm text-secondary mb-3">This series has no open round. It may be paused or ended.</p>
      )}

      {shown === "live" && live && ref ? (
        <LivePane
          view={live}
          series={acct}
          score={score}
          now={now}
          side={side}
          setSide={setSide}
          amount={amount}
          setAmount={setAmount}
          units={units}
          usdg={snap.usdg}
          feeBps={feeBps}
          finderBps={finderBps}
          busy={busy}
          mock={wallet.mock}
          onBuy={async (quote) => {
            if (!units) return;
            const minShares = (quote.shares * (10_000n - SLIPPAGE_BPS)) / 10_000n;
            const ok = await run(
              "Buying…",
              async (b, holder) => [await b.buy({ ref, roundIndex: live.account.index, side, amount: units, minShares, holder })],
              [`Bought ${side.toUpperCase()}`, `${fmtUsdg(quote.shares)} shares in round ${live.account.index} of ${name}`],
            );
            if (ok) setAmount("25");
          }}
        />
      ) : shown === "presale" && presale && ref ? (
        <PresalePane
          view={presale}
          series={acct}
          seriesRow={series}
          now={now}
          liveCloseAtMs={closeAtMs}
          side={side}
          setSide={setSide}
          amount={amount}
          setAmount={setAmount}
          units={units}
          usdg={snap.usdg}
          feeBps={feeBps}
          finderBps={finderBps}
          busy={busy}
          mock={wallet.mock}
          onCommit={async () => {
            if (!units) return;
            const ok = await run(
              "Committing…",
              async (b, holder) => [await b.commit({ ref, roundIndex: presale.account.index, side, amount: units, holder })],
              [`Committed ${side.toUpperCase()}`, `${fmtUsdg(units, 0)} USDG on round ${presale.account.index} of ${name}`],
            );
            if (ok) setAmount("25");
          }}
        />
      ) : null}

      {units !== null && units > snap.usdg && (
        <div className="mt-3 flex items-center justify-between gap-3 text-xs">
          <span className="text-atnx-magenta">Not enough USDG.</span>
          <button type="button" onClick={faucet} disabled={!!busy || wallet.mock} className="h-8 px-3 rounded-lg border border-surface text-secondary btn-quiet cursor-pointer disabled:opacity-50">
            {busy === "Getting USDG…" ? "Getting USDG…" : "Get 1,000 test USDG"}
          </button>
        </div>
      )}
      {wallet.mock && <p className="text-[11px] text-tertiary mt-2">{MOCK_HINT}</p>}
      {error && <p className="text-xs text-atnx-magenta mt-3 break-words">{error}</p>}
      {lastTx && (
        <a href={solTxUrl(lastTx)} target="_blank" rel="noreferrer" className="block mt-2 text-[11px] text-tertiary link-quiet">
          View last transaction {shortHash(lastTx)} ↗
        </a>
      )}

      {claims.data.length > 0 && ref && (
        <div className="mt-4 pt-3 border-t border-surface">
          <ClaimList
            claims={claims.data}
            series={acct}
            busy={busy}
            mock={wallet.mock}
            onClaim={(c) =>
              run(
                c.amount > 0n ? "Claiming…" : "Closing…",
                async (b, holder) => {
                  const ata = getAssociatedTokenAddressSync(USDG_MINT!, holder);
                  return [createAssociatedTokenAccountIdempotentInstruction(holder, ata, holder, USDG_MINT!), await b.claim({ ref, roundIndex: c.account.index, holder })];
                },
                c.amount > 0n ? [`Claimed ${fmtUsdg(c.amount)} USDG`, `Round ${c.account.index} of ${name}`] : ["Position closed", "The account's rent is back in your wallet"],
              )
            }
            onRoll={(c) =>
              run(
                "Rolling over…",
                async (b, holder) => [await b.claimRollover({ ref, roundIndex: c.account.index, nextRoundIndex: acct.presaleRound, holder })],
                [`Rolled ${fmtUsdg(c.amount)} USDG`, `Into round ${acct.presaleRound} of ${name}, ${c.account.winner?.toUpperCase() ?? ""}`],
              )
            }
          />
        </div>
      )}
    </Card>
  );
}

// Before a wallet is connected: where the series stands, from the registry.
function RegistryLine({ liveRow, presaleRow, now }: { liveRow: BmRoundRow | null; presaleRow: BmRoundRow | null; now: number | null }) {
  if (liveRow && liveRow.target_vi !== null) {
    const close = liveRow.close_at ? new Date(liveRow.close_at).getTime() : null;
    return (
      <p className="text-xs text-secondary mb-4">
        Round {liveRow.idx} is live with a target of <span className="tabular-nums font-bold text-primary">{Math.round(liveRow.target_vi)}</span>
        {close && now !== null && now < close ? <>, closing in {fmtLeft(close - now)}</> : null}.
        {presaleRow ? <> Round {presaleRow.idx} is taking commits.</> : null}
      </p>
    );
  }
  if (presaleRow) {
    const opens = new Date(presaleRow.opens_at).getTime();
    return (
      <p className="text-xs text-secondary mb-4">
        Round {presaleRow.idx} is taking commits{now !== null && now < opens ? <> and opens in {fmtLeft(opens - now)}</> : null}.
      </p>
    );
  }
  return null;
}

// ------------------------------------------------------------- live pane

interface PaneBase {
  series: SeriesAccount;
  now: number | null;
  side: RoundSide;
  setSide: (s: RoundSide) => void;
  amount: string;
  setAmount: (a: string) => void;
  units: bigint | null;
  usdg: bigint;
  feeBps: bigint;
  finderBps: bigint;
  busy: string | null;
  mock: boolean;
}

function LivePane({ view, series, score, now, side, setSide, amount, setAmount, units, usdg, feeBps, finderBps, busy, mock, onBuy }: PaneBase & { view: RoundView; score: number; onBuy: (q: BuyQuote) => void }) {
  const [details, setDetails] = useState(false);
  const r = view.account;
  const target = Number(r.targetE2) / 100;
  const tradeUntil = r.tradeUntil * 1000;
  const closeAt = r.closeAt * 1000;
  const phase = now === null || now < tradeUntil ? "trading" : now < closeAt ? "averaging" : "settling";
  const windowMin = Math.round(series.settleWindowSecs / 60);
  const pUp = mprUp(r);

  const quote = useMemo(() => {
    if (!units || units <= 0n) return null;
    try {
      return { ok: true as const, q: quoteBuy(r, side, units, feeBps, finderBps) };
    } catch (e) {
      return { ok: false as const, reason: e instanceof DpmError && e.code === "ratio" ? "That buy is too large for the money on this side." : "Cannot quote this amount." };
    }
  }, [r, side, units, feeBps, finderBps]);

  const q = quote?.ok ? quote.q : null;
  const ifWin = q
    ? safePayoutIf(
        { presaleUp: 0n, presaleDown: 0n, stakeUp: side === "up" ? q.net : 0n, stakeDown: side === "down" ? q.net : 0n, sharesUp: side === "up" ? q.shares : 0n, sharesDown: side === "down" ? q.shares : 0n },
        { ...q.after, presaleUp: r.presaleUp, presaleDown: r.presaleDown },
        side,
      )
    : null;
  const spend = units ?? 0n;
  const profit = ifWin !== null ? ifWin - spend : 0n;
  const profitPct = ifWin !== null && spend > 0n ? (Number(profit) / Number(spend)) * 100 : 0;
  const pos = view.position;
  const insufficient = !!units && units > usdg;
  const canBuy = phase === "trading" && !!q && q.shares > 0n && !insufficient && !busy && !mock;
  const maxBuy = fmtUsdg((usdg * 99n) / 100n, 2).replace(/,/g, "");
  const viAbove = score >= target;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-xs mb-3">
        <span className="text-secondary">
          Target <span className="tabular-nums font-bold text-primary">{target.toFixed(target < 100 ? 1 : 0)}</span>
          <span className="text-tertiary"> · index now </span>
          <span className={`tabular-nums font-bold ${viAbove ? "text-atnx-cyan" : "text-atnx-magenta"}`}>{Math.round(score)}</span>
        </span>
        <span className="text-tertiary tabular-nums">{now === null ? "" : phase === "trading" ? `${fmtLeft(tradeUntil - now)} left` : phase === "averaging" ? `closes in ${fmtLeft(closeAt - now)}` : "settling"}</span>
      </div>

      {phase === "trading" ? (
        <>
          <div className="grid grid-cols-2 gap-2 mb-4" role="radiogroup" aria-label="Side">
            <SideButton side="up" caption={`${Math.round(pUp * 100)}% UP`} selected={side === "up"} onClick={() => setSide("up")} />
            <SideButton side="down" caption={`${Math.round((1 - pUp) * 100)}% DOWN`} selected={side === "down"} onClick={() => setSide("down")} />
          </div>
          <AmountInput amount={amount} setAmount={setAmount} usdg={usdg} maxBuy={maxBuy} label="Spend" />

          {quote && !quote.ok && <p className="text-xs text-atnx-magenta mt-3">{quote.reason}</p>}
          {q && ifWin !== null && (
            <div className="mt-4 rounded-xl bg-elevated/60 border border-surface px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-secondary">If {side.toUpperCase()} wins you get</span>
                <span className="text-right">
                  <span className="font-display font-bold text-xl tabular-nums text-primary">{fmtUsdg(ifWin)}</span>
                  <span className="text-xs text-tertiary"> USDG</span>
                  <span className={`block text-[11px] tabular-nums ${profit >= 0n ? "text-atnx-cyan" : "text-atnx-magenta"}`}>
                    {profit >= 0n ? "+" : ""}
                    {fmtUsdg(profit)} ({profitPct >= 0 ? "+" : ""}
                    {profitPct.toFixed(0)}%)
                  </span>
                </span>
              </div>
              <p className="text-[11px] text-tertiary mt-1">At the pools as they are now. Later buys on the other side add to it; your stake comes back either way if you are right.</p>
              <button type="button" onClick={() => setDetails((v) => !v)} aria-expanded={details} className="mt-1.5 text-[11px] text-tertiary link-quiet cursor-pointer">
                {details ? "▾ Hide details" : "▸ Details"}
              </button>
              {details && (
                <dl className="mt-1.5 pt-2 border-t border-surface space-y-1 text-[11px]">
                  <Row k="Shares" v={`${fmtUsdg(q.shares)} ${side.toUpperCase()}`} />
                  <Row k="Average price" v={`${fmtCents(Number(q.net) / Number(q.shares))} a share`} />
                  <Row k={`Fee (${Number(feeBps) / 100}%)`} v={`${fmtUsdg(q.fee)} USDG`} />
                  <Row k="Finder's share of the fee" v={`${Number(finderBps) / 100}%`} />
                  <Row k="UP pool" v={`${fmtUsdg(r.mUp, 0)} → ${fmtUsdg(q.after.mUp, 0)}`} />
                  <Row k="DOWN pool" v={`${fmtUsdg(r.mDown, 0)} → ${fmtUsdg(q.after.mDown, 0)}`} />
                  <Row k="Chance of UP" v={`${Math.round(pUp * 100)}% → ${Math.round(mprUp(q.after) * 100)}%`} />
                </dl>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => q && onBuy(q)}
            disabled={!canBuy}
            className={`mt-4 w-full h-12 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-40 ${side === "up" ? "btn-cyan" : "btn-magenta"}`}
          >
            {busy ?? `Buy ${side.toUpperCase()}${units && units > 0n ? ` for ${fmtUsdg(units, 0)} USDG` : ""}`}
          </button>
          <p className="text-[11px] text-tertiary mt-2">
            Trading stops {fmtSpan(series.settleWindowSecs)} before the close. The round settles on the index averaged over those last {windowMin} minutes: UP wins at or above the target.
          </p>
        </>
      ) : phase === "averaging" ? (
        <p className="text-sm text-secondary animate-pulse">Averaging the last {windowMin} minutes… trading has stopped until the round closes.</p>
      ) : (
        <p className="text-sm text-secondary animate-pulse">Settling: the keeper averages the last {windowMin} minutes of the index and settles the round on chain.</p>
      )}

      {pos && holdsAnything(pos) && <YourPosition pos={pos} round={r} />}
    </div>
  );
}

function YourPosition({ pos, round }: { pos: NonNullable<RoundView["position"]>; round: RoundView["account"] }) {
  const opened = round.state === "presale" ? asOpened(round) : round;
  const up = pos.presaleUp + pos.stakeUp;
  const down = pos.presaleDown + pos.stakeDown;
  const payUp = up > 0n ? safePayoutIf(pos, opened, "up") : null;
  const payDown = down > 0n ? safePayoutIf(pos, opened, "down") : null;
  return (
    <div className="mt-4 pt-3 border-t border-surface space-y-1.5 text-xs">
      {up > 0n && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-secondary">
            You have <span className="tabular-nums font-bold text-primary">{fmtUsdg(up)}</span> on <span className="text-atnx-cyan">UP</span>
          </span>
          {payUp !== null && <span className="text-tertiary tabular-nums">pays {fmtUsdg(payUp)} if UP wins</span>}
        </div>
      )}
      {down > 0n && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-secondary">
            You have <span className="tabular-nums font-bold text-primary">{fmtUsdg(down)}</span> on <span className="text-atnx-magenta">DOWN</span>
          </span>
          {payDown !== null && <span className="text-tertiary tabular-nums">pays {fmtUsdg(payDown)} if DOWN wins</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------- presale pane

function PresalePane({
  view,
  series,
  seriesRow,
  now,
  liveCloseAtMs,
  side,
  setSide,
  amount,
  setAmount,
  units,
  usdg,
  feeBps,
  finderBps,
  busy,
  mock,
  onCommit,
}: PaneBase & { view: RoundView; seriesRow: BmSeriesRow; liveCloseAtMs: number | null; onCommit: () => void }) {
  const r = view.account;
  const row = view.row;
  const potUp = r.presaleUp;
  const potDown = r.presaleDown;
  const priceUp = presalePrice(potUp, potDown, "up");
  const net = units && units > 0n ? feeSplit(units, feeBps, finderBps).net : 0n;
  const opensAt = row ? new Date(row.opens_at).getTime() : liveCloseAtMs;
  const pos = view.position;

  // This commit valued as if the round opened now, at the pots plus it.
  // The payout is linear in a commit, so it reads the same alone or added
  // to what the wallet already committed.
  const preview = useMemo(() => {
    if (net <= 0n) return null;
    const up = side === "up";
    const after = { ...r, presaleUp: potUp + (up ? net : 0n), presaleDown: potDown + (up ? 0n : net) };
    const mine = { presaleUp: up ? net : 0n, presaleDown: up ? 0n : net, stakeUp: 0n, stakeDown: 0n, sharesUp: 0n, sharesDown: 0n };
    const total = after.presaleUp + after.presaleDown;
    const pot = up ? after.presaleUp : after.presaleDown;
    return { pay: safePayoutIf(mine, asOpened(after), side), price: total > 0n ? Number(pot) / Number(total) : null };
  }, [net, r, potUp, potDown, side]);

  const insufficient = !!units && units > usdg;
  const canCommit = !!units && units > 0n && net > 0n && !insufficient && !busy && !mock;
  const maxBuy = fmtUsdg((usdg * 99n) / 100n, 2).replace(/,/g, "");
  const ante = seriesRow.ante_usdg;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-xs mb-3">
        <span className="text-secondary">
          Pots <span className="text-atnx-cyan tabular-nums font-bold">{fmtUsdg(potUp, 0)}</span> UP ·{" "}
          <span className="text-atnx-magenta tabular-nums font-bold">{fmtUsdg(potDown, 0)}</span> DOWN
        </span>
        <span className="text-tertiary tabular-nums">
          {opensAt === null || now === null ? "" : now < opensAt ? `opens in ${fmtLeft(opensAt - now)}` : "opening…"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4" role="radiogroup" aria-label="Side">
        <SideButton side="up" caption={priceUp === null ? "no commits yet" : `${fmtCents(priceUp)} a share`} selected={side === "up"} onClick={() => setSide("up")} />
        <SideButton side="down" caption={priceUp === null ? "no commits yet" : `${fmtCents(1 - priceUp)} a share`} selected={side === "down"} onClick={() => setSide("down")} />
      </div>
      <AmountInput amount={amount} setAmount={setAmount} usdg={usdg} maxBuy={maxBuy} label="Commit" />

      {preview && (
        <div className="mt-4 rounded-xl bg-elevated/60 border border-surface px-3 py-2.5">
          {preview.pay !== null && (
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-secondary">If {side.toUpperCase()} wins, at today&apos;s pots</span>
              <span>
                <span className="font-display font-bold text-xl tabular-nums text-primary">{fmtUsdg(preview.pay)}</span>
                <span className="text-xs text-tertiary"> USDG</span>
              </span>
            </div>
          )}
          <p className="text-[11px] text-tertiary mt-1">
            Everyone on a side clears at the final pot share{preview.price !== null ? <> ({fmtCents(preview.price)} a share with your commit)</> : null}, so this moves
            until the round opens. Commits are locked until the round settles.
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={onCommit}
        disabled={!canCommit}
        className={`mt-4 w-full h-12 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-40 ${side === "up" ? "btn-cyan" : "btn-magenta"}`}
      >
        {busy ?? `Commit${units && units > 0n ? ` ${fmtUsdg(units, 0)} USDG` : ""} to ${side.toUpperCase()}`}
      </button>
      <p className="text-[11px] text-tertiary mt-2">
        The round opens at the index of that moment and runs {fmtSpan(series.roundSecs)}. UP wins if the index, averaged over the last{" "}
        {Math.round(series.settleWindowSecs / 60)} minutes, ends at or above it. Fee {Number(feeBps) / 100}%.
      </p>
      {row?.ante_side ? (
        <p className="text-[11px] text-tertiary mt-1">
          The treasury committed {row.ante_usdg ?? ante} USDG on {row.ante_side === "both" ? "both sides" : row.ante_side.toUpperCase()} so the round could open.
        </p>
      ) : ante > 0 ? (
        <p className="text-[11px] text-tertiary mt-1">If a side is still empty at the open, the treasury commits {ante} USDG there so the round can open; it can win or lose like anyone.</p>
      ) : null}

      {pos && holdsAnything(pos) && <YourPosition pos={pos} round={r} />}
    </div>
  );
}

// ----------------------------------------------------------------- parts

function AmountInput({ amount, setAmount, usdg, maxBuy, label }: { amount: string; setAmount: (a: string) => void; usdg: bigint; maxBuy: string; label: string }) {
  return (
    <>
      <div className="flex items-center justify-between text-xs mb-1.5">
        <span className="text-secondary">{label}</span>
        <span className="text-tertiary">
          You have <span className="tabular-nums font-bold text-secondary">{fmtUsdg(usdg, 0)}</span> USDG
        </span>
      </div>
      <label className="flex items-center gap-2 rounded-xl border border-surface bg-elevated px-3 h-12 focus-within:border-atnx-cyan/60">
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="flex-1 bg-transparent outline-none font-mono text-lg text-primary tabular-nums min-w-0"
          aria-label="Amount of USDG"
        />
        <span className="text-xs text-tertiary">USDG</span>
      </label>
      <div className="flex gap-1.5 mt-2">
        {[...QUICK.map((q) => [String(q), String(q)] as const), ["Max", maxBuy] as const].map(([l, value]) => (
          <button key={l} type="button" onClick={() => setAmount(value)} className="flex-1 h-8 rounded-lg border border-surface text-xs text-secondary btn-quiet cursor-pointer">
            {l}
          </button>
        ))}
      </div>
    </>
  );
}

function SideButton({ side, caption, selected, onClick }: { side: RoundSide; caption: string; selected: boolean; onClick: () => void }) {
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
        selected ? ring : "border-surface opacity-70 hover:opacity-100 hover:border-white/20"
      }`}
    >
      <span className={`font-display font-bold text-lg leading-none ${tone}`}>{up ? "↗ UP" : "↘ DOWN"}</span>
      <span className="text-[11px] text-tertiary tabular-nums">{caption}</span>
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

// Settled and void rounds where the wallet still has a position.
export function ClaimList({
  claims,
  series,
  busy,
  mock,
  onClaim,
  onRoll,
}: {
  claims: Claimable[];
  series: SeriesAccount;
  busy: string | null;
  mock: boolean;
  onClaim: (c: Claimable) => void;
  onRoll: (c: Claimable) => void;
}) {
  const canRoll = series.presaleRound > 0 && !series.paused;
  return (
    <div className="space-y-3">
      {claims.map((c) => {
        const r = c.account;
        const winner = r.winner;
        const tone = winner === "up" ? "text-atnx-cyan" : "text-atnx-magenta";
        return (
          <div key={c.key.toBase58()} className="text-xs">
            <p className="text-secondary mb-1.5">
              {r.state === "void" ? (
                <>Round {r.index} was void. Your net stake comes back; the fee stays with the series.</>
              ) : (
                <>
                  Round {r.index} settled <span className={tone}>{winner?.toUpperCase()}</span>
                  {r.settleE2 > 0n ? <> at {(Number(r.settleE2) / 100).toFixed(0)} against {(Number(r.targetE2) / 100).toFixed(0)}</> : null}.{" "}
                  {c.amount > 0n ? "You won." : "Your side lost."}
                </>
              )}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {c.amount > 0n ? (
                <>
                  <button type="button" disabled={!!busy || mock} onClick={() => onClaim(c)} className="h-8 px-3 rounded-lg btn-cyan text-xs font-bold cursor-pointer disabled:opacity-50">
                    Claim {fmtUsdg(c.amount)} USDG
                  </button>
                  {r.state === "settled" && canRoll && winner && (
                    <button type="button" disabled={!!busy || mock} onClick={() => onRoll(c)} className="h-8 px-3 rounded-lg border border-surface text-secondary btn-quiet text-xs font-bold cursor-pointer disabled:opacity-50">
                      Roll {fmtUsdg(c.amount)} into round {series.presaleRound} ({winner.toUpperCase()})
                    </button>
                  )}
                </>
              ) : (
                <button type="button" disabled={!!busy || mock} onClick={() => onClaim(c)} className="h-8 px-3 rounded-lg border border-surface text-secondary btn-quiet text-xs cursor-pointer disabled:opacity-50">
                  Close position (returns rent)
                </button>
              )}
            </div>
          </div>
        );
      })}
      {canRoll && claims.some((c) => c.amount > 0n && c.account.state === "settled") && (
        <p className="text-[11px] text-tertiary">
          A roll commits the payout, less the fee, to the same side of the round now in presale (round {series.presaleRound}): the next round opens in the same moment
          the last one settles, so a roll lands one further on.
        </p>
      )}
    </div>
  );
}
