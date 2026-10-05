# Solana programs (Colosseum Solana track)

Two Anchor 0.31.1 programs live here, both on devnet.

`bounded_vi` is the Anchor port of `contracts/src/BoundedVIMarkets.sol`: the same
instrument, the same market-maker math, with a mock USDG mint whose authority is
the program's config PDA (`faucet` mints up to 10,000 USDG per call). Program
`5xdrKVQPYpCJ4YkzDysTmV3XPQN5vVwHV1RhAQ2xvABG`, deployed 2026-10-01; mock USDG
mint `9cgEJ7nexdmx2n4cDFaC93jvJnfreSNnTjkAXGZtxLEd`; authority, operator and
oracle are the local devnet wallet. `atnx-web/scripts/bm-sol.ts` runs the faucet,
a market, trades, resolution and redeem against it (`npm run bm:sol -- e2e`).

`vi_rounds` runs rolling rounds on the Virality Index: each round is a dynamic
pari-mutuel with a presale. Program `5PsYwtsaexsFLGz6pwnVAtBTLzRqmGHxQJFnYWv42aQX`.
Its fixed-point math (`src/math.rs`) has unit tests that run on the host
toolchain, without any Solana tools: `cargo test -p vi_rounds --lib`. The same
math is mirrored in `atnx-web/lib/bm/dpm.ts`.

## Build and deploy

The local compiler segfaults, so nothing is built on the laptop. GitHub Actions
does it (`.github/workflows/solana-build.yml`) on every push that touches
`programs/`, `Anchor.toml`, `Cargo.toml` or the workflow. The `test` job runs the
`vi_rounds` unit tests; the `build` job then runs `anchor build` with a pinned
Agave release and uploads one artifact per program, named after it, holding the
`.so`, the IDL and the TS types.

Deploying happens from the laptop with the Solana CLI:

```
programs/deploy.sh                 # bounded_vi
programs/deploy.sh vi_rounds
programs/deploy.sh vi_rounds --dry # download and copy the IDL, no deploy
PAYER=~/.config/solana/x.json programs/deploy.sh vi_rounds
```

The script takes the artifact from the latest green run, deploys it with the
committed program keypair `keys/<name>-keypair.json` (devnet only, no value) and
pays from `~/.config/solana/devnet.json` unless `PAYER` says otherwise. It prints
the explorer link at the end.

## Where the IDLs land

Every deploy copies the IDL to `programs/<name>.idl.json`. For `vi_rounds` it also
writes `atnx-web/lib/bm/idl/vi_rounds.json` and `atnx-web/lib/bm/idl/vi_rounds.ts`,
for the web app and the keeper.

The web app's chain switch does not include Solana yet (`atnx-web/lib/bm/chains.ts`
is EVM-only).
