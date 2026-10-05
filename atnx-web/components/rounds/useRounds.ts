"use client";

import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { AccountLayout, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  USDG_MINT,
  anchorErrorName,
  computeBudgetIxs,
  fetchPosition,
  fetchPositionsByHolder,
  fetchRounds,
  fetchSeries,
  instructionBuilders,
  pdas,
  refFromHex,
  roundsProgram,
  type PositionAccount,
  type RoundAccount,
  type RoundSide,
  type SeriesAccount,
} from "@/lib/bm/sol-shared";
import { payoutIf, type PositionLike, type RoundLike } from "@/lib/bm/dpm";
import type { BmRoundRow, BmSeriesRow } from "@/lib/supabase/database-bm";

export { fmtLeft, fmtSpan, useNow } from "./time";

// --------------------------------------------------------------- wallet

// Local screenshots without a wallet extension: outside production,
// NEXT_PUBLIC_BM_MOCK_SOL_WALLET=<base58> reads that address as connected
// (a real devnet holder, so the ticket shows real positions). It cannot
// sign; every button that would send a transaction is disabled.
const MOCK_SOL_WALLET: PublicKey | null = (() => {
  if (process.env.NODE_ENV === "production") return null;
  const v = process.env.NEXT_PUBLIC_BM_MOCK_SOL_WALLET;
  if (!v) return null;
  try {
    return new PublicKey(v);
  } catch {
    return null;
  }
})();

export interface SolWallet {
  connected: boolean;
  connecting: boolean;
  publicKey: PublicKey | null;
  // False for the mock wallet: read-only.
  canSign: boolean;
  mock: boolean;
  walletName: string | null;
  disconnect: () => Promise<void>;
  sendTransaction: ReturnType<typeof useWallet>["sendTransaction"];
}

export function useSolWallet(): SolWallet {
  const w = useWallet();
  if (MOCK_SOL_WALLET && !w.connected) {
    return {
      connected: true,
      connecting: false,
      publicKey: MOCK_SOL_WALLET,
      canSign: false,
      mock: true,
      walletName: "Preview wallet",
      disconnect: async () => {},
      sendTransaction: w.sendTransaction,
    };
  }
  return {
    connected: w.connected && !!w.publicKey,
    connecting: w.connecting,
    publicKey: w.connected ? w.publicKey : null,
    canSign: w.connected && !!w.publicKey,
    mock: false,
    walletName: w.wallet?.adapter.name ?? null,
    disconnect: w.disconnect,
    sendTransaction: w.sendTransaction,
  };
}

export const MOCK_HINT = "Preview wallet: read-only. Connect a real wallet to trade.";

// ------------------------------------------------------------- registry

const IN_FLIGHT = new Set(["opening", "live", "settling"]);

export function liveRoundRow(rows: BmRoundRow[]): BmRoundRow | null {
  return rows.find((r) => IN_FLIGHT.has(r.state)) ?? null;
}

export function presaleRoundRow(rows: BmRoundRow[]): BmRoundRow | null {
  return rows.find((r) => r.state === "presale") ?? null;
}

export function seriesRef(series: BmSeriesRow): Uint8Array | null {
  try {
    return refFromHex(series.reference);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- chain

export interface RoundView {
  key: PublicKey;
  account: RoundAccount;
  row: BmRoundRow | null;
  position: PositionAccount | null;
}

export interface Claimable {
  key: PublicKey;
  account: RoundAccount;
  row: BmRoundRow | null;
  position: PositionAccount;
  amount: bigint;
  // Settled on the holder's side (or void); false: a losing position,
  // closed for its rent.
  won: boolean;
}

export interface RoundsSnapshot {
  series: SeriesAccount | null;
  live: RoundView | null;
  presale: RoundView | null;
  usdg: bigint;
  hasAta: boolean;
}

// What a position is owed once its round is settled or void, as the
// program's `due` computes it.
export function dueOf(r: RoundAccount, p: PositionAccount): bigint {
  if (r.state === "void") return p.presaleUp + p.presaleDown + p.stakeUp + p.stakeDown;
  if (r.state !== "settled" || !r.winner) return 0n;
  return safePayoutIf(p, r, r.winner) ?? 0n;
}

// A presale round read as if it opened now at its current pots, so a
// commit can be valued before the open.
export function asOpened(r: RoundAccount): RoundLike {
  const total = r.presaleUp + r.presaleDown;
  return { presaleUp: r.presaleUp, presaleDown: r.presaleDown, mUp: r.presaleUp, mDown: r.presaleDown, nUp: total, nDown: total };
}

export function safePayoutIf(pos: PositionLike, r: RoundLike, side: RoundSide): bigint | null {
  try {
    return payoutIf(pos, r, side);
  } catch {
    return null;
  }
}

export function holdsAnything(p: PositionAccount | null): boolean {
  return !!p && p.presaleUp + p.presaleDown + p.stakeUp + p.stakeDown > 0n;
}

export async function usdgBalance(connection: ReturnType<typeof useConnection>["connection"], holder: PublicKey): Promise<{ usdg: bigint; hasAta: boolean }> {
  if (!USDG_MINT) return { usdg: 0n, hasAta: false };
  const ata = getAssociatedTokenAddressSync(USDG_MINT, holder);
  const info = await connection.getAccountInfo(ata);
  if (!info) return { usdg: 0n, hasAta: false };
  return { usdg: AccountLayout.decode(info.data).amount, hasAta: true };
}

// The series' live and presale rounds, the holder's positions in both
// and the holder's USDG, polled every 5 s. Earlier rounds the holder can
// still claim come from useClaimables (slower, one scan of the holder's
// positions).
export function useRoundState(series: BmSeriesRow | null, rounds: BmRoundRow[]) {
  const { connection } = useConnection();
  const { publicKey } = useSolWallet();
  const holder = publicKey?.toBase58() ?? null;
  const seriesKey = series?.series_pubkey ?? null;
  const ref = useMemo(() => (series ? seriesRef(series) : null), [series]);

  const q = useQuery({
    queryKey: ["rounds", "state", connection.rpcEndpoint, seriesKey, holder],
    enabled: !!seriesKey && !!ref && !!USDG_MINT,
    refetchInterval: 5_000,
    queryFn: async (): Promise<RoundsSnapshot> => {
      const s = await fetchSeries(connection, new PublicKey(seriesKey!));
      const holderPk = holder ? new PublicKey(holder) : null;
      const balance = holderPk ? usdgBalance(connection, holderPk) : Promise.resolve({ usdg: 0n, hasAta: false });
      if (!s) return { series: null, live: null, presale: null, ...(await balance) };
      const p = pdas(ref!);
      const liveKey = s.liveRound ? p.round(s.liveRound) : null;
      const presaleKey = s.presaleRound ? p.round(s.presaleRound) : null;
      const keys = [liveKey, presaleKey].filter((k): k is PublicKey => !!k);
      const [accounts, positions, bal] = await Promise.all([
        fetchRounds(connection, keys),
        holderPk ? Promise.all(keys.map((k) => fetchPosition(connection, p.position(k, holderPk)))) : Promise.resolve(keys.map(() => null)),
        balance,
      ]);
      const view = (key: PublicKey | null): RoundView | null => {
        if (!key) return null;
        const i = keys.findIndex((k) => k.equals(key));
        const account = accounts[i];
        if (!account) return null;
        return { key, account, row: null, position: positions[i] ?? null };
      };
      return { series: s, live: view(liveKey), presale: view(presaleKey), ...bal };
    },
  });

  // Registry rows are joined here rather than in the query so a page
  // refresh (new rows) does not refetch the chain.
  const data = useMemo(() => {
    if (!q.data) return null;
    const rowFor = (v: RoundView | null) => (v ? { ...v, row: rounds.find((r) => r.idx === v.account.index) ?? null } : null);
    return { ...q.data, live: rowFor(q.data.live), presale: rowFor(q.data.presale) };
  }, [q.data, rounds]);

  return {
    data,
    ref,
    loading: q.isLoading,
    error: q.error as Error | null,
    refetch: q.refetch,
  };
}

// Settled and void rounds of this series where the holder still has a
// position: one scan of the holder's positions, then the rounds.
export function useClaimables(series: BmSeriesRow | null, rounds: BmRoundRow[]) {
  const { connection } = useConnection();
  const { publicKey } = useSolWallet();
  const holder = publicKey?.toBase58() ?? null;
  const seriesKey = series?.series_pubkey ?? null;

  const q = useQuery({
    queryKey: ["rounds", "claimables", connection.rpcEndpoint, seriesKey, holder],
    enabled: !!seriesKey && !!holder && !!USDG_MINT,
    refetchInterval: 15_000,
    queryFn: async () => {
      const positions = await fetchPositionsByHolder(connection, new PublicKey(holder!));
      if (positions.length === 0) return [];
      const accounts = await fetchRounds(connection, positions.map((p) => p.round));
      const out: Array<{ key: PublicKey; account: RoundAccount; position: PositionAccount }> = [];
      positions.forEach((position, i) => {
        const account = accounts[i];
        if (!account || account.series.toBase58() !== seriesKey) return;
        if (account.state !== "settled" && account.state !== "void") return;
        out.push({ key: account.key, account, position });
      });
      return out.sort((a, b) => b.account.index - a.account.index);
    },
  });

  const data = useMemo<Claimable[]>(
    () =>
      (q.data ?? []).map((c) => {
        const amount = dueOf(c.account, c.position);
        return {
          ...c,
          row: rounds.find((r) => r.idx === c.account.index) ?? null,
          amount,
          won: c.account.state === "void" || amount > 0n,
        };
      }),
    [q.data, rounds],
  );

  return { data, loading: q.isLoading, refetch: q.refetch };
}

// ----------------------------------------------------------------- send

export type RoundsBuilders = ReturnType<typeof instructionBuilders>;

// Builds a transaction from the compute budget plus the given
// instructions, has the wallet sign and send it, waits for confirmation
// and refreshes every rounds query. Returns the signature.
export function useSendRounds() {
  const { connection } = useConnection();
  const wallet = useSolWallet();
  const queryClient = useQueryClient();
  const builders = useMemo(() => instructionBuilders(roundsProgram(connection)), [connection]);
  const { publicKey, sendTransaction, canSign } = wallet;

  const send = useCallback(
    async (build: (b: RoundsBuilders, holder: PublicKey) => Promise<TransactionInstruction[]>): Promise<string> => {
      if (!publicKey || !canSign) throw new Error("Connect a wallet that can sign.");
      const ixs = await build(builders, publicKey);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(...computeBudgetIxs(), ...ixs);
      const signature = await sendTransaction(tx, connection, { preflightCommitment: "confirmed" });
      const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (res.value.err) throw new Error(`Transaction failed: ${JSON.stringify(res.value.err)}`);
      void queryClient.invalidateQueries({ queryKey: ["rounds"] });
      return signature;
    },
    [builders, connection, publicKey, sendTransaction, canSign, queryClient],
  );

  return { send, ready: canSign && !!publicKey, mock: wallet.mock };
}

// The program's error names in words; anything else, the first line.
const ERRORS: Record<string, string> = {
  TradingClosed: "Trading has closed for this round's averaging window.",
  NotPresale: "This round is no longer taking commits. Reload to see the next one.",
  NotLive: "This round is no longer live. Reload to see where it stands.",
  Paused: "This series is paused.",
  Slippage: "The price moved while you were confirming. Try again.",
  RatioTooLarge: "That buy is too large for the money on this side.",
  NothingToClaim: "Nothing to claim on this round.",
  NotSettled: "This round is not settled yet.",
  ZeroAmount: "The amount is too small.",
};

export function friendlySolError(err: unknown): string {
  const name = anchorErrorName(err);
  if (name && ERRORS[name]) return ERRORS[name];
  const msg = String((err as Error)?.message ?? err).split("\n")[0];
  if (/rejected|denied|cancel/i.test(msg)) return "Cancelled in the wallet.";
  if (/insufficient (funds|lamports)|debit an account|no record of a prior credit/i.test(msg)) return "Not enough devnet SOL for the fee. Get some at faucet.solana.com.";
  if (/blockhash|block height exceeded|expired/i.test(msg)) return "The transaction expired before it landed. Try again.";
  if (name) return `The program refused: ${name}.`;
  return msg.slice(0, 140);
}
