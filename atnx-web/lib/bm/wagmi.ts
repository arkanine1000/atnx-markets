import { cookieStorage, createConfig, createStorage, http } from 'wagmi';
import { injected, walletConnect } from 'wagmi/connectors';
import { BM_CHAINS, DEFAULT_CHAIN } from './chains';

// Browser wallet access: injected wallets (MetaMask, Rabby, Brave, the
// Coinbase extension) discovered by name, plus WalletConnect for phones
// and wallets without an extension. The Reown project id is public by
// nature (it is sent by every browser); the env var overrides it. The
// chain list is the deploy config; the default chain comes first so a
// fresh connect lands on it.

const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? '1a935b1ff42785564c05194a73840427';

const ordered = [BM_CHAINS[DEFAULT_CHAIN], ...Object.values(BM_CHAINS).filter((c) => c.key !== DEFAULT_CHAIN)];
const chains = ordered.map((c) => c.viemChain) as [typeof ordered[0]['viemChain'], ...Array<typeof ordered[0]['viemChain']>];

export const wagmiConfig = createConfig({
  chains,
  connectors: [
    injected(),
    ...(WC_PROJECT_ID
      ? [
          walletConnect({
            projectId: WC_PROJECT_ID,
            showQrModal: true,
            metadata: {
              name: 'ATNX markets',
              description: 'UP/DOWN markets on the Virality Index',
              url: 'https://markets.atnx.app',
              icons: ['https://markets.atnx.app/app_icon.png'],
            },
          }),
        ]
      : []),
  ],
  transports: Object.fromEntries(ordered.map((c) => [c.chainId, http(c.rpcUrl)])),
  // The connection is kept in a cookie so a server render already knows
  // the wallet; without it every refresh hydrated as "disconnected" and
  // showed a connect button during the reconnect.
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
