"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { startSeriesAction } from "@/app/app/actions/rounds";
import { Card } from "@/components/ui";
import { HowItWorksModal } from "@/components/HowItWorksModal";
import { fmtCents, fmtUsdg, parseUsdg, shortHash } from "@/components/bm/format";
import { USDG_UNIT, solTxUrl } from "@/lib/bm/chains";
import { DpmError, feeSplit, mprUp, presalePrice, presaleShares, quoteBuy, type BuyQuote } from "@/lib/bm/dpm";
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
// over the round's last minutes, end at or above where it opened? The
// ticket shows one round: the live one when the series has it, otherwise
// the presale round (round 1 before it opens, or the few minutes between
// a settle and the next open). Commits to the next round are not offered
// while one is live; a position already there shows as one line. Same
// mount contract as BoundedTicket.
//
// It reads like a trade ticket: numbers, one outcome line, a button. How
// rounds work sits behind the one "How rounds work" disclosure at the
// bottom of every state, and behind it the Show me modal.

const QUICK = [10, 50, 100];
const SLIPPAGE_BPS = 100n; // 1% below the quote
const MAX_VI_AGE_MIN = 30; // lib/bm/open.ts: a series starts only on a fresh VI
const FAUCET_USDG = 1_000n;
const DEVNET = "Devnet · mock USDG, no value.";
// lib/bm/rounds.ts: the averaging window a new series gets.
const WINDOW_SECS = 1_800;
const FAST_WINDOW_SECS = 900;

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
  const windowSecs = fast ? FAST_WINDOW_SECS : WINDOW_SECS;
  const stale = !!viUpdatedAt && now !== null && now - new Date(viUpdatedAt).getTime() > MAX_VI_AGE_MIN * 60_000;
  const blocked = scoring
    ? "The first score is still being computed."
    : score <= 0
      ? "This market has no score yet."
      : stale
        ? `The index is over ${MAX_VI_AGE_MIN} minutes old. Rounds start on a fresh reading.`
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
        <HowRounds roundSecs={series?.round_secs ?? roundSecs} windowSecs={series?.settle_window_secs ?? windowSecs} />
      </Card>
    );
  }

  return (
    <Card className="p-4 sm:p-5">
      <Question name={name} roundSecs={roundSecs} />
      {process.env.NODE_ENV !== "production" && (
        <label className="flex items-center gap-2 text-xs text-secondary mb-3 cursor-pointer">
          <input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} className="accent-[var(--color-atnx-cyan)]" />
          Fast series (1 h rounds, 15-minute average, for demos)
        </label>
      )}
      {blocked ? (
        <p className="text-sm text-secondary">{blocked}</p>
      ) : (
        <>
          {!wallet.connected ? (
            <SolConnectButton label="Connect a Solana wallet to start" />
          ) : (
            <button
              type="button"
              onClick={start}
              disabled={starting || wallet.mock}
              className="btn-cyan w-full h-12 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50"
            >
              {starting ? "Starting…" : "Start rounds"}
            </button>
          )}
          <p className="text-[11px] text-tertiary mt-2">You earn a share of every fee in this series.</p>
          {wallet.mock && <p className="text-[11px] text-tertiary mt-1">{MOCK_HINT}</p>}
        </>
      )}
      {error && <p className="text-xs text-atnx-magenta mt-3 break-words">{error}</p>}
      <HowRounds roundSecs={roundSecs} windowSecs={windowSecs} />
    </Card>
  );
}

// ------------------------------------------------------------- the ticket

function SeriesTicket({ name, score, series, rounds, initialSide = "up", onToast }: Props & { series: BmSeriesRow }) {
  const router = useRouter();
  const wallet = useSolWallet();
  const now = useNow();
  const state = useRoundState(series, rounds);
  const claims = useClaimables(series, rounds);
  const { send } = useSendRounds();

  const liveRow = liveRoundRow(rounds);
  const presaleRow = presaleRoundRow(rounds);
  const [side, setSide] = useState<RoundSide>(initialSide);
  const [amount, setAmount] = useState("25");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const snap = state.data;
  const live = snap?.live ?? null;
  const presale = snap?.presale ?? null;
  const acct = snap?.series ?? null;

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
        <SolConnectButton label={!liveRow && presaleRow ? "Connect Solana wallet to commit" : "Connect Solana wallet to trade"} />
        <HowRounds roundSecs={series.round_secs} windowSecs={series.settle_window_secs} />
      </Card>
    );
  }

  if (!snap || !acct) {
    return (
      <Card className="p-4 sm:p-5">
        <Question name={name} roundSecs={series.round_secs} />
        <p className="text-sm text-secondary animate-pulse">{state.error ? "Could not read the round." : "Loading the round…"}</p>
        {state.error && <p className="text-[11px] text-atnx-magenta mt-2 break-words">{state.error.message.split("\n")[0]}</p>}
        <HowRounds roundSecs={series.round_secs} windowSecs={series.settle_window_secs} />
      </Card>
    );
  }

  const holdsSomething = holdsAnything(live?.position ?? null) || holdsAnything(presale?.position ?? null) || claims.data.length > 0;

  if (snap.usdg === 0n && !holdsSomething) {
    return (
      <Card className="p-4 sm:p-5">
        <Question name={name} roundSecs={series.round_secs} />
        <p className="text-sm text-secondary mb-3">You need test USDG to take a side.</p>
        <button type="button" onClick={faucet} disabled={!!busy || wallet.mock} className="btn-cyan w-full h-12 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50">
          {busy ?? "Get 1,000 test USDG"}
        </button>
        {wallet.mock && <p className="text-[11px] text-tertiary mt-2">{MOCK_HINT}</p>}
        {error && <p className="text-xs text-atnx-magenta mt-3 break-words">{error}</p>}
        <HowRounds roundSecs={series.round_secs} windowSecs={series.settle_window_secs} />
      </Card>
    );
  }

  const feeBps = BigInt(acct.feeBps);
  const finderBps = BigInt(acct.finderBps);
  const ref = state.ref;
  // A position the wallet already holds in the next round (a rollover or
  // an earlier commit), shown under the live pane as one line.
  const nextPos = live && presale && holdsAnything(presale.position) ? presale.position : null;

  return (
    <Card className="p-4 sm:p-5">
      <Question name={name} roundSecs={acct.roundSecs} />
      {live ? (
        <div className="text-xs font-bold text-secondary mb-3">Round {live.account.index} · Live</div>
      ) : presale ? (
        <div className="text-xs font-bold text-secondary mb-3">Round {presale.account.index} · Presale</div>
      ) : (
        <p className="text-sm text-secondary mb-3">No open round. The series may be paused or ended.</p>
      )}

      {live && ref ? (
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
      ) : presale && ref ? (
        <PresalePane
          view={presale}
          series={acct}
          seriesRow={series}
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
      {nextPos && presale && <NextRoundLine pos={nextPos} index={presale.account.index} />}

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
      <HowRounds roundSecs={acct.roundSecs} windowSecs={acct.settleWindowSecs} />
    </Card>
  );
}

// Before a wallet is connected: the round the ticket will show, from the
// registry, with the same chip as its pane: the live round when there is
// one, otherwise the presale round.
function RegistryLine({ liveRow, presaleRow, now }: { liveRow: BmRoundRow | null; presaleRow: BmRoundRow | null; now: number | null }) {
  if (liveRow && liveRow.target_vi !== null) {
    const close = liveRow.close_at ? new Date(liveRow.close_at).getTime() : null;
    const until = liveRow.trade_until ? new Date(liveRow.trade_until).getTime() : close;
    const chip =
      now === null || close === null || until === null ? null : now < until ? `${fmtLeft(until - now)} left` : now < close ? `Closes in ${fmtLeft(close - now)}` : "Settling";
    return (
      <StatusRow chip={chip}>
        Round {liveRow.idx} · target <span className="tabular-nums font-bold text-primary">{Math.round(liveRow.target_vi)}</span>
      </StatusRow>
    );
  }
  if (presaleRow) {
    const opens = new Date(presaleRow.opens_at).getTime();
    return <StatusRow chip={now === null ? null : now < opens ? `Opens in ${fmtLeft(opens - now)}` : "Opening…"}>Round {presaleRow.idx} · presale</StatusRow>;
  }
  return null;
}

// One line of numbers on the left, the countdown as a chip on the right:
// the neutral Chip's shape in the body face, sentence case, the digits
// tabular.
function StatusRow({ chip, children }: { chip: string | null; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs mb-3 min-h-5">
      <span className="text-secondary min-w-0">{children}</span>
      {chip && <span className="shrink-0 inline-flex items-center rounded-md border border-surface bg-elevated px-1.5 py-0.5 text-[11px] font-bold text-secondary tabular-nums whitespace-nowrap">{chip}</span>}
    </div>
  );
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
      <StatusRow chip={now === null ? null : phase === "trading" ? `${fmtLeft(tradeUntil - now)} left` : phase === "averaging" ? `Closes in ${fmtLeft(closeAt - now)}` : "Settling"}>
        Target <span className="tabular-nums font-bold text-primary">{target.toFixed(target < 100 ? 1 : 0)}</span>
        <span className="text-tertiary"> · now </span>
        <span className={`tabular-nums font-bold ${viAbove ? "text-atnx-cyan" : "text-atnx-magenta"}`}>{Math.round(score)}</span>
      </StatusRow>

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
        </>
      ) : phase === "averaging" ? (
        <p className="text-sm text-secondary animate-pulse">Averaging the last {windowMin} minutes…</p>
      ) : (
        <p className="text-sm text-secondary animate-pulse">Settling…</p>
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

// Under the live pane: what the wallet already holds in the next round.
function NextRoundLine({ pos, index }: { pos: NonNullable<RoundView["position"]>; index: number }) {
  const up = pos.presaleUp + pos.stakeUp;
  const down = pos.presaleDown + pos.stakeDown;
  const held = [up > 0n ? `${fmtUsdg(up)} USDG on UP` : null, down > 0n ? `${fmtUsdg(down)} USDG on DOWN` : null].filter(Boolean).join(" and ");
  return (
    <p className="mt-3 text-xs text-tertiary">
      You also have {held} in round {index}, which opens when this one settles.
    </p>
  );
}

// ---------------------------------------------------------- presale pane

function PresalePane({
  view,
  seriesRow,
  now,
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
}: PaneBase & { view: RoundView; seriesRow: BmSeriesRow; onCommit: () => void }) {
  const [details, setDetails] = useState(false);
  const r = view.account;
  const row = view.row;
  const potUp = r.presaleUp;
  const potDown = r.presaleDown;
  const priceUp = presalePrice(potUp, potDown, "up");
  const net = units && units > 0n ? feeSplit(units, feeBps, finderBps).net : 0n;
  const opensAt = row ? new Date(row.opens_at).getTime() : null;
  const pos = view.position;

  // This commit valued as if the round opened now, at the pots plus it.
  // The payout is linear in a commit, so it reads the same alone or added
  // to what the wallet already committed. A price exists only once the
  // other side has money too; before that, the line says so instead.
  const preview = useMemo(() => {
    if (net <= 0n) return null;
    const up = side === "up";
    const after = { ...r, presaleUp: potUp + (up ? net : 0n), presaleDown: potDown + (up ? 0n : net) };
    const mine = { presaleUp: up ? net : 0n, presaleDown: up ? 0n : net, stakeUp: 0n, stakeDown: 0n, sharesUp: 0n, sharesDown: 0n };
    const total = after.presaleUp + after.presaleDown;
    const pot = up ? after.presaleUp : after.presaleDown;
    const other = up ? potDown : potUp;
    return {
      priced: other > 0n,
      shares: presaleShares(net, pot, total),
      pay: safePayoutIf(mine, asOpened(after), side),
      price: total > 0n ? Number(pot) / Number(total) : null,
    };
  }, [net, r, potUp, potDown, side]);

  const insufficient = !!units && units > usdg;
  const canCommit = !!units && units > 0n && net > 0n && !insufficient && !busy && !mock;
  const maxBuy = fmtUsdg((usdg * 99n) / 100n, 2).replace(/,/g, "");
  const ante = seriesRow.ante_usdg;
  const anteRow = row?.ante_side
    ? { k: "Keeper ante", v: `${row.ante_usdg ?? ante} USDG on ${row.ante_side === "both" ? "both sides" : row.ante_side.toUpperCase()}` }
    : ante > 0
      ? { k: "Keeper ante if a side is empty", v: `${ante} USDG` }
      : null;

  return (
    <div>
      <StatusRow chip={opensAt === null || now === null ? null : now < opensAt ? `Opens in ${fmtLeft(opensAt - now)}` : "Opening…"}>
        Pots <span className="text-atnx-cyan tabular-nums font-bold">{fmtUsdg(potUp, 0)}</span> UP ·{" "}
        <span className="text-atnx-magenta tabular-nums font-bold">{fmtUsdg(potDown, 0)}</span> DOWN
      </StatusRow>

      <div className="grid grid-cols-2 gap-2 mb-4" role="radiogroup" aria-label="Side">
        <SideButton side="up" caption={priceUp === null ? "no commits yet" : `${fmtCents(priceUp)} a share`} selected={side === "up"} onClick={() => setSide("up")} />
        <SideButton side="down" caption={priceUp === null ? "no commits yet" : `${fmtCents(1 - priceUp)} a share`} selected={side === "down"} onClick={() => setSide("down")} />
      </div>
      <AmountInput amount={amount} setAmount={setAmount} usdg={usdg} maxBuy={maxBuy} label="Commit" />

      {preview && (
        <div className="mt-4 rounded-xl bg-elevated/60 border border-surface px-3 py-2.5">
          {preview.priced && preview.price !== null ? (
            <p className="text-xs text-secondary">
              At today&apos;s pots your <span className="tabular-nums font-bold text-primary">{fmtUsdg(units ?? 0n, 0)}</span> USDG buys ~
              <span className="tabular-nums font-bold text-primary">{fmtUsdg(preview.shares)}</span> shares at ~
              <span className="tabular-nums font-bold text-primary">{fmtCents(preview.price)}</span>
            </p>
          ) : (
            <p className="text-xs text-secondary">Price set when the round opens; nobody pays more for being early.</p>
          )}
          <button type="button" onClick={() => setDetails((v) => !v)} aria-expanded={details} className="mt-1.5 text-[11px] text-tertiary link-quiet cursor-pointer">
            {details ? "▾ Hide details" : "▸ Details"}
          </button>
          {details && (
            <dl className="mt-1.5 pt-2 border-t border-surface space-y-1 text-[11px]">
              {preview.priced && preview.pay !== null && <Row k={`Pays if ${side.toUpperCase()} wins`} v={`${fmtUsdg(preview.pay)} USDG`} />}
              <Row k={`Fee (${Number(feeBps) / 100}%)`} v={`${fmtUsdg(units ? units - net : 0n)} USDG`} />
              <Row k="Finder's share of the fee" v={`${Number(finderBps) / 100}%`} />
              {anteRow && <Row k={anteRow.k} v={anteRow.v} />}
            </dl>
          )}
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
                <>Round {r.index} · void · stake refunded</>
              ) : (
                <>
                  Round {r.index} · <span className={tone}>{winner?.toUpperCase()}</span> won
                  {r.settleE2 > 0n ? <span className="tabular-nums"> · {(Number(r.settleE2) / 100).toFixed(0)} vs {(Number(r.targetE2) / 100).toFixed(0)}</span> : null}
                  {c.amount > 0n ? null : <span className="text-tertiary"> · your side lost</span>}
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
                    <button
                      type="button"
                      disabled={!!busy || mock}
                      onClick={() => onRoll(c)}
                      title={`Commits the payout, less the fee, to ${winner.toUpperCase()} in round ${series.presaleRound}`}
                      className="h-8 px-3 rounded-lg border border-surface text-secondary btn-quiet text-xs font-bold cursor-pointer disabled:opacity-50"
                    >
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
    </div>
  );
}

// The one place the ticket explains itself: collapsed by default, the
// same in every state, with the devnet note beside the toggle. "Show me"
// opens the walkthrough at its rounds step, portalled to the body so the
// phone sheet's transform cannot trap it.
export function HowRounds({ roundSecs, windowSecs }: { roundSecs: number; windowSecs: number }) {
  const [open, setOpen] = useState(false);
  const [showMe, setShowMe] = useState(false);
  const win = fmtSpan(windowSecs);
  return (
    <div className="mt-4 pt-3 border-t border-surface text-[11px] text-tertiary">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="link-quiet cursor-pointer">
          {open ? "▾" : "▸"} How rounds work
        </button>
        <span>{DEVNET}</span>
      </div>
      {open && (
        <div className="mt-2">
          <ul className="list-disc pl-4 space-y-1 text-secondary">
            <li>A round opens at the index of that moment: that is its target.</li>
            <li>
              It runs {fmtSpan(roundSecs)}; trading stops {win} before the close.
            </li>
            <li>The close is the index averaged over those {win}. UP wins at or above the target.</li>
            <li>Winners get their stake back plus a share of the losing side&apos;s money.</li>
            <li>Claim it, or roll it into the next round.</li>
          </ul>
          <p className="mt-2">Each transaction costs a little devnet SOL (faucet.solana.com).</p>
          <button type="button" onClick={() => setShowMe(true)} className="mt-1.5 link-quiet font-bold cursor-pointer">
            Show me ›
          </button>
        </div>
      )}
      {showMe && createPortal(<HowItWorksModal initialStep={1} onClose={() => setShowMe(false)} />, document.body)}
    </div>
  );
}
