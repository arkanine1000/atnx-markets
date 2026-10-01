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

Status: builds on GitHub Actions (`.github/workflows/solana-build.yml`, artifact `bounded_vi`); the devnet program keypair is committed under `keys/` (testnet only, no value). The web app's chain switch
does not include Solana yet (`atnx-web/lib/bm/chains.ts` is EVM-only).
