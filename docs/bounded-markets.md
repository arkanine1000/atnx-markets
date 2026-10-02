# Bounded UP/DOWN markets

The hackathon build: two-outcome markets on the Virality Index, on chain. Mechanics, status and how to operate the keeper. Contract addresses are in the [README](../README.md).

## How it works

Each market is a two-outcome market on one subject's VI, with an **upper and a lower bound** fixed from the VI at opening (`atnx-web/lib/bm/bounds.ts`):

`m = min(5, max(1.2, 1 + 4·(100/VI)^1.25))`, upper = VI·m, lower = VI/m (two significant figures; a lower bound under 5 is 0).

| Start VI | Lower | Upper |
|---|---|---|
| 10 | 0 | 50 |
| 100 | 20 | 500 |
| 300 | 150 | 600 |
| 1000 | 820 | 1200 |

- **UP** and **DOWN** shares. One UP plus one DOWN always costs 1 mock USDG; the split is set by a fixed-product market maker seeded by the treasury (1,000 mock USDG per market, 50/50 start).
- **Resolution** only when the VI touches a bound: three consecutive VI prints at or past a bound (the VI is written every five minutes, so about fifteen minutes). UP pays 1 USDG per share at the upper bound, DOWN at the lower. No end date otherwise: holders sell to take profit or cut losses.
- **Auto-roll**: when a market resolves, the keeper opens a new one from the new VI. Winners redeem by hand; nothing moves their funds.
- **Oracle**: the keeper wallet (a Vercel cron every five minutes) reads the VI history that production ATNX writes and posts resolutions. Centralised by design for the testnet build.
- **Fee**: 1% on buys and sells, accrued per market.
- **No leverage, no liquidation, no house counterparty.** Every market is fully funded by its own shares.

## Built / not built

_Updated as the build progresses._

- [x] Fork, tag, registry schema (`atnx-web/supabase/bm/`), bounds function with tests
- [x] Contracts with Foundry tests (`contracts/`, 19 tests incl. fuzz and invariants)
- [x] Contracts deployed on Robinhood Testnet
- [ ] Contracts deployed on Arbitrum Sepolia (needs testnet gas on the keeper wallet)
- [x] Keeper (resolution + auto-roll) and the open-market flow (`atnx-web/lib/bm/`, `/api/bm/keeper`)
- [x] Web: wallet, UP/DOWN ticket, bounds on the chart, pool price, activity from chain events
- [x] On-chain portfolio (`/app/portfolio`)
- [x] Extension fork (`atnx-extension/`, unpublished; rows deep-link to the market page since a side panel cannot reach an injected wallet)
- [x] End-to-end on Robinhood Testnet (`npm run bm:e2e -- eip155:46630`, 2026-10-01: mint, open, buy, sell, resolve, redeem, sweep all pass; three live markets opened: Halloween, Grand Theft Auto VI, MrBeast)
- [ ] End-to-end on Arbitrum Sepolia (needs testnet gas)
- [x] Solana program (Colosseum Solana track): `programs/bounded_vi`, built on GitHub Actions, deployed to devnet, scripted end-to-end passes with the same numbers as the EVM run (`npm run bm:sol -- e2e`). Not yet wired into the web app's chain switch (scripts only).

Known limits: Google/X sign-in on the subdomain redirects to the main site, so the hackathon build identifies people by wallet (opening a market needs a connected wallet, no account) and new subjects are captured on https://atnx.app, which the fork lists within minutes; centralised oracle; the VI itself is computed by production ATNX; the "deemed dead" rule for markets with a lower bound of 0 is not implemented; the treasury seed is not recovered; the 50/50 opening price is a product choice (the design doc illustrates a linear price).

## Operations

- Env vars: see `atnx-web/.env.local.example` plus `CRON_SECRET`, `BM_KEEPER_PRIVATE_KEY`, `NEXT_PUBLIC_BM_DEFAULT_CHAIN`, `BM_SEED_USDG`, `BM_TOUCH_PRINTS`, `BM_MAX_VI_AGE_MIN`, `BM_AUTO_ROLL`.
- Run the keeper by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://markets.atnx.app/api/bm/keeper?dry=1`.
- Tests: `cd contracts && forge test`; `cd atnx-web && npm run test:bm`.
- Deploy contracts: `contracts/deploy.sh robinhood_testnet` and `contracts/deploy.sh arbitrum_sepolia`; paste the printed `NEXT_PUBLIC_BM_*` lines into the Vercel env (and `atnx-web/.env.local`), then push to `main`: the GitHub integration deploys production.
- Keeper by hand, locally: `cd atnx-web && npm run bm:keeper:dry` (add `-- --live` for a real tick).
- Open a market from the keeper: `npm run bm:open` lists candidates, `npm run bm:open -- "Name"` opens one.
- Keeper rule of thumb: a market's cursor starts at the newest VI print when it opens; only prints made while it is open can resolve it.
- Vercel: project `atnx-markets`, root `atnx-web`, cron `/api/bm/keeper` every 5 minutes on the production deployment. Logs: Vercel → Logs, filter the path.
