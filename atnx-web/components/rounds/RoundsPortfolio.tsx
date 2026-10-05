"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Card, Chip, EmptyState, Readout, StatTile } from "@/components/ui";
import { fmtUsdg, shortAddress, shortHash } from "@/components/bm/format";
import { solTxUrl } from "@/lib/bm/chains";
import {
  USDG_MINT,
  fetchPositionsByHolder,
  fetchRounds,
  fetchSeries,
  type PositionAccount,
  type RoundAccount,
  type SeriesAccount,
} from "@/lib/bm/sol-shared";
import { SolConnectButton } from "./SolConnectButton";
import { MOCK_HINT, asOpened, dueOf, friendlySolError, safePayoutIf, usdgBalance, useSendRounds, useSolWallet, type RoundsBuilders } from "./useRounds";

// The wallet's round positions on Solana devnet, every series: one scan
// of the program's position accounts by holder, then their rounds and
// series. Open stakes show what each outcome would pay at the pools as
// they stand; settled and void rounds offer Claim, Roll and Close.

export interface PortfolioSeries {
  seriesPubkey: string;
  atnxMarketId: string;
  name: string;
  thumb: string | null;
  fast: boolean;
}

interface Item {
  position: PositionAccount;
  round: RoundAccount;
  series: SeriesAccount;
}

export function RoundsPortfolio({ series }: { series: PortfolioSeries[] }) {
  const wallet = useSolWallet();
  const { connection } = useConnection();
  const { send } = useSendRounds();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const holder = wallet.publicKey?.toBase58() ?? null;

  const q = useQuery({
    queryKey: ["rounds", "portfolio", connection.rpcEndpoint, holder],
    enabled: !!holder && !!USDG_MINT,
    refetchInterval: 15_000,
    queryFn: async () => {
      const holderPk = new PublicKey(holder!);
      const [positions, bal] = await Promise.all([fetchPositionsByHolder(connection, holderPk), usdgBalance(connection, holderPk)]);
      const rounds = positions.length > 0 ? await fetchRounds(connection, positions.map((p) => p.round)) : [];
      const seriesKeys = Array.from(new Set(rounds.filter((r): r is RoundAccount => !!r).map((r) => r.series.toBase58())));
      const accts = await Promise.all(seriesKeys.map((k) => fetchSeries(connection, new PublicKey(k))));
      const byKey = new Map(accts.filter((s): s is SeriesAccount => !!s).map((s) => [s.key.toBase58(), s]));
      const items: Item[] = [];
      positions.forEach((position, i) => {
        const round = rounds[i];
        const s = round ? byKey.get(round.series.toBase58()) : undefined;
        if (round && s) items.push({ position, round, series: s });
      });
      return { items, usdg: bal.usdg };
    },
  });

  if (!USDG_MINT) return null;

  if (!wallet.connected || !wallet.publicKey) {
    return (
      <EmptyState
        title="Connect a Solana wallet to see your rounds"
        body="Round stakes live in program accounts on Solana devnet, one per round you took part in."
        action={<SolConnectButton pill label="Connect Solana wallet" className="inline-block" />}
      />
    );
  }

  const items = q.data?.items ?? [];
  const open = items.filter((i) => i.round.state === "presale" || i.round.state === "live");
  const done = items
    .filter((i) => i.round.state === "settled" || i.round.state === "void")
    .map((i) => ({ ...i, amount: dueOf(i.round, i.position) }))
    .sort((a, b) => Number(b.amount - a.amount));
  const staked = open.reduce((a, i) => a + i.position.presaleUp + i.position.presaleDown + i.position.stakeUp + i.position.stakeDown, 0n);
  const claimable = done.reduce((a, i) => a + i.amount, 0n);
  const meta = new Map(series.map((s) => [s.seriesPubkey, s]));

  async function run(key: string, build: (b: RoundsBuilders, holder: PublicKey) => Promise<TransactionInstruction[]>) {
    setBusy(key);
    setError(null);
    try {
      setLastTx(await send(build));
      void q.refetch();
    } catch (err) {
      setError(friendlySolError(err));
    } finally {
      setBusy(null);
    }
  }

  const claim = (i: Item) =>
    run(`claim-${i.position.key.toBase58()}`, async (b, holder) => {
      const ata = getAssociatedTokenAddressSync(USDG_MINT!, holder);
      return [createAssociatedTokenAccountIdempotentInstruction(holder, ata, holder, USDG_MINT!), await b.claim({ ref: i.series.reference, roundIndex: i.round.index, holder })];
    });
  const roll = (i: Item) =>
    run(`roll-${i.position.key.toBase58()}`, async (b, holder) => [
      await b.claimRollover({ ref: i.series.reference, roundIndex: i.round.index, nextRoundIndex: i.series.presaleRound, holder }),
    ]);

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4 mb-6">
        <StatTile label="In open rounds" value={`${fmtUsdg(staked)} USDG`} hero sub={<span>{open.length} {open.length === 1 ? "position" : "positions"}</span>} className="col-span-2 md:col-span-1" />
        <StatTile
          label="To claim"
          value={<span className={claimable > 0n ? "text-atnx-cyan light:text-atnx-cyan-light" : ""}>{fmtUsdg(claimable)} USDG</span>}
          sub={<span>{done.length} finished {done.length === 1 ? "round" : "rounds"}</span>}
        />
        <StatTile label="Cash" value={`${fmtUsdg(q.data?.usdg ?? 0n)} USDG`} sub={<span>mock USDG on Solana devnet</span>} />
      </div>

      {wallet.mock && <p className="text-[11px] text-tertiary mb-3">{MOCK_HINT}</p>}
      {error && <p className="text-xs text-atnx-magenta mb-3 break-words">{error}</p>}
      {lastTx && (
        <a href={solTxUrl(lastTx)} target="_blank" rel="noreferrer" className="block mb-3 text-[11px] text-tertiary link-quiet">
          View last transaction {shortHash(lastTx)} ↗
        </a>
      )}

      {q.isLoading ? (
        <EmptyState title="Reading the chain" body="Your round positions are being looked up on Solana devnet." />
      ) : q.error ? (
        <EmptyState title="Could not read your positions" body={(q.error as Error).message.split("\n")[0]} />
      ) : items.length === 0 ? (
        <EmptyState
          title="No round positions yet"
          body="Pick a market with rounds and take a side: commit in the presale, or buy while the round is live."
          action={
            <Link href="/app" className="inline-block text-xs px-5 py-2.5 rounded-full btn-magenta font-bold">
              Browse markets
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {done.map((i) => (
            <PositionCard key={i.position.key.toBase58()} item={i} meta={meta.get(i.round.series.toBase58()) ?? null}>
              <div className="flex flex-wrap gap-1.5 justify-end">
                {i.amount > 0n ? (
                  <>
                    {i.round.state === "settled" && i.series.presaleRound > 0 && !i.series.paused && (
                      <button
                        type="button"
                        disabled={!!busy || wallet.mock}
                        onClick={() => roll(i)}
                        className="text-xs px-3 py-2 rounded-full border border-surface text-secondary btn-quiet font-bold cursor-pointer disabled:opacity-50"
                        title={`Commit the payout, less the fee, to ${i.round.winner?.toUpperCase()} in round ${i.series.presaleRound}`}
                      >
                        {busy === `roll-${i.position.key.toBase58()}` ? "Rolling…" : `Roll into round ${i.series.presaleRound}`}
                      </button>
                    )}
                    <button type="button" disabled={!!busy || wallet.mock} onClick={() => claim(i)} className="text-xs px-4 py-2 rounded-full btn-cyan font-bold cursor-pointer disabled:opacity-60">
                      {busy === `claim-${i.position.key.toBase58()}` ? "Claiming…" : `Claim ${fmtUsdg(i.amount)} USDG`}
                    </button>
                  </>
                ) : (
                  <button type="button" disabled={!!busy || wallet.mock} onClick={() => claim(i)} className="text-xs px-3 py-2 rounded-full border border-surface text-secondary btn-quiet cursor-pointer disabled:opacity-50">
                    {busy === `claim-${i.position.key.toBase58()}` ? "Closing…" : "Close position (returns rent)"}
                  </button>
                )}
              </div>
            </PositionCard>
          ))}
          {open.map((i) => (
            <PositionCard key={i.position.key.toBase58()} item={i} meta={meta.get(i.round.series.toBase58()) ?? null} />
          ))}
        </div>
      )}
    </div>
  );
}

function PositionCard({ item, meta, children }: { item: Item & { amount?: bigint }; meta: PortfolioSeries | null; children?: React.ReactNode }) {
  const { position: p, round: r } = item;
  const up = p.presaleUp + p.stakeUp;
  const down = p.presaleDown + p.stakeDown;
  const finished = r.state === "settled" || r.state === "void";
  const pools = r.state === "presale" ? asOpened(r) : r;
  const payUp = up > 0n ? safePayoutIf(p, pools, "up") : null;
  const payDown = down > 0n ? safePayoutIf(p, pools, "down") : null;
  const href = meta ? `/app/markets/${meta.atnxMarketId}` : null;
  const status =
    r.state === "presale" ? "Presale" : r.state === "live" ? "Live" : r.state === "void" ? "Void" : `Settled ${r.winner?.toUpperCase() ?? ""}`;
  const lost = finished && (item.amount ?? 0n) === 0n;

  return (
    <Card className={`p-4 sm:p-5 ${lost ? "opacity-70" : ""}`}>
      <div className="flex items-start gap-3">
        {meta?.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={meta.thumb} alt="" className="w-12 h-12 rounded-xl object-cover border border-surface bg-black shrink-0" />
        ) : (
          <div className="w-12 h-12 rounded-xl border border-surface bg-elevated shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          {href ? (
            <Link href={href} className="font-bold text-primary text-[15px] link-quiet break-words">
              {meta!.name}
            </Link>
          ) : (
            <span className="font-bold text-primary text-[15px]">Series {shortAddress(r.series.toBase58())}</span>
          )}
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <Chip tone={r.state === "settled" ? (r.winner === "up" ? "cyan" : "magenta") : r.state === "live" ? "yellow" : "neutral"}>
              Round {r.index} · {status}
            </Chip>
            {meta?.fast && <Chip>fast</Chip>}
            {r.state === "live" && <span className="text-[11px] text-tertiary">target {Math.round(Number(r.targetE2) / 100)}</span>}
            {r.state === "settled" && (
              <span className="text-[11px] text-tertiary">
                {Math.round(Number(r.settleE2) / 100)} against {Math.round(Number(r.targetE2) / 100)}
              </span>
            )}
          </div>
        </div>
        {finished && (
          <div className="text-right shrink-0">
            <div className={`font-display text-2xl font-bold leading-none tabular-nums ${lost ? "text-tertiary" : "text-atnx-cyan light:text-atnx-cyan-light"}`}>
              {fmtUsdg(item.amount ?? 0n)}
            </div>
            <div className="text-[11px] text-tertiary mt-1">{lost ? "lost" : r.state === "void" ? "refund" : "to claim"}</div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 mt-4 pt-3 border-t border-surface">
        <Readout label="On UP" value={`${fmtUsdg(up)}${payUp !== null && !finished ? ` → ${fmtUsdg(payUp)}` : ""}`} valueClassName="text-atnx-cyan light:text-atnx-cyan-light" />
        <Readout label="On DOWN" value={`${fmtUsdg(down)}${payDown !== null && !finished ? ` → ${fmtUsdg(payDown)}` : ""}`} valueClassName="text-atnx-magenta light:text-atnx-magenta-light" />
      </div>
      {!finished && <p className="text-[11px] text-tertiary mt-2">Stake → what that side pays if it wins, at the pools as they are now.</p>}

      {children && <div className="mt-3 pt-3 border-t border-surface">{children}</div>}
    </Card>
  );
}
