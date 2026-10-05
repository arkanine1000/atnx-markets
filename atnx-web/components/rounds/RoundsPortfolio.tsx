"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Card, EmptyState, StatTile } from "@/components/ui";
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
import { MOCK_HINT, dueOf, friendlySolError, safePayoutIf, usdgBalance, useSendRounds, useSolWallet, type RoundsBuilders } from "./useRounds";

// The wallet's round positions on Solana devnet, every series: one scan
// of the program's position accounts by holder, then their rounds and
// series. One row per position, named by market: open stakes first (what
// the held side pays at the pools as they stand), then settled and void
// rounds with their one action (Claim, with Roll beside it, or Close).

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
        action={<SolConnectButton pill label="Connect Solana wallet" className="inline-block" />}
      />
    );
  }

  const items = q.data?.items ?? [];
  const open = items
    .filter((i) => i.round.state === "presale" || i.round.state === "live")
    .sort((a, b) => (a.round.state === b.round.state ? b.round.index - a.round.index : a.round.state === "live" ? -1 : 1));
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
        <EmptyState title="Reading the chain…" />
      ) : q.error ? (
        <EmptyState title="Could not read your positions" body={(q.error as Error).message.split("\n")[0]} />
      ) : items.length === 0 ? (
        <EmptyState
          title="No round positions yet"
          body="Take a side on any market with rounds."
          action={
            <Link href="/app" className="inline-block text-xs px-5 py-2.5 rounded-full btn-magenta font-bold">
              Browse markets
            </Link>
          }
        />
      ) : (
        <div className="space-y-5">
          {open.length > 0 && (
            <Section label="Open">
              {open.map((i) => {
                const m = meta.get(i.round.series.toBase58()) ?? null;
                return (
                  <PositionRow key={i.position.key.toBase58()} item={i} meta={m}>
                    {m && (
                      <Link href={`/app/markets/${m.atnxMarketId}`} className="inline-block text-xs px-3 py-1.5 rounded-full border border-surface text-secondary btn-quiet font-bold">
                        Trade
                      </Link>
                    )}
                  </PositionRow>
                );
              })}
            </Section>
          )}
          {done.length > 0 && (
            <Section label="Settled">
              {done.map((i) => {
                const k = i.position.key.toBase58();
                const canRoll = i.amount > 0n && i.round.state === "settled" && i.series.presaleRound > 0 && !i.series.paused;
                return (
                  <PositionRow key={k} item={i} meta={meta.get(i.round.series.toBase58()) ?? null}>
                    {i.amount > 0n ? (
                      <span className="inline-flex items-center gap-2">
                        {canRoll && (
                          <button
                            type="button"
                            disabled={!!busy || wallet.mock}
                            onClick={() => roll(i)}
                            title={`Commit the payout, less the fee, to ${i.round.winner?.toUpperCase()} in round ${i.series.presaleRound}`}
                            className="text-[11px] text-tertiary link-quiet cursor-pointer disabled:opacity-50"
                          >
                            {busy === `roll-${k}` ? "Rolling…" : "Roll"}
                          </button>
                        )}
                        <button type="button" disabled={!!busy || wallet.mock} onClick={() => claim(i)} className="text-xs px-3 py-1.5 rounded-full btn-cyan font-bold cursor-pointer disabled:opacity-60">
                          {busy === `claim-${k}` ? "Claiming…" : "Claim"}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={!!busy || wallet.mock}
                        onClick={() => claim(i)}
                        title="Closes the position; its rent comes back to your wallet"
                        className="text-xs px-3 py-1.5 rounded-full border border-surface text-secondary btn-quiet cursor-pointer disabled:opacity-50"
                      >
                        {busy === `claim-${k}` ? "Closing…" : "Close"}
                      </button>
                    )}
                  </PositionRow>
                );
              })}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

// Market | Round | Side | Stake | Now | action. On phones the round, side
// and stake fold into a line under the market name.
const COLS = "grid grid-cols-[minmax(0,1fr)_auto_auto] sm:grid-cols-[minmax(0,1fr)_4.5rem_6rem_6rem_9.5rem_7rem] items-center gap-x-3";

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="text-sm font-bold text-primary mb-2">{label}</h4>
      <Card className="overflow-hidden">
        <div className={`${COLS} hidden sm:grid px-4 py-2 border-b border-surface text-[10px] font-mono uppercase tracking-wider text-tertiary`}>
          <span>Market</span>
          <span>Round</span>
          <span>Side</span>
          <span className="text-right">Stake</span>
          <span className="text-right">Now</span>
          <span />
        </div>
        <div>{children}</div>
      </Card>
    </div>
  );
}

function sideLabel(up: bigint, down: bigint) {
  if (up > 0n && down > 0n)
    return (
      <>
        <span className="text-atnx-cyan light:text-atnx-cyan-light">UP</span> + <span className="text-atnx-magenta light:text-atnx-magenta-light">DOWN</span>
      </>
    );
  return up > 0n ? <span className="text-atnx-cyan light:text-atnx-cyan-light">UP</span> : <span className="text-atnx-magenta light:text-atnx-magenta-light">DOWN</span>;
}

function PositionRow({ item, meta, children }: { item: Item & { amount?: bigint }; meta: PortfolioSeries | null; children?: ReactNode }) {
  const { position: p, round: r } = item;
  const up = p.presaleUp + p.stakeUp;
  const down = p.presaleDown + p.stakeDown;
  const stake = up + down;
  const amount = item.amount ?? 0n;
  const name = meta?.name ?? `Series ${shortAddress(r.series.toBase58())}`;
  const href = meta ? `/app/markets/${meta.atnxMarketId}` : null;
  const lost = (r.state === "settled" || r.state === "void") && amount === 0n;

  let now: ReactNode;
  if (r.state === "presale") now = <span className="text-tertiary">waiting to open</span>;
  else if (r.state === "live") {
    const payUp = up > 0n ? safePayoutIf(p, r, "up") : null;
    const payDown = down > 0n ? safePayoutIf(p, r, "down") : null;
    now = (
      <>
        {payUp !== null && (
          <span className="block">
            <span className="text-tertiary">if UP wins </span>
            <span className="tabular-nums font-bold text-primary">{fmtUsdg(payUp)}</span>
          </span>
        )}
        {payDown !== null && (
          <span className="block">
            <span className="text-tertiary">if DOWN wins </span>
            <span className="tabular-nums font-bold text-primary">{fmtUsdg(payDown)}</span>
          </span>
        )}
      </>
    );
  } else if (lost) now = <span className="text-tertiary">lost</span>;
  else
    now = (
      <span className="text-atnx-cyan light:text-atnx-cyan-light">
        {r.state === "void" ? "refund" : "claim"} <span className="tabular-nums font-bold">{fmtUsdg(amount)}</span>
      </span>
    );

  return (
    <div className={`${COLS} px-4 py-3 text-xs border-t border-surface first:border-t-0 ${lost ? "opacity-70" : ""}`}>
      <div className="min-w-0 flex items-center gap-2.5">
        {meta?.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={meta.thumb} alt="" className="w-8 h-8 rounded-lg object-cover border border-surface bg-black shrink-0" />
        ) : (
          <div className="w-8 h-8 rounded-lg border border-surface bg-elevated shrink-0" />
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            {href ? (
              <Link href={href} className="font-bold text-primary text-sm link-quiet truncate">
                {name}
              </Link>
            ) : (
              <span className="font-bold text-primary text-sm truncate">{name}</span>
            )}
            {meta?.fast && <span className="shrink-0 inline-flex items-center rounded-md border border-surface bg-elevated px-1.5 py-0.5 text-[11px] font-bold text-secondary tabular-nums whitespace-nowrap">Fast</span>}
          </div>
          <div className="sm:hidden text-[11px] text-tertiary mt-0.5 tabular-nums">
            Round {r.index} · {sideLabel(up, down)} · {fmtUsdg(stake)}
          </div>
        </div>
      </div>
      <span className="hidden sm:block text-secondary tabular-nums">Round {r.index}</span>
      <span className="hidden sm:block font-bold">{sideLabel(up, down)}</span>
      <span className="hidden sm:block text-right text-secondary tabular-nums">{fmtUsdg(stake)}</span>
      <span className="text-right leading-snug">{now}</span>
      <span className="flex justify-end">{children}</span>
    </div>
  );
}
