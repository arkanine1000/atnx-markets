# Bounded UP/DOWN markets

> The first iteration of the hackathon build, superseded on 2026-10-05 by [rolling VI rounds](rounds.md).
> The contracts and the `bounded_vi` program are still deployed; live bounded markets still resolve, and `BM_AUTO_ROLL=0` stops the keeper from rolling new ones.

The hackathon build: two-outcome markets on the Virality Index, on chain. Mechanics, status and how to operate the keeper. Contract addresses are in the [README](../README.md).

Since 2026-10-06 (PR #16), once the rounds program is deployed, market pages and the markets list show rounds only. A market page never shows the bounded ticket, the price chip, the bound lines on the chart, the on-chain trade log or the Bounds and Opened-at-VI tiles, even where a bounded market is still open on the subject, and the list builds no bounds badges. The bounded markets still open on Robinhood Testnet (nine on that date) stay in the portfolio's EVM section, which redeems a win once the market resolves, and they resolve on their own when the index touches a bound; the keeper keeps checking for touches. They can no longer be sold from the site: the portfolio's "Trade" link opens the market page, which has only the rounds ticket.

## How it works

Each market is a two-outcome market on one subject's VI, with an **upper and a lower bound** fixed from the VI at opening (`atnx-web/lib/bm/bounds.ts`):

`m = min(5, max(1.2, 1 + 4·(100/VI)^1.25))`, upper = VI·m, lower = VI/m (two significant figures; a lower bound under 5 is 0).

| Start VI | Lower | Upper |
|---|---|---|
| 10 | 0 | 50 |
| 100 | 20 | 500 |
| 300 | 150 | 600 |
| 1000 | 820 | 1200 |

- **UP** and **DOWN** shares. One UP plus one DOWN always costs 1 mock USDG; the split is set by a fixed-product market maker. Where the pool's shares come from depends on the chain:
  - **EVM contracts** (`contracts/src/BoundedVIMarkets.sol`, Robinhood Testnet): the treasury seeds the pool (1,000 mock USDG per market, 50/50 start). The EVM contract still has the treasury seed and no presale.
  - **Solana program** (`programs/bounded_vi`): no house money. A presale funds the market, 20 % of it becomes the pool at the presale's clearing price, and the backers own that pool. See [Presale (Solana)](#presale-solana).
- **Resolution** only when the VI touches a bound: three consecutive VI prints at or past a bound (the VI is written every five minutes, so about fifteen minutes). UP pays 1 USDG per share at the upper bound, DOWN at the lower. No end date otherwise: holders sell to take profit or cut losses.
- **Auto-roll**: when a market resolves, the keeper opens a new one from the new VI. Winners redeem by hand; nothing moves their funds.
- **Oracle**: the keeper wallet (a Vercel cron every five minutes) reads the VI history that production ATNX writes and posts resolutions. Centralised by design for the testnet build.
- **Fee**: 1% on buys and sells, accrued per market. On Solana also 1% on presale commits, and every fee goes to the market's presale backers; the platform earns nothing from a Solana bounded market in this version. On the EVM contracts the fees go to the treasury's fee recipient.
- **No leverage, no liquidation, no house counterparty.** Every market is fully funded by its own shares.

## Presale (Solana)

The `bounded_vi` program (`programs/bounded_vi/src/lib.rs`, maths in `src/math.rs`) opens every market from a presale. The numbers below are the ones the program enforces.

**Lifecycle.** `create_market` (operator) → `commit` (anyone, any number of times, either side) → `open_market` (operator) → `buy` / `sell` → `resolve` (oracle) → `redeem` (winners) → `finalize` (anyone, once) → `claim_lp` (each backer). A presale the operator does not want to open ends with `void_market`, after which `claim_presale` refunds each backer.

**Commits.** A commit pays the config's fee (`fee_bps`, 100 = 1 % on devnet, capped at 500) into the market's fees; the net goes into the side's pot (U for UP, D for DOWN) and onto the backer's record (`Backer` PDA `["backer", market, holder]`). Nothing trades during the presale.

**Open.** The operator calls `open_market(start_e2, lower_e2, upper_e2)` with lower < start < upper. Both pots must hold money (`EmptySide` otherwise). The vault already holds the money, so T = U + D complete sets exist (collateral = T). Then:

- **Liquidity cut, 20 %.** L = floor(T · 20 %) sets go to the pool.
- **Opening price.** The pool opens at the presale's clearing price, p_up = U/T. The less likely side's pool stays at L and the other shrinks so that pool_down / (pool_up + pool_down) = U/T (floored). The shares the shrink removes are the **LP residual**, held by the market for the backers (`lp_residual_up` / `lp_residual_down`). On each side, pool + residual = L. If the presale is so lopsided that the smaller pool side rounds to zero, the market cannot open (`ThinPool`).
- **Backers' shares.** The other 80 % belong to the backers: a UP backer whose net commits are u holds floor(0.8 · u · T/U) UP shares; a DOWN backer floor(0.8 · d · T/D) DOWN shares. A backer on both sides holds both. Every UP commit clears at the same price, every DOWN commit likewise.
- **Lazy conversion.** Shares move onto the backer's `Position` the first time they touch the market after open: `claim_presale`, or a `buy` / `sell` / `redeem` that passes the backer's `Backer` account, or `claim_lp`.

**LP pot.** Each backer also owns the pool, in proportion to their commits: a backer with net commits u + d owns (u + d)/T of it. Once the market resolves, anyone may call `finalize` once. It moves the pool's winning shares, the winning LP residual and every fee the market collected (commits, buys, sells) into `lp_pot`. Each backer's `claim_lp` pays floor(lp_pot · (u + d)/T) and closes their `Backer` record (its rent goes back to them).

Backers carry the pool's risk. A fixed-product pool tends to end up holding more of the losing side, so the pool part of the LP pot can be worth less than the 20 % that went in; the fees offset some of that.

**Void.** `void_market` (operator, presale only) cancels the market. Each backer's `claim_presale` then refunds their net commits plus the fees they paid, and closes the record.

**Accounting invariant.** For each side, while the market is open: pool + LP residual + every holder's shares (converted or not) + dust = collateral. The dust comes from flooring the backers' shares, is fixed at open and is at most one unit per backer. The vault holds the pots plus fees during the presale, collateral + fees while open or resolved, and collateral + lp_pot − lp_claimed once finalized. When every winner has redeemed and every backer has claimed, at most about two units per backer stay in the vault.

**Worked example** (the devnet e2e, `npm run bm:sol -- e2e`, and the `e2e_vector` unit test). Alice commits 600 USDG on UP, Bob 400 on DOWN, at 1 %: pots U = 594, D = 396, fees 10, T = 990. L = 198: the pool opens with 132 UP and 198 DOWN, so UP costs 60c, and 66 UP shares are LP residual. Alice holds 792 UP, Bob 792 DOWN. Alice buys UP for 100 (143 UP); Bob sells 100 DOWN for 18.690434. UP wins: Alice redeems 935. `finalize` makes the LP pot 146.309566 (69.120773 pool UP + 66 residual + 11.188793 fees); Alice claims 60 % of it (87.785739), Bob 40 % (58.523826). Of the 1,100 USDG that came in, one unit (0.000001) stays in the vault.

**Status codes** (`Market.status`): 0 none, 1 open, 2 resolved, 3 presale, 4 void, 5 finalized. 1 and 2 keep their pre-presale values.

**Upgrade note.** The `Config` layout did not change, so the deployed config PDA and mock USDG mint keep working without a new `initialize`. The `Market` layout did change: markets created by the treasury-seeded version (e2e runs only, holding faucet USDG) cannot be read by the new program. `sweep` and the `create_market` seed and opening-probability arguments are gone.

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
- [x] Solana program (Colosseum Solana track): `programs/bounded_vi`, built on GitHub Actions, deployed to devnet, scripted end-to-end passes with the same numbers as the EVM run (`npm run bm:sol -- e2e`). Not yet wired into the web app's chain switch (scripts only). This was the treasury-seeded version (2026-10-01).
- [x] Solana presale (`programs/bounded_vi`: presale commits, open at the clearing price, 20 % liquidity cut, LP pot to the backers, no treasury seed, no `sweep`): program with host-run unit tests (`cargo test -p bounded_vi --lib`, 10 tests), CI green, redeployed to devnet 2026-10-11 under the same program id (markets from the seeded version can no longer be read; the config PDA and mint are unchanged), and `npm run bm:sol -- e2e` passes: pots 594/396 open the pool at 132 UP / 198 DOWN (60c) with a 66 UP residual, LP pot 146.309566 after an UP resolution, one unit of dust left in the vault.
- [ ] Presale on the EVM contracts: not planned; they keep the treasury seed.

Known limits: Google/X sign-in on the subdomain redirects to the main site, so the hackathon build signs people in with a wallet signature instead (opening a market needs only a connected wallet, no account), and new subjects are captured on https://atnx.app, which the fork lists within minutes; centralised oracle; the VI itself is computed by production ATNX; the "deemed dead" rule for markets with a lower bound of 0 is not implemented; on the EVM contracts the treasury seed is not recovered and the 50/50 opening price is a product choice (the design doc illustrates a linear price); the Solana program has neither, since it opens from a presale at the clearing price.

## Operations

- Env vars: `CRON_SECRET`, `BM_KEEPER_PRIVATE_KEY`, `NEXT_PUBLIC_BM_DEFAULT_CHAIN`, `BM_SEED_USDG`, `BM_TOUCH_PRINTS`, `BM_MAX_VI_AGE_MIN`, `BM_AUTO_ROLL`, all listed in `atnx-web/.env.local.example`; the contract addresses default to the Robinhood Testnet deploy and can be overridden with the `NEXT_PUBLIC_BM_*_<chainId>` lines `contracts/deploy.sh` prints.
- Run the keeper by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://markets.atnx.app/api/bm/keeper?dry=1`.
- Tests: `cd contracts && forge test`; `cd atnx-web && npm run test:bm`.
- Deploy contracts: `contracts/deploy.sh robinhood_testnet` and `contracts/deploy.sh arbitrum_sepolia`; paste the printed `NEXT_PUBLIC_BM_*` lines into the Vercel env (and `atnx-web/.env.local`), then push to `main`: the GitHub integration deploys production.
- Keeper by hand, locally: `cd atnx-web && npm run bm:keeper:dry` (add `-- --live` for a real tick).
- Open a market from the keeper: `npm run bm:open` lists candidates, `npm run bm:open -- "Name"` opens one.
- Keeper rule of thumb: a market's cursor starts at the newest VI print when it opens; only prints made while it is open can resolve it.
- Vercel: project `atnx-markets`, root `atnx-web`, cron `/api/bm/keeper` every 5 minutes on the production deployment; the same tick runs the rounds step when `BM_ROUNDS_ENABLED=1`. Production has `BM_AUTO_ROLL=0`. Logs: Vercel → Logs, filter the path.
