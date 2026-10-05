# Rolling VI rounds

The second iteration of the hackathon build, on Solana devnet. Each subject gets a series of back-to-back rounds on its Virality Index, and every round asks one question: will the VI, averaged over the round's last 30 minutes, end at or above where it stood when the round opened? While round N trades, round N+1 takes presale commits. The engine is Pennock's dynamic pari-mutuel market, so winners are paid out of the losing side's money and nobody, the platform included, is the counterparty to a trade. This replaces the [bounded markets](bounded-markets.md), which stay deployed. Program addresses are in the [README](../README.md); build and deploy steps for the program are in [programs/README.md](../programs/README.md).

## How it works

The program is `programs/vi_rounds`: `src/lib.rs` holds the accounts and instructions, `src/math.rs` the arithmetic. Money is mock USDG with 6 decimals, minted by the program's own `faucet` (up to 10,000 per call, testnet only).

### Why these parameters

Measured on the live index over 14 days and 84 markets: a 24-hour window ends at or above its open 51 % of the time, with a median move of 10 %. Over one hour the median move is 1.3 %, against 0.11 % of print-to-print jitter. The mean of the last 30 minutes of prints differs from the last print by 0.6 %.

So the target is the VI at the open, which makes a daily round close to an even question; rounds last 24 hours; the close is a 30-minute average, so a single print cannot decide a round; and a 1-hour series exists only as a fast demo, labelled as such wherever it appears.

### Series

One running series per subject and speed at a time. The ATNX market's uuid goes into a 32-byte reference that seeds the series account (bytes 0–15 the uuid, byte 16 set for the fast series, bytes 24–31 a nonce, the start time in unix seconds, so a market can run more than one series over time). The registry stores the reference and every keeper path reads it back rather than recomputing it. The wallet that starts a series is its finder and earns a share of its fees.

A series copies the fee terms from the program config when it is created, so a later config change does not touch a running series. It holds the round length, the settlement window, the ante, a paused flag, the index of the live round and of the presale round, and two fee counters. Each series has one USDG vault, owned by the series account. Starting a series also creates round 1 in presale.

| | Daily | Fast demo |
|---|---|---|
| Round length | 24 h | 1 h |
| Settlement window | 30 min | 15 min |
| First presale | 1 h | 10 min |
| Ante | 10 USDG | 10 USDG |

### Presale

Anyone commits USDG to UP or DOWN in the series' presale round. Commits are locked until the round settles or is voided. There is no cap and no pricing during presale: the pots U and D simply add up (net of the fee). The ticket shows the price a commit would clear at if the round opened now.

### Open

When a presale round's time comes (the series start plus the first presale for round 1, the previous round's close after that) and no round is live, the keeper opens it at the subject's current VI, which becomes the target. Both pots must hold money; if one is empty, the keeper first commits the ante on that side. Opening sets

```
M1 = U,  M2 = D,  N1 = N2 = T = U + D
```

where M is the money and N the shares on each side (1 = UP, 2 = DOWN). A presale commit of u on UP holds u·T/U shares, so every UP commit clears at the same price, U/T, and every DOWN commit at D/T. The live price starts exactly there. Opening also fixes `close_at = now + round length` and `trade_until = close_at − settlement window`, and creates the next round in presale.

### Live

Live trading is buy-only, by spend. Buying UP with a net spend m (after the fee) gives

```
n = N2 · ln(1 + m / M1),   then M1 += m, N1 += n
```

and the same with the sides swapped for DOWN. This is price function I: the price of an UP share, M1/N2, equals the payoff per DOWN share. The implied chance of UP is

```
MPr(UP) = M1·N1 / (M1·N1 + M2·N2)
```

A single buy may not exceed 1,000 times the money already on its side. Every buy carries a minimum share count; the ticket sets it 1 % below the quote. There is no selling: the exit before settlement is buying the other side. Trading stops at `trade_until`, when the settlement window starts, so nobody can buy the side the averaging is already showing.

The only transcendental function on chain is `ln`, in 1e18 fixed point with every step rounded down, so rounding always favours the pool. `atnx-web/lib/bm/dpm.ts` mirrors `math.rs` in BigInt and agrees with it bit for bit.

### Settle

At least five minutes after the close, the keeper takes the plain mean of the subject's `vi_history` prints recorded in `[close − window, close]`, rounded to two decimals, and posts it. The program decides the winner: UP if the average is at or above the target, so a tie goes UP. A winning position is paid

```
payout = net stake + shares · M_lose / N_win
```

and a losing one nothing. This is variant I: winning stakes are refunded and only the losing side's money is redistributed, so a correct bet never gets back less than its net stake. If no print has landed in the window 30 minutes after the close, the keeper voids the round and everyone gets their net stakes back.

`settle` also takes a 32-byte `commitment`, reserved for a hash of the oracle's inputs; it is zeros for now.

### Claim and rollover

`claim` pays a settled position (or refunds a void one) and closes the position account, returning its rent. `claim_rollover` commits the payout, less the fee, to the winning side of the series' current presale round, without tokens leaving the vault. Round N+1 opens in the same keeper tick that settles round N, so by the time anyone can claim round N, the presale round is N+2: a rollover lands in N+2.

### Fees

1 % on every commit, buy and rollover, rounded up; the finder gets 20 % of it (rounded down) and the platform the rest. Both accrue in counters on the series, and `withdraw_fees` pays the finder's counter to the finder and the platform's to the treasury. Claims and refunds carry no fee, and a void round refunds net stakes, so its fees stay with the series.

### Ante

The ante is an ordinary keeper commit, made with the keeper wallet (on devnet the same key as the treasury), which tops itself up from the faucet when it runs low. It wins or loses like anyone else's money and pays the fee like any commit; the registry records which side got it and how much. If nobody commits at all, the keeper antes both sides.

### Worked example

Presale pots, net of the fee: U = 600, D = 400 USDG, so T = 1,000. The round opens with M1 = 600, M2 = 400, N1 = N2 = 1,000; an UP share costs 0.60.

| Step | Numbers |
|---|---|
| Live buy of UP, net 100 | n = 1,000 · ln(1 + 100/600) = 154.150679 shares |
| Pools after | M1 = 700, N1 = 1,154.150679, M2 = 400, N2 = 1,000; MPr(UP) = 0.669 |
| UP wins: a 60 USDG presale commit | 60 · 1,000/600 = 100 shares; paid 60 + 100 · 400/1,154.150679 = 94.657519 |
| UP wins: the live buyer | 100 + 154.150679 · 400/1,154.150679 = 153.424802 |
| UP wins: every UP holder together | 600 + 100 + 400 = 1,100 = M1 + M2, less rounding dust |

These numbers are a unit test in `math.rs` (`pennock_example`). The devnet end-to-end run replays the example with the fee on (commits of 600 and 400, a buy that nets exactly 100) and checks each on-chain result against the TypeScript quote.

Source: D. M. Pennock, "A Dynamic Pari-Mutuel Market for Hedging, Wagering, and Information Aggregation", EC 2004.

## What the trader sees

The ticket is `atnx-web/components/rounds/RoundTicket.tsx`, in the market page's side column on desktop and behind the UP / DOWN dock on phones. It walks through these states in order:

1. No program configured: "Rounds are not live on Solana devnet yet."
2. No series on the market: "Start rounds on {name}", with the question explained. It is blocked while the market is still being scored, has no score, or its VI has not updated in 30 minutes. Starting needs a connected Solana wallet, which becomes the finder; the keeper pays for the accounts. Then "Starting rounds on chain…" until the registry row appears.
3. A series, no wallet: the question ("Will {name}'s index be higher in 24 hours?"), a line on the live round's target and time left and the presale round, and a connect button.
4. Wallet connected, no USDG: one button creates the USDG account and mints 1,000 test USDG.
5. The ticket proper, with a switch between "Round N · Live" and "Round N+1 · Presale".
   - Presale: the two pots, the time until the round opens, UP and DOWN with their price per share, the amount, what the commit pays if its side wins at today's pots, and the ante disclosure.
   - Live: the target against the index now, time left to trade, UP and DOWN with their chance, the spend, "If UP wins you get X" with the profit, and details (shares, average price, fee, finder's share, pools and chance before and after).
6. Averaging: after `trade_until`, "Averaging the last 30 minutes…", no trading.
7. Settling: after the close, until the keeper settles; the page re-reads itself every 8 seconds.
8. Claims, for each settled or void round where the wallet still has a position: "Claim X USDG", "Roll X into round N+2 (UP)" for a winner, or "Close position (returns rent)" for a loser.

Elsewhere: the market header shows a round chip (round, chance of UP, target, time left), the chart draws the live round's target, the Activity tab lists settled rounds with their transactions, listing cards carry a round badge, `/app/portfolio` lists the wallet's round positions across every series, and Settings has a Solana wallet block with the faucet.

## Keeper

The rounds step is step 4 of the existing keeper tick (`atnx-web/lib/bm/keeper-run.ts`, the Vercel cron every five minutes), runs only when `BM_ROUNDS_ENABLED=1`, and lives in `atnx-web/lib/bm/rounds.ts`. It stops starting new work 45 seconds into the tick; the next tick picks up where it left off. Within a tick:

1. Reconcile rounds a previous run left `opening` or `settling` (older than two minutes) from the chain.
2. Pending series (a start that crashed half way): create on chain, or adopt the series if it is already there.
3. Live rounds at least five minutes past their close: average the window's prints and settle, or void when no print has arrived 30 minutes after the close.
4. Presale rounds whose time has come, on a series with no live round: check the VI is fresh (otherwise `open-deferred`), ante an empty side, open at the current VI, insert the next presale with its opening time set to the new round's close.
5. Paused series: pause on chain if needed and void the presale round (refunds), which ends the series.

Settling N frees the live slot that opening N+1 needs, and opening N+1 frees the presale slot for N+2, which is why the order matters.

Registry states (`atnx-web/supabase/bm/002_rounds.sql`):

| Table | States |
|---|---|
| `bm.series` | `pending` → `active` → `paused` → `ended`, or `failed` |
| `bm.rounds` | `presale` → `opening` → `live` → `settling` → `settled` or `void` (`failed` is allowed by the schema) |

The registry is not the ledger: commits, shares and payouts live in program accounts. `opening` and `settling` mark a transaction in flight, and every move is a compare-and-set update. Unique partial indexes allow one running series per market, chain and speed, one round in flight or live per series, and one presale per series. When the registry and the chain disagree, the chain wins: reconciliation moves the row to what the chain shows, or, when the transaction never landed, puts it back so the same tick retries.

Dry mode reads everything, logs `would-settle`, `would-open`, `would-ante`, `would-void` and the like with their numbers, and writes and sends nothing.

## Built / not built

- [x] Program `vi_rounds` (Anchor 0.31.1): series, presale, open, buy, settle, void, claim, rollover, fees, faucet
- [x] Math unit tests on the host (`cargo test -p vi_rounds --lib`): `ln` against a reference table and a 2,000-point sweep, monotonicity, the worked example, presale clearing, fee split, a randomised payout-conservation run, the ratio cap
- [x] CI: the host tests, then an Anchor build of both programs (`.github/workflows/solana-build.yml`)
- [x] Deployed on Solana devnet, 2026-10-05
- [x] End-to-end on devnet (`npm run rounds:sol -- e2e`, 2026-10-05): two 30-second rounds; on-chain shares equal the TypeScript quote exactly; a buy costs about 34k compute units; the vault ended with zero dust
- [x] Registry schema `002_rounds.sql`, applied
- [x] Keeper step, with reconciliation and dry mode; `rounds:start` and `rounds:tick`
- [x] Web: ticket, header chip, listing badge, round history, portfolio, Solana wallet (Wallet Standard: Phantom, Solflare, Backpack), Settings faucet
- [ ] Phantom smoke test on devnet (commit, buy, claim, rollover from a real wallet)
- [ ] A live series running on production
- [ ] EVM port
- [ ] Oracle commitments (the `commitment` field on `settle` is the hook)
- [ ] Solana trade log on the market page
- [ ] Rollover crank (rollovers are by hand, one claim at a time)
- [ ] Extension captions for rounds

## Known limits

- Centralised oracle: the keeper reads the VI history that production ATNX writes and posts the average. The VI itself is computed by production ATNX.
- Trading stops when the settlement window starts; the next round's presale stays open.
- A rollover lands in round N+2, not N+1.
- Rounds drift: round N+1 opens only once N is settled, at least five minutes after N's close plus the wait for the next tick, so each round starts a few minutes after the previous one closed.
- A correct bet never loses its net stake, but the 1 % fee is not refunded: with little money on the losing side, a winner can get back slightly less than it spent.
- The ante is treasury exposure on every round with an empty side. On devnet it is minted mock USDG; with real money it would need a budget. A round nobody commits to is the keeper against itself.
- No selling; the exit is buying the other side.
- No cap on presale commits; a single live buy is capped at 1,000 times its side's money.
- A settlement window settles on whatever prints it holds; if the VI cron missed runs, that may be few.
- Pausing a series through the registry ends it: the presale round is voided, buys on the live round stop, and the series cannot be resumed.
- The faucet and series start are open to anyone (testnet only): one running series per market and speed, the keeper pays the rent.
- The fast series can be started from the ticket only outside production; on production, use `rounds:start -- --fast`.

## Operations

- Env vars (see [development.md](development.md) for the full table): `BM_ROUNDS_ENABLED=1` turns the keeper step on; `BM_SOL_KEEPER_SECRET` is the keeper key; `NEXT_PUBLIC_BM_SOL_PROGRAM`, `NEXT_PUBLIC_BM_SOL_USDG`, `NEXT_PUBLIC_BM_SOL_RPC` point the app at the program; `BM_ROUND_SECS`, `BM_SETTLE_WINDOW_SECS`, `BM_FIRST_PRESALE_SECS`, their `BM_FAST_*` counterparts, `BM_ANTE_USDG` and `BM_SETTLE_DELAY_SECS` override the defaults; `BM_AUTO_ROLL=0` stops the bounded keeper from rolling new bounded markets.
- Tests: `cargo test -p vi_rounds --lib` (CI runs it; the local compiler crashes) and `cd atnx-web && npm run test:bm` (`dpm.ts`, the settlement rule, the bounded-market tests).
- Deploy the program: push a change under `programs/`, wait for `solana-build` to go green, then run `programs/deploy.sh vi_rounds` (needs the `gh` CLI and the Solana CLI; `--dry` only fetches the artifact and copies the IDL). It deploys from the laptop and copies the IDL and types into `atnx-web/lib/bm/idl/`. After a fresh program id, run `cd atnx-web && npm run rounds:sol -- init` once (config and mint) and put the printed mint in `NEXT_PUBLIC_BM_SOL_USDG`.
- Check a deploy end to end: `npm run rounds:sol -- e2e` (pays from `~/.config/solana/devnet.json`, or `SOL_PAYER`; needs no `.env.local`).
- Start a series: `npm run rounds:start` lists the ten liveliest candidates; `npm run rounds:start -- "Name"` starts daily rounds, `-- <uuid> --fast` the fast demo, `--finder <pubkey>` names a finder other than the keeper, `--dry` validates only. On the site, the ticket's "Start rounds" does the same with the connected wallet as finder.
- Run a tick by hand: `BM_ROUNDS_ENABLED=1 npm run rounds:tick` is a dry run (without the variable the rounds step is skipped); add `-- --live` for a real one, handy for on-camera timing on a fast series. On production: `curl -H "Authorization: Bearer $CRON_SECRET" https://markets.atnx.app/api/bm/keeper?dry=1`.
- Stop a series: set its `bm.series.state` to `paused`. The next tick pauses it on chain and voids its presale round (refunds). Buys on the live round stop with the pause, the round still settles, and the series then reads `ended`.
- Logs: every non-dry tick writes `bm.keeper_log` rows with `series_id` and `round_id` (`action`, `tx_hash`, `detail`, `error`); `bm.rounds` holds each round's target, settlement average, print count, winner, ante and transactions. Vercel → Logs, filtered on `/api/bm/keeper`, has the cron's output.
