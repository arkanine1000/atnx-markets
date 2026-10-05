// Browser-safe access to the vi_rounds Anchor program (programs/vi_rounds):
// constants, PDAs, account decoding and instruction builders. No fs, no
// secrets: the web ticket imports this file, the keeper imports it through
// ./sol (which adds the keeper key and the senders).
//
// The IDL is lib/bm/idl/vi_rounds.json, copied there by
// `programs/deploy.sh vi_rounds`. Anchor camelCases the IDL on load, so
// accounts are `series`, `round`, `position`, `config` and fields read
// `presaleUp`, `mUp`, `closeAt` and so on.
import * as anchor from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  type TransactionInstruction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import idlJson from './idl/vi_rounds.json';

export const SOL_CHAIN_KEY = 'solana:devnet' as const;
export const USDG_DECIMALS = 6;

const DEFAULT_PROGRAM = '5PsYwtsaexsFLGz6pwnVAtBTLzRqmGHxQJFnYWv42aQX';

export const PROGRAM_ID: PublicKey = new PublicKey(process.env.NEXT_PUBLIC_BM_SOL_PROGRAM || DEFAULT_PROGRAM);
export const USDG_MINT: PublicKey | null = process.env.NEXT_PUBLIC_BM_SOL_USDG
  ? new PublicKey(process.env.NEXT_PUBLIC_BM_SOL_USDG)
  : null;
export const RPC_URL: string = process.env.NEXT_PUBLIC_BM_SOL_RPC || 'https://api.devnet.solana.com';

// ------------------------------------------------------------ references

// The 32-byte series reference: bytes 0–15 the ATNX market uuid, byte 16
// a flag (1 = the fast demo series), bytes 17–23 reserved zero, bytes
// 24–31 a big-endian u64 nonce. The nonce lets a market start a new series
// of the same speed after an earlier one has ended (the Series PDA is
// seeded by the reference, so each reference can exist only once). Pass
// the nonce as 8 bytes or as a non-negative safe integer; omitted, it is 0.
// The reference of a live series is stored in bm.series.reference; read it
// back with refFromHex, never recompute it.
export function refForSeries(atnxMarketId: string, fast: boolean, nonce: Uint8Array | number = 0): Uint8Array {
  const hex = atnxMarketId.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('refForSeries: not a uuid');
  const ref = new Uint8Array(32);
  for (let i = 0; i < 16; i++) ref[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  ref[16] = fast ? 1 : 0;
  if (typeof nonce === 'number') {
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('refForSeries: nonce must be a non-negative integer');
    let n = BigInt(nonce);
    for (let i = 31; i >= 24; i--) {
      ref[i] = Number(n & 0xffn);
      n >>= 8n;
    }
  } else {
    if (nonce.length !== 8) throw new Error('refForSeries: nonce must be 8 bytes');
    ref.set(nonce, 24);
  }
  return ref;
}

// A fresh reference for a new series: the nonce is the current unix time
// in seconds.
export function newSeriesRef(atnxMarketId: string, fast: boolean): Uint8Array {
  return refForSeries(atnxMarketId, fast, Math.floor(Date.now() / 1000));
}

// Lowercase hex, 64 characters, no 0x prefix.
export function refToHex(ref: Uint8Array): string {
  return Array.from(ref, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Inverse of refToHex; accepts an optional 0x prefix.
export function refFromHex(hex: string): Uint8Array {
  const h = hex.replace(/^0x/i, '');
  if (!/^[0-9a-f]{64}$/i.test(h)) throw new Error('refFromHex: need 32 bytes of hex');
  const ref = new Uint8Array(32);
  for (let i = 0; i < 32; i++) ref[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return ref;
}

// ------------------------------------------------------------------ PDAs

const enc = new TextEncoder();

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function pda(seeds: Uint8Array[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

export function configPda(): PublicKey {
  return pda([enc.encode('config')]);
}

export function pdas(ref: Uint8Array): {
  config: PublicKey;
  series: PublicKey;
  vault: PublicKey;
  round(index: number): PublicKey;
  position(round: PublicKey, holder: PublicKey): PublicKey;
} {
  if (ref.length !== 32) throw new Error('pdas: reference must be 32 bytes');
  const series = pda([enc.encode('series'), ref]);
  return {
    config: configPda(),
    series,
    vault: pda([enc.encode('vault'), series.toBytes()]),
    round: (index: number) => pda([enc.encode('round'), series.toBytes(), u32le(index)]),
    position: (round: PublicKey, holder: PublicKey) => pda([enc.encode('pos'), round.toBytes(), holder.toBytes()]),
  };
}

// --------------------------------------------------------------- program

export type RoundState = 'none' | 'presale' | 'live' | 'settled' | 'void';
export type RoundSide = 'up' | 'down';

export const SIDE_INDEX: Record<RoundSide, 0 | 1> = { up: 0, down: 1 };
const STATES: RoundState[] = ['none', 'presale', 'live', 'settled', 'void'];

type WalletLike = anchor.Wallet | { publicKey: PublicKey; signTransaction: any; signAllTransactions: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

const readOnlyWallet = {
  publicKey: PublicKey.default,
  signTransaction: async () => {
    throw new Error('read-only rounds program: no wallet');
  },
  signAllTransactions: async () => {
    throw new Error('read-only rounds program: no wallet');
  },
};

function idlForProgram(): anchor.Idl {
  return { ...(idlJson as unknown as anchor.Idl), address: PROGRAM_ID.toBase58() };
}

export function roundsProgram(connection: Connection, wallet?: WalletLike): anchor.Program {
  const provider = new anchor.AnchorProvider(connection, (wallet ?? readOnlyWallet) as anchor.Wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  return new anchor.Program(idlForProgram(), provider);
}

let decoder: anchor.Program | null = null;
function coder(): anchor.Program['coder'] {
  if (!decoder) decoder = roundsProgram(new Connection(RPC_URL, 'confirmed'));
  return decoder.coder;
}

// ------------------------------------------------------------- accounts

export interface SeriesAccount {
  key: PublicKey;
  finder: PublicKey;
  reference: Uint8Array;
  index: bigint;
  roundSecs: number;
  settleWindowSecs: number;
  feeBps: number;
  finderBps: number;
  ante: bigint;
  paused: boolean;
  liveRound: number;
  presaleRound: number;
  finderFees: bigint;
  platformFees: bigint;
}

export interface RoundAccount {
  key: PublicKey;
  series: PublicKey;
  index: number;
  state: RoundState;
  winner: RoundSide | null;
  presaleUp: bigint;
  presaleDown: bigint;
  mUp: bigint;
  mDown: bigint;
  nUp: bigint;
  nDown: bigint;
  openedAt: number;
  closeAt: number;
  tradeUntil: number;
  targetE2: bigint;
  settleE2: bigint;
  paidOut: bigint;
}

export interface PositionAccount {
  key: PublicKey;
  holder: PublicKey;
  round: PublicKey;
  presaleUp: bigint;
  presaleDown: bigint;
  stakeUp: bigint;
  stakeDown: bigint;
  sharesUp: bigint;
  sharesDown: bigint;
}

export interface ConfigAccount {
  authority: PublicKey;
  keeper: PublicKey;
  treasury: PublicKey;
  usdgMint: PublicKey;
  feeBps: number;
  finderBps: number;
  seriesCount: bigint;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const big = (v: any): bigint => BigInt(v.toString());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const num = (v: any): number => Number(v.toString());

export function decodeSeries(key: PublicKey, data: Buffer): SeriesAccount {
  const s = coder().accounts.decode('series', data);
  return {
    key,
    finder: s.finder,
    reference: Uint8Array.from(s.reference),
    index: big(s.index),
    roundSecs: num(s.roundSecs),
    settleWindowSecs: num(s.settleWindowSecs),
    feeBps: num(s.feeBps),
    finderBps: num(s.finderBps),
    ante: big(s.ante),
    paused: Boolean(s.paused),
    liveRound: num(s.liveRound),
    presaleRound: num(s.presaleRound),
    finderFees: big(s.finderFees),
    platformFees: big(s.platformFees),
  };
}

export function decodeRound(key: PublicKey, data: Buffer): RoundAccount {
  const r = coder().accounts.decode('round', data);
  const state = STATES[num(r.state)] ?? 'none';
  return {
    key,
    series: r.series,
    index: num(r.index),
    state,
    winner: state === 'settled' ? (num(r.winner) === 0 ? 'up' : 'down') : null,
    presaleUp: big(r.presaleUp),
    presaleDown: big(r.presaleDown),
    mUp: big(r.mUp),
    mDown: big(r.mDown),
    nUp: big(r.nUp),
    nDown: big(r.nDown),
    openedAt: num(r.openedAt),
    closeAt: num(r.closeAt),
    tradeUntil: num(r.tradeUntil),
    targetE2: big(r.targetE2),
    settleE2: big(r.settleE2),
    paidOut: big(r.paidOut),
  };
}

export function decodePosition(key: PublicKey, data: Buffer): PositionAccount {
  const p = coder().accounts.decode('position', data);
  return {
    key,
    holder: p.holder,
    round: p.round,
    presaleUp: big(p.presaleUp),
    presaleDown: big(p.presaleDown),
    stakeUp: big(p.stakeUp),
    stakeDown: big(p.stakeDown),
    sharesUp: big(p.sharesUp),
    sharesDown: big(p.sharesDown),
  };
}

export function decodeConfig(data: Buffer): ConfigAccount {
  const c = coder().accounts.decode('config', data);
  return {
    authority: c.authority,
    keeper: c.keeper,
    treasury: c.treasury,
    usdgMint: c.usdgMint,
    feeBps: num(c.feeBps),
    finderBps: num(c.finderBps),
    seriesCount: big(c.seriesCount),
  };
}

export async function fetchConfig(connection: Connection): Promise<ConfigAccount | null> {
  const info = await connection.getAccountInfo(configPda());
  return info ? decodeConfig(info.data) : null;
}

export async function fetchSeries(connection: Connection, key: PublicKey): Promise<SeriesAccount | null> {
  const info = await connection.getAccountInfo(key);
  return info ? decodeSeries(key, info.data) : null;
}

export async function fetchRound(connection: Connection, key: PublicKey): Promise<RoundAccount | null> {
  const info = await connection.getAccountInfo(key);
  return info ? decodeRound(key, info.data) : null;
}

export async function fetchRounds(connection: Connection, keys: PublicKey[]): Promise<(RoundAccount | null)[]> {
  const out: (RoundAccount | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk);
    infos.forEach((info, j) => out.push(info ? decodeRound(chunk[j], info.data) : null));
  }
  return out;
}

export async function fetchPosition(connection: Connection, key: PublicKey): Promise<PositionAccount | null> {
  const info = await connection.getAccountInfo(key);
  return info ? decodePosition(key, info.data) : null;
}

// Every open position of a holder across all series and rounds.
export async function fetchPositionsByHolder(connection: Connection, holder: PublicKey): Promise<PositionAccount[]> {
  const disc = coder().accounts.memcmp('position') as { offset: number; bytes: string };
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: disc.bytes } }, { memcmp: { offset: 8, bytes: holder.toBase58() } }],
  });
  return accounts.map((a) => decodePosition(a.pubkey, a.account.data));
}

// The USDG mint: NEXT_PUBLIC_BM_SOL_USDG, else read once from the config.
const mintCache = new Map<string, Promise<PublicKey>>();
export function fetchUsdgMint(connection: Connection): Promise<PublicKey> {
  if (USDG_MINT) return Promise.resolve(USDG_MINT);
  const k = connection.rpcEndpoint;
  let p = mintCache.get(k);
  if (!p) {
    p = fetchConfig(connection).then((c) => {
      if (!c) throw new Error(`vi_rounds config not initialised for ${PROGRAM_ID.toBase58()}`);
      return c.usdgMint;
    });
    p.catch(() => mintCache.delete(k));
    mintCache.set(k, p);
  }
  return p;
}

// ---------------------------------------------------------- instructions

const bn = (v: bigint | number) => new anchor.BN(v.toString());

export function instructionBuilders(program: anchor.Program) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = program.methods as any;
  const connection = program.provider.connection;
  const mint = () => fetchUsdgMint(connection);

  return {
    async commit(args: { ref: Uint8Array; roundIndex: number; side: RoundSide; amount: bigint; holder: PublicKey }): Promise<TransactionInstruction> {
      const p = pdas(args.ref);
      const round = p.round(args.roundIndex);
      return methods
        .commit(SIDE_INDEX[args.side], bn(args.amount))
        .accountsStrict({
          config: p.config,
          series: p.series,
          round,
          vault: p.vault,
          position: p.position(round, args.holder),
          holderUsdg: getAssociatedTokenAddressSync(await mint(), args.holder),
          holder: args.holder,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
    },

    async buy(args: { ref: Uint8Array; roundIndex: number; side: RoundSide; amount: bigint; minShares: bigint; holder: PublicKey }): Promise<TransactionInstruction> {
      const p = pdas(args.ref);
      const round = p.round(args.roundIndex);
      return methods
        .buy(SIDE_INDEX[args.side], bn(args.amount), bn(args.minShares))
        .accountsStrict({
          config: p.config,
          series: p.series,
          round,
          vault: p.vault,
          position: p.position(round, args.holder),
          holderUsdg: getAssociatedTokenAddressSync(await mint(), args.holder),
          holder: args.holder,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
    },

    async claim(args: { ref: Uint8Array; roundIndex: number; holder: PublicKey }): Promise<TransactionInstruction> {
      const p = pdas(args.ref);
      const round = p.round(args.roundIndex);
      return methods
        .claim()
        .accountsStrict({
          config: p.config,
          series: p.series,
          round,
          vault: p.vault,
          position: p.position(round, args.holder),
          holderUsdg: getAssociatedTokenAddressSync(await mint(), args.holder),
          holder: args.holder,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
    },

    async claimRollover(args: { ref: Uint8Array; roundIndex: number; nextRoundIndex: number; holder: PublicKey }): Promise<TransactionInstruction> {
      const p = pdas(args.ref);
      const round = p.round(args.roundIndex);
      const nextRound = p.round(args.nextRoundIndex);
      return methods
        .claimRollover()
        .accountsStrict({
          config: p.config,
          series: p.series,
          round,
          nextRound,
          position: p.position(round, args.holder),
          nextPosition: p.position(nextRound, args.holder),
          holder: args.holder,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
    },

    async faucet(args: { to: PublicKey; amount: bigint }): Promise<TransactionInstruction> {
      return methods
        .faucet(bn(args.amount))
        .accountsStrict({ config: configPda(), usdgMint: await mint(), to: args.to, tokenProgram: TOKEN_PROGRAM_ID })
        .instruction();
    },

    async withdrawFees(args: { ref: Uint8Array; signer: PublicKey }): Promise<TransactionInstruction> {
      const p = pdas(args.ref);
      return methods
        .withdrawFees()
        .accountsStrict({
          config: p.config,
          series: p.series,
          vault: p.vault,
          to: getAssociatedTokenAddressSync(await mint(), args.signer),
          signer: args.signer,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
    },
  };
}

// Keeper-only instructions (the program checks the keeper signature).
// Exported here so scripts can build them with any signer, e.g. to test
// that a non-keeper is refused.
export function keeperInstructionBuilders(program: anchor.Program) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = program.methods as any;
  const connection = program.provider.connection;

  return {
    async createSeries(args: { ref: Uint8Array; roundSecs: number; settleWindowSecs: number; ante: bigint; finder: PublicKey; keeper: PublicKey }): Promise<TransactionInstruction> {
      const p = pdas(args.ref);
      return methods
        .createSeries(Array.from(args.ref), args.roundSecs, args.settleWindowSecs, bn(args.ante), args.finder)
        .accountsStrict({
          config: p.config,
          series: p.series,
          vault: p.vault,
          round: p.round(1),
          usdgMint: await fetchUsdgMint(connection),
          keeper: args.keeper,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .instruction();
    },

    async setSeries(args: { ref: Uint8Array; paused?: boolean; finder?: PublicKey; ante?: bigint; signer: PublicKey }): Promise<TransactionInstruction> {
      const p = pdas(args.ref);
      return methods
        .setSeries(args.paused ?? null, args.finder ?? null, args.ante === undefined ? null : bn(args.ante))
        .accountsStrict({ config: p.config, series: p.series, signer: args.signer })
        .instruction();
    },

    async openRound(args: { ref: Uint8Array; roundIndex: number; targetE2: bigint; keeper: PublicKey }): Promise<TransactionInstruction> {
      const p = pdas(args.ref);
      return methods
        .openRound(bn(args.targetE2), args.roundIndex + 1)
        .accountsStrict({
          config: p.config,
          series: p.series,
          round: p.round(args.roundIndex),
          nextRound: p.round(args.roundIndex + 1),
          keeper: args.keeper,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
    },

    async settle(args: { ref: Uint8Array; roundIndex: number; settleE2: bigint; commitment?: Uint8Array; keeper: PublicKey }): Promise<TransactionInstruction> {
      const p = pdas(args.ref);
      const commitment = args.commitment ?? new Uint8Array(32);
      if (commitment.length !== 32) throw new Error('settle: commitment must be 32 bytes');
      return methods
        .settle(bn(args.settleE2), Array.from(commitment))
        .accountsStrict({ config: p.config, series: p.series, round: p.round(args.roundIndex), keeper: args.keeper })
        .instruction();
    },

    async voidRound(args: { ref: Uint8Array; roundIndex: number; keeper: PublicKey }): Promise<TransactionInstruction> {
      const p = pdas(args.ref);
      return methods
        .voidRound()
        .accountsStrict({ config: p.config, series: p.series, round: p.round(args.roundIndex), keeper: args.keeper })
        .instruction();
    },
  };
}

export function computeBudgetIxs(units = 200_000, microLamports = 1_000): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

// ---------------------------------------------------------------- errors

// Program logs carried by a failed send, whichever shape the error has.
export function txLogs(err: unknown): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  const logs = e?.logs ?? e?.transactionLogs ?? e?.transactionError?.logs ?? e?.simulationResponse?.logs;
  return Array.isArray(logs) ? logs : [];
}

// The Anchor error name (e.g. `TradingClosed`, `ConstraintHasOne`) behind a
// failed transaction, from its logs or its custom error code; null if none.
export function anchorErrorName(err: unknown): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  if (typeof e?.anchorError === 'string') return e.anchorError;
  if (typeof e?.error?.errorCode?.code === 'string') return e.error.errorCode.code;
  for (const line of txLogs(err)) {
    const m = /Error Code: (\w+)/.exec(line);
    if (m) return m[1];
  }
  const text = [String(e?.message ?? ''), ...txLogs(err)].join('\n');
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  if (hex) {
    const code = parseInt(hex[1], 16);
    const idlErr = ((idlJson as { errors?: { code: number; name: string }[] }).errors ?? []).find((x) => x.code === code);
    if (idlErr) return idlErr.name;
    const lang = Object.entries(anchor.LangErrorCode).find(([, v]) => v === code);
    if (lang) return lang[0];
    return `custom:${code}`;
  }
  return null;
}
