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
pari-mutuel with a presale (mechanics in `docs/rounds.md`). Program
`5PsYwtsaexsFLGz6pwnVAtBTLzRqmGHxQJFnYWv42aQX`, deployed 2026-10-05; config PDA
`2w99R2Pr6GsiWXGev8kVcRp52w7kmmivvuB7JUmagnWe`; mock USDG mint
`9LurpUewiUvun2sUiDL4wjRKog91CqRFXXshaTGnXGHx`, whose authority is the config
PDA (`faucet`, up to 10,000 USDG per call); fee 100 bps, of which the finder
gets 2000 bps. Authority, keeper and treasury are the devnet payer
`5a5yfYQBX3QYqWZ55agFTHQoxg5Lc4TvT8g3roMfqa2S`. Its fixed-point math
(`src/math.rs`) has unit tests that run on the host toolchain, without any
Solana tools: `cargo test -p vi_rounds --lib`. The same math is mirrored in
`atnx-web/lib/bm/dpm.ts`. `atnx-web/scripts/rounds-sol.ts` sets up the config
and mint once (`npm run rounds:sol -- init`) and runs a full series against the
deployed program (`npm run rounds:sol -- e2e`, passed 2026-10-05).

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

The script takes the artifact from the latest green `solana-build` run on the
current branch (`BRANCH=main programs/deploy.sh vi_rounds` picks another), deploys it with the
committed program keypair `keys/<name>-keypair.json` (devnet only, no value) and
pays from `~/.config/solana/devnet.json` unless `PAYER` says otherwise. It prints
the explorer link at the end. It needs the `gh` CLI, logged in, and the Solana
CLI.

For `vi_rounds` the full flow is: push the program change, wait for
`solana-build` to go green, `programs/deploy.sh vi_rounds`, commit the copied
IDL and types, then `cd atnx-web && npm run rounds:sol -- e2e`. After a fresh
program id (a new keypair), run `npm run rounds:sol -- init` once before the
e2e and put the printed mint in `NEXT_PUBLIC_BM_SOL_USDG`.

## Where the IDLs land

Every deploy copies the IDL to `programs/<name>.idl.json`. For `vi_rounds` it also
writes `atnx-web/lib/bm/idl/vi_rounds.json` and `atnx-web/lib/bm/idl/vi_rounds.ts`,
for the web app and the keeper.

The web app reaches the rounds program through a Solana wallet (wallet-adapter)
beside its EVM chains; `atnx-web/lib/bm/chains.ts` carries the `solana:devnet`
entry. The keeper reaches it through `atnx-web/lib/bm/sol.ts` with
`BM_SOL_KEEPER_SECRET`. `bounded_vi` is not in the web app; only its scripts use it.
