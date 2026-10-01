"use client";

import { useState, type ReactNode } from "react";
import { WagmiProvider, type State } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "@/lib/bm/wagmi";

// Wallet and chain state for the whole site: the login modal (root
// layout) signs in with the connected wallet, so wagmi is mounted at the
// root. `initialState` comes from the wagmi cookie the server read, so
// the first paint already shows the connected wallet.
export function Web3Providers({ children, initialState }: { children: ReactNode; initialState?: State }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
