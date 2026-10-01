import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { BM_CHAINS, DEFAULT_CHAIN } from './chains';

// Browser wallet access: injected wallets only (MetaMask, Rabby, the
// Robinhood wallet's extension), no WalletConnect project. The chain list
// is the deploy config; the default chain comes first so a fresh connect
// lands on it.

const ordered = [BM_CHAINS[DEFAULT_CHAIN], ...Object.values(BM_CHAINS).filter((c) => c.key !== DEFAULT_CHAIN)];
const chains = ordered.map((c) => c.viemChain) as [typeof ordered[0]['viemChain'], ...Array<typeof ordered[0]['viemChain']>];

export const wagmiConfig = createConfig({
  chains,
  connectors: [injected()],
  transports: Object.fromEntries(ordered.map((c) => [c.chainId, http(c.rpcUrl)])),
  ssr: true,
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
