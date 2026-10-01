import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { boundedViMarketsAbi, mockUsdgAbi } from './abi';
import { BM_CHAINS, USDG_UNIT, isDeployed, type BmChain, type ChainKey } from './chains';
import { toE2 } from './bounds';
import type { BmSide } from '@/lib/supabase/database-bm';

// Server-side chain access for the keeper and the open-market flow: one
// public client per chain, one wallet (the keeper key) that is operator,
// oracle and treasury on the testnets. Browser-side calls go through
// wagmi instead (components/bm/*).

export const SIDE_INDEX: Record<BmSide, 0 | 1> = { up: 0, down: 1 };
export const INDEX_SIDE: BmSide[] = ['up', 'down'];

export const MARKET_STATUS = { none: 0, open: 1, resolved: 2 } as const;

const publicClients = new Map<ChainKey, PublicClient>();

export function publicClientFor(chain: BmChain): PublicClient {
  let c = publicClients.get(chain.key);
  if (!c) {
    c = createPublicClient({ chain: chain.viemChain, transport: http(chain.rpcUrl) });
    publicClients.set(chain.key, c);
  }
  return c;
}

let keeper: PrivateKeyAccount | null = null;

export function keeperAccount(): PrivateKeyAccount {
  if (keeper) return keeper;
  const key = process.env.BM_KEEPER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('BM_KEEPER_PRIVATE_KEY is missing or not a 0x-prefixed 32-byte hex key');
  }
  keeper = privateKeyToAccount(key as Hex);
  return keeper;
}

export function keeperAddress(): Address | null {
  try {
    return keeperAccount().address;
  } catch {
    return null;
  }
}

export function walletClientFor(chain: BmChain): WalletClient {
  return createWalletClient({
    account: keeperAccount(),
    chain: chain.viemChain,
    transport: http(chain.rpcUrl),
  });
}

export function requireDeployed(chain: BmChain): BmChain {
  if (!isDeployed(chain)) throw new Error(`${chain.label}: contracts not deployed (lib/bm/chains.ts)`);
  return chain;
}

// The on-chain reference for a bounded market: the atnx market uuid in
// the high 16 bytes, the roll counter in the low bytes.
export function refFor(atnxMarketId: string, roll: number): Hex {
  const uuid = atnxMarketId.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(uuid)) throw new Error('refFor: not a uuid');
  return `0x${uuid}${roll.toString(16).padStart(32, '0')}` as Hex;
}

export function usdgToUnits(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000));
}

export function unitsToUsdg(units: bigint): number {
  return Number(units) / 1_000_000;
}

export interface OnchainMarket {
  poolUp: bigint;
  poolDown: bigint;
  collateral: bigint;
  fees: bigint;
  startViE2: bigint;
  lowerE2: bigint;
  upperE2: bigint;
  resolvedViE2: bigint;
  createdAt: number;
  resolvedAt: number;
  status: number;
  winner: number;
  creator: Address;
  ref: Hex;
}

export async function readMarkets(chain: BmChain, ids: bigint[]): Promise<OnchainMarket[]> {
  if (ids.length === 0) return [];
  const out = await publicClientFor(chain).readContract({
    address: chain.markets,
    abi: boundedViMarketsAbi,
    functionName: 'getMarkets',
    args: [ids],
  });
  return out.map((m) => ({ ...m }));
}

export async function readMarket(chain: BmChain, id: bigint): Promise<OnchainMarket> {
  const [m] = await readMarkets(chain, [id]);
  return m;
}

export async function readBalances(chain: BmChain, holder: Address, ids: bigint[]): Promise<Array<[bigint, bigint]>> {
  if (ids.length === 0) return [];
  const out = await publicClientFor(chain).readContract({
    address: chain.markets,
    abi: boundedViMarketsAbi,
    functionName: 'balancesOf',
    args: [holder, ids],
  });
  return out.map((b) => [b[0], b[1]] as [bigint, bigint]);
}

// Makes sure the keeper holds and has approved at least `seed` USDG for
// the markets contract. Mock USDG mints on request, so a short treasury
// just mints more (never more than the per-call cap).
export async function ensureSeed(chain: BmChain, seed: bigint, dry = false): Promise<string[]> {
  const did: string[] = [];
  const pc = publicClientFor(chain);
  const me = keeperAccount().address;
  const [balance, allowance] = await Promise.all([
    pc.readContract({ address: chain.usdg, abi: mockUsdgAbi, functionName: 'balanceOf', args: [me] }),
    pc.readContract({ address: chain.usdg, abi: mockUsdgAbi, functionName: 'allowance', args: [me, chain.markets] }),
  ]);
  if (balance < seed) {
    const cap = 10_000n * USDG_UNIT;
    const amount = seed > cap ? cap : seed;
    if (!dry) {
      const hash = await walletClientFor(chain).writeContract({
        address: chain.usdg,
        abi: mockUsdgAbi,
        functionName: 'mint',
        args: [me, amount],
        chain: chain.viemChain,
        account: keeperAccount(),
      });
      await pc.waitForTransactionReceipt({ hash, timeout: 60_000 });
    }
    did.push(`mint ${unitsToUsdg(amount)} USDG`);
  }
  if (allowance < seed) {
    if (!dry) {
      const hash = await walletClientFor(chain).writeContract({
        address: chain.usdg,
        abi: mockUsdgAbi,
        functionName: 'approve',
        args: [chain.markets, 2n ** 256n - 1n],
        chain: chain.viemChain,
        account: keeperAccount(),
      });
      await pc.waitForTransactionReceipt({ hash, timeout: 60_000 });
    }
    did.push('approve');
  }
  return did;
}

export interface CreateArgs {
  ref: Hex;
  creator: Address;
  startVi: number;
  lower: number;
  upper: number;
  seed: bigint;
  upBps: number;
}

// A nonce clash with a concurrent keeper write is retried once.
async function withNonceRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (/nonce|replacement|underpriced/i.test(msg)) {
      await new Promise((r) => setTimeout(r, 1500));
      return fn();
    }
    throw err;
  }
}

export async function sendCreateMarket(chain: BmChain, a: CreateArgs): Promise<Hex> {
  const pc = publicClientFor(chain);
  const account = keeperAccount();
  return withNonceRetry(async () => {
    const { request } = await pc.simulateContract({
      address: chain.markets,
      abi: boundedViMarketsAbi,
      functionName: 'createMarket',
      args: [a.ref, a.creator, toE2(a.startVi), toE2(a.lower), toE2(a.upper), a.seed, a.upBps],
      account,
    });
    return walletClientFor(chain).writeContract(request);
  });
}

export async function sendResolve(chain: BmChain, id: bigint, side: BmSide, vi: number): Promise<Hex> {
  const pc = publicClientFor(chain);
  const account = keeperAccount();
  return withNonceRetry(async () => {
    const { request } = await pc.simulateContract({
      address: chain.markets,
      abi: boundedViMarketsAbi,
      functionName: 'resolve',
      args: [id, SIDE_INDEX[side], toE2(vi)],
      account,
    });
    return walletClientFor(chain).writeContract(request);
  });
}

export async function waitReceipt(chain: BmChain, hash: Hex, timeoutMs = 45_000): Promise<TransactionReceipt> {
  return publicClientFor(chain).waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 1_500 });
}

// null when the transaction is not mined yet.
export async function getReceipt(chain: BmChain, hash: Hex): Promise<TransactionReceipt | null> {
  try {
    return await publicClientFor(chain).getTransactionReceipt({ hash });
  } catch {
    return null;
  }
}

export function marketIdFromReceipt(receipt: TransactionReceipt): bigint | null {
  const logs = parseEventLogs({ abi: boundedViMarketsAbi, logs: receipt.logs, eventName: 'MarketCreated' });
  return logs.length ? logs[0].args.id : null;
}

export function chainsWithKeeper(): BmChain[] {
  return Object.values(BM_CHAINS).filter(isDeployed);
}
