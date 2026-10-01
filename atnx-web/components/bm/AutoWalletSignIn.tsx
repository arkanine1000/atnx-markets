"use client";

import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import type { EIP1193Provider } from "viem";
import { useAuth } from "@/context/AuthContext";

// Connecting a wallet signs the user in: once per address per page load,
// so a refused signature does not loop; the Login button remains for a
// second try.
export function AutoWalletSignIn() {
  const { address, isConnected, connector } = useAccount();
  const { user, loading, signInWithWallet } = useAuth();
  const tried = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (loading || user || !isConnected || !address || !connector) return;
    if (tried.current.has(address)) return;
    tried.current.add(address);
    (async () => {
      try {
        const provider = (await connector.getProvider()) as EIP1193Provider;
        await signInWithWallet(provider, address);
      } catch (err) {
        console.warn("wallet sign-in skipped:", (err as Error).message);
      }
    })();
  }, [loading, user, isConnected, address, connector, signInWithWallet]);

  return null;
}
