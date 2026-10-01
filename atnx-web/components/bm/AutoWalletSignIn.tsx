"use client";

import { useEffect, useRef } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { useAuth } from "@/context/AuthContext";

// Connecting a wallet signs the user in: once per address per page load,
// so a refused signature does not loop. Reconnecting after a refusal
// (or the login modal) tries again.
export function AutoWalletSignIn() {
  const { address, chainId, isConnected } = useAccount();
  const { user, loading, signInWithWallet } = useAuth();
  const { signMessageAsync } = useSignMessage();
  const tried = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (loading || user || !isConnected || !address || !chainId) return;
    if (tried.current.has(address)) return;
    tried.current.add(address);
    signInWithWallet({ address, chainId, sign: (message) => signMessageAsync({ message }) }).catch((err) => {
      console.warn("wallet sign-in skipped:", (err as Error).message);
    });
  }, [loading, user, isConnected, address, chainId, signInWithWallet, signMessageAsync]);

  // A fresh connection (new address) gets a fresh attempt.
  useEffect(() => {
    if (!isConnected) tried.current.clear();
  }, [isConnected]);

  return null;
}
