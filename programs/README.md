# Solana program (Colosseum Solana track)

`bounded_vi` is the Anchor port of `contracts/src/BoundedVIMarkets.sol`: the same
instrument, the same market-maker math, with a mock USDG mint whose authority is
the program's config PDA (`faucet` mints up to 10,000 USDG per call).

Build and deploy (Anchor 0.31.1, Solana CLI 2.x):

```
anchor build
anchor keys sync          # writes the real program id into lib.rs and Anchor.toml
anchor build
anchor deploy --provider.cluster devnet
```

Deployed on devnet 2026-10-01: program `5xdrKVQPYpCJ4YkzDysTmV3XPQN5vVwHV1RhAQ2xvABG`, mock USDG mint `9cgEJ7nexdmx2n4cDFaC93jvJnfreSNnTjkAXGZtxLEd`, authority/operator/oracle = the local devnet wallet. `atnx-web/scripts/bm-sol.ts` runs the faucet, a market, trades, resolution and redeem against it (`npm run bm:sol -- e2e`). Builds on GitHub Actions (`.github/workflows/solana-build.yml`, artifact `bounded_vi`); the devnet program keypair is committed under `keys/` (testnet only, no value). The web app's chain switch
does not include Solana yet (`atnx-web/lib/bm/chains.ts` is EVM-only).
