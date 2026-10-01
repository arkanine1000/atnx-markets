# ATNX — Attention Exchange

**Live at [markets.atnx.app](https://markets.atnx.app).**

A Chrome extension + Next.js web app for capturing any content on the internet, identifying it with a vision model, and trading a simulated Virality Index (VI) on what you capture. Your friends' screenshots become markets; markets have a live VI; you can go long or short.

```
Ctrl+Shift+X → drag a selection → the model identifies it → you review: add to a market, or create one
                → VI updates every 5 min → trade long / short on it
```

Three ways in, one pipeline: the extension, the web form at `/app/submit` (screenshot, link, or text), and the Android share sheet. Every one of them stops at a review step before anything lands: the model's proposal, the existing markets it could belong to, and the choices the submitter may make, all bounded (no free text). A repeat of something captured before is answered outright.

---

## Hackathon build: bounded UP/DOWN markets on the VI

This repository is the hackathon fork of ATNX for the **Arbitrum / Robinhood Chain Open House (Singapore)** and the **Colosseum Crypto World's Fair**. It replaces the simulated long/short trading with on-chain two-outcome markets on the Virality Index, and keeps everything upstream of trading (capture, identification, the VI pipeline) as it was.

**Prior work disclosure.** The hackathon windows opened on 2026-09-14 (Arbitrum Open House) and 2026-09-15 (Colosseum). The tag [`pre-hackathon`](https://github.com/arkanine1000/atnx-markets/releases/tag/pre-hackathon) marks the last commit before that date; everything after it, the capture pipeline, the Virality Index and the bounded markets alike, was built inside the window: [compare `pre-hackathon...main`](https://github.com/arkanine1000/atnx-markets/compare/pre-hackathon...main). The repository is a public copy of the private upstream `gptdnd/atnx`. The bounded-markets work specifically starts at the tag [`bounded-markets-start`](https://github.com/arkanine1000/atnx-markets/releases/tag/bounded-markets-start): [compare `bounded-markets-start...main`](https://github.com/arkanine1000/atnx-markets/compare/bounded-markets-start...main).

| | |
|---|---|
| Live app | https://markets.atnx.app (production ATNX stays at https://atnx.app) |
| Contracts | `contracts/` (Foundry). Addresses in the table below. |
| Design doc | "ATNX devnet market design: bounded VI markets", 2026-09-30 (summarised in *How it works*) |
| Status | [docs/bounded-markets.md](docs/bounded-markets.md), *Built / not built* |

### Deployed contracts

| Chain | BoundedVIMarkets | MockUSDG | Explorer |
|---|---|---|---|
| Robinhood Testnet (46630) | [`0x0cDab5681546b887bA8772290869ef9001B2d47C`](https://explorer.testnet.chain.robinhood.com/address/0x0cDab5681546b887bA8772290869ef9001B2d47C) | [`0x3cCAADFa951Cd18fd68c2575402ee28E390Bf641`](https://explorer.testnet.chain.robinhood.com/address/0x3cCAADFa951Cd18fd68c2575402ee28E390Bf641) | deployed 2026-10-01, block 127197452 |
| Arbitrum Sepolia (421614) | _pending_ | _pending_ | https://sepolia.arbiscan.io |
| Solana devnet (Anchor program) | [`5xdrKVQPYpCJ4YkzDysTmV3XPQN5vVwHV1RhAQ2xvABG`](https://explorer.solana.com/address/5xdrKVQPYpCJ4YkzDysTmV3XPQN5vVwHV1RhAQ2xvABG?cluster=devnet) | mint [`9cgEJ7nexdmx2n4cDFaC93jvJnfreSNnTjkAXGZtxLEd`](https://explorer.solana.com/address/9cgEJ7nexdmx2n4cDFaC93jvJnfreSNnTjkAXGZtxLEd?cluster=devnet) | deployed 2026-10-01; config PDA `4HuF4aigjHakgQxtfL7S9BmnDxMx1B9sBa1WRavGCQf1` |

How the markets work, what is built and how to run the keeper: [docs/bounded-markets.md](docs/bounded-markets.md).

---

## Repo layout

```
atnx/
├── atnx-extension/     Chrome extension (Manifest V3, vanilla JS)
└── atnx-web/           Next.js 16 app (App Router + Server Actions)
```

---

## Docs

| | |
|---|---|
| [docs/bounded-markets.md](docs/bounded-markets.md) | The bounded market: bounds, shares, resolution, auto-roll, keeper operations, build status |
| [docs/architecture.md](docs/architecture.md) | The pipeline at a glance and the tech stack |
| [docs/web-app.md](docs/web-app.md) | Routes, API, key libraries, React context and components, the auth flow |
| [docs/virality-index.md](docs/virality-index.md) | The VI: sources, cadences, a new market's first day, records, Jev, tuning |
| [docs/database.md](docs/database.md) | Supabase tables, RPCs, storage |
| [docs/extension.md](docs/extension.md) | The Chrome extension's moving parts, permissions and config |
| [docs/development.md](docs/development.md) | Local setup, env vars, checking the pipeline, seeding, extension dev and release, deployment, known rough edges |
| [contracts/README.md](contracts/README.md), [programs/README.md](programs/README.md) | The EVM contracts and the Solana program |
| [atnx-web/README.md](atnx-web/README.md) | How a submission is decided, stage by stage |

`docs/private/` is gitignored and holds notes that are not for the public repo.
