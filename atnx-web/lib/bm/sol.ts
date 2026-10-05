// Server-side Solana access for the rounds keeper: one connection and one
// program instance per process, the keeper key (authority, keeper and
// treasury on devnet), readers and senders. Parallel to ./evm. The browser
// uses ./sol-shared directly with the wallet adapter.
import * as anchor from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  RPC_URL,
  anchorErrorName,
  computeBudgetIxs,
  fetchRound,
  fetchRounds,
  fetchSeries,
  fetchUsdgMint,
  instructionBuilders,
  keeperInstructionBuilders,
  pdas,
  roundsProgram,
  txLogs,
  type RoundAccount,
  type RoundSide,
  type SeriesAccount,
} from './sol-shared';

export * from './sol-shared';

const MAX_FAUCET = 10_000_000_000n; // 10,000 USDG, the program's per-call cap

let connection: Connection | null = null;
let keeper: Keypair | null = null;
let program: anchor.Program | null = null;

export function solConnection(): Connection {
  if (!connection) connection = new Connection(RPC_URL, 'confirmed');
  return connection;
}

// BM_SOL_KEEPER_SECRET: a JSON array of 64 numbers (solana-keygen format)
// or the same 64 bytes in base58.
export function keeperKeypair(): Keypair {
  if (keeper) return keeper;
  const raw = process.env.BM_SOL_KEEPER_SECRET?.trim();
  if (!raw) throw new Error('BM_SOL_KEEPER_SECRET is missing (JSON array of 64 numbers or base58 secret key)');
  let bytes: Uint8Array;
  try {
    bytes = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw) as number[]) : anchor.utils.bytes.bs58.decode(raw);
  } catch {
    throw new Error('BM_SOL_KEEPER_SECRET is not a JSON byte array or base58 string');
  }
  if (bytes.length !== 64) throw new Error(`BM_SOL_KEEPER_SECRET must hold 64 bytes, got ${bytes.length}`);
  keeper = Keypair.fromSecretKey(bytes);
  return keeper;
}

// Anchor's own Wallet class lives only in its CommonJS build (it is Node-only),
// so the ESM bundle Turbopack picks has no `Wallet` export. This is the same
// three methods over a Keypair, which is all AnchorProvider needs.
function keypairWallet(kp: Keypair) {
  const signOne = async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
    if (tx instanceof VersionedTransaction) tx.sign([kp]);
    else tx.partialSign(kp);
    return tx;
  };
  return {
    publicKey: kp.publicKey,
    payer: kp,
    signTransaction: signOne,
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => Promise.all(txs.map(signOne)),
  };
}

export function keeperProgram(): anchor.Program {
  if (!program) program = roundsProgram(solConnection(), keypairWallet(keeperKeypair()));
  return program;
}

// --------------------------------------------------------------- readers

export function readSeries(key: PublicKey): Promise<SeriesAccount | null> {
  return fetchSeries(solConnection(), key);
}

export function readRound(key: PublicKey): Promise<RoundAccount | null> {
  return fetchRound(solConnection(), key);
}

export function readRounds(keys: PublicKey[]): Promise<(RoundAccount | null)[]> {
  return fetchRounds(solConnection(), keys);
}

// --------------------------------------------------------------- senders

// Compute budget first, keeper signs and pays. A program error is
// rethrown with its Anchor name in the message and on `anchorError`, the
// logs on `logs`.
async function send(label: string, ixs: TransactionInstruction[]): Promise<string> {
  const tx = new Transaction().add(...computeBudgetIxs(), ...ixs);
  try {
    return await sendAndConfirmTransaction(solConnection(), tx, [keeperKeypair()], { commitment: 'confirmed' });
  } catch (err) {
    let logs = txLogs(err);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = err as any;
    if (logs.length === 0 && typeof e?.getLogs === 'function') {
      logs = await e.getLogs(solConnection()).catch(() => []);
    }
    const name = anchorErrorName({ message: e?.message, logs });
    const out = new Error(`${label}: ${name ?? (e?.message as string) ?? String(err)}`, { cause: err }) as Error & {
      anchorError: string | null;
      logs: string[];
    };
    out.anchorError = name;
    out.logs = logs;
    throw out;
  }
}

export async function sendCreateSeries(args: {
  ref: Uint8Array;
  roundSecs: number;
  settleWindowSecs: number;
  ante: bigint;
  finder: PublicKey;
}): Promise<{ sig: string; series: PublicKey; round: PublicKey }> {
  const k = keeperKeypair().publicKey;
  const ix = await keeperInstructionBuilders(keeperProgram()).createSeries({ ...args, keeper: k });
  const sig = await send('create_series', [ix]);
  const p = pdas(args.ref);
  return { sig, series: p.series, round: p.round(1) };
}

// The keeper's own presale commit: the ante on an empty side.
export async function sendCommit(args: { ref: Uint8Array; roundIndex: number; side: RoundSide; amount: bigint }): Promise<string> {
  const ix = await instructionBuilders(keeperProgram()).commit({ ...args, holder: keeperKeypair().publicKey });
  return send('commit', [ix]);
}

export async function sendOpenRound(args: { ref: Uint8Array; roundIndex: number; targetE2: bigint }): Promise<{ sig: string; nextRound: PublicKey }> {
  const ix = await keeperInstructionBuilders(keeperProgram()).openRound({ ...args, keeper: keeperKeypair().publicKey });
  const sig = await send('open_round', [ix]);
  return { sig, nextRound: pdas(args.ref).round(args.roundIndex + 1) };
}

export async function sendSettle(args: { ref: Uint8Array; roundIndex: number; settleE2: bigint; commitment?: Uint8Array }): Promise<string> {
  const ix = await keeperInstructionBuilders(keeperProgram()).settle({ ...args, keeper: keeperKeypair().publicKey });
  return send('settle', [ix]);
}

export async function sendVoid(args: { ref: Uint8Array; roundIndex: number }): Promise<string> {
  const ix = await keeperInstructionBuilders(keeperProgram()).voidRound({ ...args, keeper: keeperKeypair().publicKey });
  return send('void_round', [ix]);
}

export async function sendSetSeries(args: { ref: Uint8Array; paused?: boolean; finder?: PublicKey; ante?: bigint }): Promise<string> {
  const ix = await keeperInstructionBuilders(keeperProgram()).setSeries({ ...args, signer: keeperKeypair().publicKey });
  return send('set_series', [ix]);
}

// Makes sure the keeper can ante: creates its USDG account if needed and
// tops it up from the faucet (to 10,000 USDG, or `minimum` if higher) when
// the balance is under `minimum`. Returns the account.
export async function ensureKeeperUsdg(minimum: bigint): Promise<PublicKey> {
  const conn = solConnection();
  const owner = keeperKeypair().publicKey;
  const mint = await fetchUsdgMint(conn);
  const ata = getAssociatedTokenAddressSync(mint, owner);
  const info = await conn.getAccountInfo(ata);
  const balance = info ? BigInt((await conn.getTokenAccountBalance(ata)).value.amount) : 0n;
  const ixs: TransactionInstruction[] = info ? [] : [createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, mint)];
  if (balance < minimum) {
    let want = (minimum > MAX_FAUCET ? minimum : MAX_FAUCET) - balance;
    const builders = instructionBuilders(keeperProgram());
    while (want > 0n) {
      const amount = want > MAX_FAUCET ? MAX_FAUCET : want;
      ixs.push(await builders.faucet({ to: ata, amount }));
      want -= amount;
    }
  }
  if (ixs.length > 0) await send('ensure_keeper_usdg', ixs);
  return ata;
}

export async function sigStatus(sig: string): Promise<'confirmed' | 'failed' | 'pending'> {
  const { value } = await solConnection().getSignatureStatuses([sig], { searchTransactionHistory: true });
  const s = value[0];
  if (!s) return 'pending';
  if (s.err) return 'failed';
  return s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' ? 'confirmed' : 'pending';
}

export async function confirm(sig: string): Promise<void> {
  const conn = solConnection();
  const bh = await conn.getLatestBlockhash('confirmed');
  const res = await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
  if (res.value.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(res.value.err)}`);
}
