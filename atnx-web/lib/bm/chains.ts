import { arbitrumSepolia, robinhoodTestnet, type Chain } from 'viem/chains';
import type { Address } from 'viem';

// The chains the bounded markets are deployed on. Keys are CAIP-2 style, so
// the Solana entry for the rounds ('solana:devnet', SOL_DEVNET below) uses
// the same scheme in the registry. Addresses are filled in after each deploy
// (contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json) and can be
// overridden per environment without a code change.

export type ChainKey = 'eip155:46630' | 'eip155:421614';

export interface BmChain {
  key: ChainKey;
  kind: 'evm';
  chainId: number;
  label: string;
  short: string;
  viemChain: Chain;
  rpcUrl: string;
  explorer: string;
  markets: Address;
  usdg: Address;
  deployBlock: bigint;
}

const ZERO: Address = '0x0000000000000000000000000000000000000000';

function addr(envName: string, fallback: Address): Address {
  const v = process.env[envName];
  return (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : fallback) as Address;
}

export const BM_CHAINS: Record<ChainKey, BmChain> = {
  'eip155:46630': {
    key: 'eip155:46630',
    kind: 'evm',
    chainId: 46630,
    label: 'Robinhood Testnet',
    short: 'Robinhood',
    viemChain: robinhoodTestnet,
    rpcUrl: process.env.NEXT_PUBLIC_BM_RPC_46630 ?? 'https://rpc.testnet.chain.robinhood.com',
    explorer: 'https://explorer.testnet.chain.robinhood.com',
    // Deployed 2026-10-01 (contracts/broadcast/Deploy.s.sol/46630).
    markets: addr('NEXT_PUBLIC_BM_MARKETS_46630', '0x0cDab5681546b887bA8772290869ef9001B2d47C'),
    usdg: addr('NEXT_PUBLIC_BM_USDG_46630', '0x3cCAADFa951Cd18fd68c2575402ee28E390Bf641'),
    deployBlock: BigInt(process.env.NEXT_PUBLIC_BM_DEPLOY_BLOCK_46630 ?? '127197452'),
  },
  'eip155:421614': {
    key: 'eip155:421614',
    kind: 'evm',
    chainId: 421614,
    label: 'Arbitrum Sepolia',
    short: 'Arbitrum',
    viemChain: arbitrumSepolia,
    rpcUrl: process.env.NEXT_PUBLIC_BM_RPC_421614 ?? 'https://sepolia-rollup.arbitrum.io/rpc',
    explorer: 'https://sepolia.arbiscan.io',
    markets: addr('NEXT_PUBLIC_BM_MARKETS_421614', ZERO),
    usdg: addr('NEXT_PUBLIC_BM_USDG_421614', ZERO),
    deployBlock: BigInt(process.env.NEXT_PUBLIC_BM_DEPLOY_BLOCK_421614 ?? '0'),
  },
};

export const CHAIN_KEYS = Object.keys(BM_CHAINS) as ChainKey[];

export const DEFAULT_CHAIN: ChainKey = (() => {
  const v = process.env.NEXT_PUBLIC_BM_DEFAULT_CHAIN;
  return v && v in BM_CHAINS ? (v as ChainKey) : 'eip155:46630';
})();

export function isChainKey(v: unknown): v is ChainKey {
  return typeof v === 'string' && v in BM_CHAINS;
}

export function chainByKey(key: string): BmChain | null {
  return isChainKey(key) ? BM_CHAINS[key] : null;
}

export function chainById(chainId: number): BmChain | null {
  return Object.values(BM_CHAINS).find((c) => c.chainId === chainId) ?? null;
}

// A chain whose contracts are not deployed yet is listed but not usable.
export function isDeployed(c: BmChain): boolean {
  return c.markets !== ZERO && c.usdg !== ZERO;
}

export function deployedChains(): BmChain[] {
  return Object.values(BM_CHAINS).filter(isDeployed);
}

export function txUrl(c: BmChain, hash: string): string {
  return `${c.explorer}/tx/${hash}`;
}

export function addressUrl(c: BmChain, address: string): string {
  return `${c.explorer}/address/${address}`;
}

// ------------------------------------------------------------ Solana

// The rounds program (programs/vi_rounds) runs on Solana devnet. It is not
// an EVM chain, so it sits beside BM_CHAINS rather than in it: the wagmi
// config and the bounded-market code keep reading BM_CHAINS only.

export interface SvmChain {
  key: 'solana:devnet';
  kind: 'svm';
  cluster: 'devnet';
  label: string;
  short: string;
  rpcUrl: string;
  explorer: string;
  programId: string;
  // The mock USDG mint the program created at `initialize`; null until the
  // deploy has been run and the env var set.
  usdgMint: string | null;
}

export type AnyChain = BmChain | SvmChain;

export const SOL_DEVNET: SvmChain = {
  key: 'solana:devnet',
  kind: 'svm',
  cluster: 'devnet',
  label: 'Solana Devnet',
  short: 'Solana',
  rpcUrl: process.env.NEXT_PUBLIC_BM_SOL_RPC || 'https://api.devnet.solana.com',
  explorer: 'https://explorer.solana.com',
  programId: process.env.NEXT_PUBLIC_BM_SOL_PROGRAM || '5PsYwtsaexsFLGz6pwnVAtBTLzRqmGHxQJFnYWv42aQX',
  usdgMint: process.env.NEXT_PUBLIC_BM_SOL_USDG || null,
};

// Rounds can be traded once the program has a USDG mint to settle in.
export function isRoundsDeployed(c: SvmChain = SOL_DEVNET): boolean {
  return !!c.programId && !!c.usdgMint;
}

export function solTxUrl(signature: string, c: SvmChain = SOL_DEVNET): string {
  return `${c.explorer}/tx/${signature}?cluster=${c.cluster}`;
}

export function solAddressUrl(address: string, c: SvmChain = SOL_DEVNET): string {
  return `${c.explorer}/address/${address}?cluster=${c.cluster}`;
}

// Mock USDG has 6 decimals, like the real one.
export const USDG_DECIMALS = 6;
export const USDG_UNIT = 10n ** 6n;
