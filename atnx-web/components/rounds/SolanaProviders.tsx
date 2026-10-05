"use client";

import type { ReactNode } from "react";
import type { ConnectionConfig } from "@solana/web3.js";
import type { Adapter } from "@solana/wallet-adapter-base";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { SOL_DEVNET } from "@/lib/bm/chains";

// Solana wallet and RPC for the rounds. No wallet adapters are listed:
// Phantom, Solflare and Backpack announce themselves through the Wallet
// Standard and the provider picks them up. Both props are module
// constants because the providers memoise on their identity (a fresh
// config object per render would build a new Connection every render).
// The endpoint comes from lib/bm/chains.ts rather than the program
// helpers so the root layout does not pull Anchor into every page.

const WALLETS: Adapter[] = [];
const CONNECTION_CONFIG: ConnectionConfig = { commitment: "confirmed" };

export function SolanaProviders({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider endpoint={SOL_DEVNET.rpcUrl} config={CONNECTION_CONFIG}>
      <WalletProvider wallets={WALLETS} autoConnect localStorageKey="atnx:sol-wallet">
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
