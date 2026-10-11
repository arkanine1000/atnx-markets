import type { NextConfig } from "next";

// wagmi's connector barrel pulls in Coinbase's CDP SDK, which imports the
// optional @x402 payment packages. Turbopack tolerates the dynamic imports;
// webpack (next dev --webpack, our fallback on a machine where Turbopack
// crashes) resolves them eagerly and fails. Aliasing them to false makes
// webpack treat them as empty modules. Turbopack ignores this hook.
// Package roots: a webpack alias on "@x402/evm" also covers "@x402/evm/..."
// subpaths, so every optional import the SDK makes resolves to nothing.
const optionalX402 = ["@x402/core", "@x402/evm", "@x402/svm", "@x402/extensions", "@x402/express", "@x402/fetch"];

const nextConfig: NextConfig = {
  // Next 16 refuses a Turbopack build that has a webpack hook and no
  // turbopack config; the empty object says the hook is webpack-only on purpose.
  turbopack: {},
  webpack: (config) => {
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      ...Object.fromEntries(optionalX402.map((m) => [m, false])),
    };
    return config;
  },
};

export default nextConfig;
