# Rolling VI rounds

The second iteration of the hackathon build, on Solana devnet. Each subject gets a series of back-to-back rounds on its Virality Index, and every round asks one question: will the VI, averaged over the round's last 30 minutes, end at or above where it stood when the round opened? While round N trades, round N+1 takes presale commits. The engine is Pennock's dynamic pari-mutuel market, so winners are paid out of the losing side's money and nobody, the platform included, is the counterparty to a trade. This replaces the [bounded markets](bounded-markets.md), which stay deployed. Program addresses are in the [README](../README.md); build and deploy steps for the program are in [programs/README.md](../programs/README.md).

## How it works

The program is `programs/vi_rounds`: `src/lib.rs` holds the accounts and instructions, `src/math.rs` the arithmetic. Money is mock USDG with 6 decimals, minted by the program's own `faucet` (up to 10,000 per call, testnet only).

### Why these parameters

Measured on the live index over 14 days and 84 markets: a 24-hour window ends at or above its open 51 % of the time, with a median move of 10 %. Over one hour the median move is 1.3 %, against 0.11 % of print-to-print jitter. The mean of the last 30 minutes of prints differs from the last print by 0.6 %.

So the target is the VI at the open, which makes a daily round close to an even question; rounds last 24 hours; the close is a 30-minute average, so a single print cannot decide a round; and a 1-hour series exists only as a fast demo, labelled as such wherever it appears.

### Series

One running series per subject and speed at a time. The ATNX market's uuid goes into a 32-byte reference that seeds the series account (bytes 0–15 the uuid, byte 16 set to 1 for the fast series, bytes 17–23 zero, bytes 24–31 a nonce: the start time in unix seconds, big-endian, so a market can run more than one series over time). The reference is stored in `bm.series.reference` and every keeper path reads it back; it is never recomputed from the market id. The wallet that starts a series is its finder and earns a share of its fees.

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

`claim` pays a settled position (or refunds a void one) and closes the position account, returning its rent. `claim_rollover` commits the payout to the winning side of the series' current presale round, without tokens leaving the vault. It takes the 1 % fee on the whole rolled amount, the refunded stake included, so rolling a payout costs 1 % of it where claiming costs nothing. It is refused on a paused series and has nothing to roll for a losing position. Round N+1 opens in the same keeper tick that settles round N, so by the time anyone can claim round N, the presale round is N+2: a rollover lands in N+2.

### Fees

1 % on every commit, buy and rollover, rounded up; the finder gets 20 % of it (rounded down) and the platform the rest. A presale commit of 50 USDG puts 49.50 in the pot and adds 0.10 to the finder's counter and 0.40 to the platform's. Both counters live on the series, and `withdraw_fees` pays the finder's counter to the finder and the platform's to the treasury. Claims and refunds carry no fee. A void round refunds net stakes only: the fee paid on the way in stays in the series' counters.

### Ante

The ante is an ordinary presale commit from the keeper wallet's own mock USDG. When the wallet runs low the keeper mints from the faucet, topping it up to 10,000. It is not paid out of fee income or a treasury balance: on devnet the keeper key is also the treasury, but the fee counters sit in the series vault and the ante never touches them. It pays the 1 % fee like any commit, so an ante of 10 USDG puts 9.90 in the pot. It wins or loses like anyone else's money. Once the round is settled or void the keeper claims its own position (step 6 of the [keeper](#keeper)), so a winning or refunded ante, and the position's rent, come back to the keeper wallet. The registry records which side got the ante and how much. If nobody commits at all, the keeper antes both sides.

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

One rule runs through the ticket and the cards: plain words for someone who has never traded, no tabs or jargon. The ticket shows one round, not a switch between rounds; the cards show a status pill and one line of verdict. "Presale" is the word this document and the code use for a round waiting to open; the ticket and the cards say "Opens soon", "Opens in 42m" or "Starts in 42m" instead.

### The ticket

The ticket is `atnx-web/components/rounds/RoundTicket.tsx`, in the market page's side column on desktop and behind the UP / DOWN dock on phones. It reads like a trade ticket: numbers, at most one sentence, a button.

It shows one round at a time: the live round whenever the series has one, otherwise the round waiting to open, which is round 1 before it opens and the short gap between a settle and the next open (usually the same keeper tick). While a round is live, the ticket offers nothing on the next one. A wallet that already holds money there, from a rollover or an earlier commit, sees one muted line under the pane: "You also have X USDG on UP in round N+1, which opens when this one settles." A rollover from the claim list still commits to the series' next round on chain (round N+2 by the time round N can be claimed; see [Claim and rollover](#claim-and-rollover)).

Every state ends in the same footer: a collapsed "How rounds work" disclosure (five bullets: target at the open, the round's length and the trading stop, the averaged close, what winners get, claim or roll; a devnet SOL note; a "Show me" link that opens the How ATNX works modal at its "UP or DOWN" step, which ends "Buy while the round runs. Before a market's first round opens, early commits on a side all pay the same price.") with "Devnet · mock USDG, no value." beside it. The states, in order:

1. No program configured: "Rounds are not live on Solana devnet yet."
2. No series on the market: the question ("Will {name}'s index be higher in 24 hours?"), a "Start rounds" button and "You earn a share of every fee in this series." It is blocked while the market is still being scored, has no score, or its VI is over 30 minutes old. Starting needs a connected Solana wallet, which becomes the finder; the keeper pays for the accounts. Then "Starting rounds on chain…" until the registry row appears.
3. A series, no wallet: the question, one status line for the round the ticket will show with a countdown chip, and a connect button. With a live round the line is "Round N · target T" with the live pane's chip ("Xh Ym left" until trading stops, then "Closes in …", then "Settling") and the button reads "Connect Solana wallet to trade"; with only a round waiting to open it is "Round N · opens soon" with an "Opens in …" or "Opening…" chip and the button reads "Connect Solana wallet to commit".
4. Wallet connected, no USDG: "You need test USDG to take a side." and one button that creates the USDG account and mints 1,000 test USDG.
5. The ticket proper: a "Round N · Live" or "Round N · Opens soon" label over one pane.
   - Live: "Target T · now V" with a time-left chip, UP and DOWN with their chance ("61% UP"), the spend with quick amounts and Max, "If UP wins you get X USDG" with the profit, and details (shares, average price, fee, finder's share, both pools and the chance of UP before and after). The button reads "Buy UP for 25 USDG".
   - Waiting to open: "Pots X UP · Y DOWN" with an "Opens in …" or "Opening…" chip, UP and DOWN with their price per share ("no commits yet" while both pots are empty), the amount, and one outcome line: "At today's pots your 25 USDG buys ~N shares at ~P¢" once the other side has money, else "Price set when the round opens; nobody pays more for being early." Details hold what the commit pays if its side wins, the fee, the finder's share and the keeper's ante. The button reads "Commit 25 USDG to UP".

   Under either pane, a wallet with a position in that round sees what it holds on each side and what that pays if the side wins ("You have X on UP", and beside it "pays Y if UP wins").
6. Averaging: after `trade_until` the live pane shows "Averaging the last 30 minutes…" with a "Closes in …" chip, and no buying.
7. Settling: "Settling…" after the close, until the keeper settles; the page re-reads itself every 8 seconds. Once the round settles, the round waiting to open takes its place until the keeper opens it.
8. Claims, one row for each settled or void round where the wallet still has a position ("Round N · UP won · 820 vs 812", with "· your side lost" for a losing position; "Round N · void · stake refunded"): "Claim X USDG", "Roll X into round N+2 (UP)" for a winner, or "Close position (returns rent)" for a loser.

There is no sell button: the program has no sell, and the exit before settlement is buying the other side. See [Open design questions](#open-design-questions).

### Cards and the list

Listing cards (`atnx-web/components/MarketCard.tsx`) show a market's current round with two components from `atnx-web/components/rounds/RoundBadge.tsx`, fed from the registry only (no chain reads in lists; `getRoundBadges` in `atnx-web/lib/bm/round-badges.ts`, one round per market, a round in flight before one waiting to open and the daily series before the fast one):

- `RoundPill`, the status pill on the image's top right, opposite the rank: "LIVE · 3h 33m" (time to the close) in cyan, "LIVE · closing" once trading has stopped, then "SETTLING", "OPENS IN 42m" and "OPENING" in grey. On a list row it sits at the right of the name from `sm` up and above the score on phones.
- `RoundVerdict`, the line under the name: "UP is winning" or "DOWN is winning" (the index now against the target; at or above is UP), "Closing now" in the averaging window, "Settling", or "Starts in 42m" for a round waiting to open.

The round number and the target are only in the hover text ("Round N: UP wins if the index ends at or above T. VI now V."). A market with no series shows neither, and once rounds are deployed the card draws no bounds rail for a bounded market.

The markets list (`/app`) has two tabs with counts over the whole list under the current search and category filter: Live, the markets whose round is in state `live`, and Up next, everything else (a round opening, settling or waiting to open, or no series yet). It opens on Live when anything is live. A small sort control beside the tabs orders by Virality (the default), Closing soonest (live rounds by their close, the rest after them by virality) or Newest. `?tab=live|next` and `?sort=closing|newest` keep the choice in the URL. Details in [web-app.md](web-app.md).

### Elsewhere

- Market header: `RoundChip`, "Round 12 · UP 61% · target 143 · 3h 12m" (time to the close, then "settling"), or "Round N · opens in 42m" (then "opening") before a round opens. A market with no series shows no chip.
- Chart: the live round's target as a line.
- Activity tab: settled rounds with their transactions (`RoundHistory`), or "No rounds yet on this market."
- `/app/portfolio`: the wallet's round positions across every series (one row per position, named by market: round, side, net stake, what it is now, one action; open rounds above settled ones), then the bounded-market positions on the EVM testnets.
- Settings: a Solana wallet block with the faucet.

Since 2026-10-06, once the rounds program is deployed (`isRoundsDeployed()`), a market page shows rounds only, even where a bounded market from the first iteration is still open on the subject: no bounded ticket, price chip, bound lines on the chart, trade log or Bounds and Opened-at-VI tiles, and the list builds no bounds badges. See [bounded-markets.md](bounded-markets.md) for what that leaves the open bounded markets.

## Keeper

The rounds step is step 4 of the existing keeper tick (`atnx-web/lib/bm/keeper-run.ts`, the Vercel cron every five minutes, which runs on production deployments only), runs only when `BM_ROUNDS_ENABLED=1`, and lives in `atnx-web/lib/bm/rounds.ts`. It stops starting new work 45 seconds into the tick; the next tick picks up where it left off. Within a tick:

1. Reconcile rounds a previous run left `opening` or `settling` (older than two minutes) from the chain.
2. Pending series (a start that crashed half way): create on chain, or adopt the series if it is already there.
3. Live rounds at least `BM_SETTLE_DELAY_SECS` (five minutes) past their close: average the window's prints and settle, or void when no print has arrived 30 minutes after the close.
4. Presale rounds whose time has come, on a series with no live round: check the VI is fresh (otherwise `open-deferred`), ante an empty side, open at the current VI, insert the next presale with its opening time set to the new round's close.
5. Paused series: pause on chain if needed and void the presale round (refunds). A live round still settles in step 3; once nothing is left to settle, the series reads `ended`.
6. The keeper's antes: settled or void rounds the keeper anted on, finished in the last 7 days (by the registry row's `updated_at`, at most 50, from `listRoundsToClaim` in `rounds-registry.ts`). Where the keeper's position account still exists, claim it (`sendClaim` in `sol.ts`): the payout or refund goes to the keeper's USDG account, created if missing, and the position's rent comes back; a losing ante pays nothing but its account still closes. A position already claimed is gone and is skipped. Each claim logs `claimed-ante` and counts in `claimed` on the tick's report. The first live run, on 2026-10-06, recovered 39.6 USDG and the rent from the two fast test rounds.

Settling N frees the live slot that opening N+1 needs, and opening N+1 frees the presale slot for N+2, which is why the order matters. Round N+1 can open only after N settles, so it opens 5 to 10 minutes after N closes: the settle delay plus the wait for the next tick.

The program checks `close_at` and `trade_until` against the chain clock, which ran about six seconds behind the wall clock on devnet during the lifecycle test. The settle delay keeps the settle well clear of that; a settle sent right at the close would fail with `TooEarly`.

The keeper signs with a plain keypair wallet (`keypairWallet` in `atnx-web/lib/bm/sol.ts`), not Anchor's `Wallet` class: that class exists only in Anchor's CommonJS build, and the bundle Turbopack builds has no such export.

Registry states (`atnx-web/supabase/bm/002_rounds.sql`):

| Table | States |
|---|---|
| `bm.series` | `pending` → `active` → `paused` → `ended`, or `failed` |
| `bm.rounds` | `presale` → `opening` → `live` → `settling` → `settled` or `void` (`failed` is allowed by the schema) |

The registry is not the ledger: commits, shares and payouts live in program accounts. `opening` and `settling` mark a transaction in flight, and every move is a compare-and-set update. Unique partial indexes allow one running series per market, chain and speed, one round in flight or live per series, and one presale per series. When the registry and the chain disagree, the chain wins: reconciliation moves the row to what the chain shows, or, when the transaction never landed, puts it back so the same tick retries.

Dry mode reads everything, logs `would-settle`, `would-open`, `would-ante`, `would-void`, `would-claim-ante` and the like with their numbers, and writes and sends nothing.

## Built / not built

As of 2026-10-06.

- [x] Program `vi_rounds` (Anchor 0.31.1): series, presale, open, buy, settle, void, claim, rollover, fees, faucet
- [x] Math unit tests on the host (`cargo test -p vi_rounds --lib`): `ln` against a reference table and a 2,000-point sweep, monotonicity, the worked example, presale clearing, fee split, a randomised payout-conservation run, the ratio cap
- [x] CI: the host tests, then an Anchor build of both programs (`.github/workflows/solana-build.yml`)
- [x] Deployed on Solana devnet, 2026-10-05: program, config and mint in the [README](../README.md); authority, keeper and treasury are the devnet payer `5a5yfYQBX3QYqWZ55agFTHQoxg5Lc4TvT8g3roMfqa2S`
- [x] End-to-end on devnet (`npm run rounds:sol -- e2e`, 2026-10-05): two 30-second rounds with presale, buys, settle, claim, rollover, ante, pause and void, and fee withdrawals; on-chain shares equal the TypeScript quote exactly; a buy costs about 34k compute units; the vault ended with zero dust
- [x] Registry schema `002_rounds.sql`, applied
- [x] Keeper step, with reconciliation and dry mode; `rounds:start` and `rounds:tick`
- [x] Keeper lifecycle on devnet against the live registry (2026-10-05), on a throwaway fast series with 15-minute rounds: start, ante on both sides, open round 1, settle on two prints (average 735.38 against a target of 735.28, UP), ante, open round 2 with round 3 in presale, pause through the registry (round 3's presale voided, series paused on chain), round 2 settled later and the series ended
- [x] Web: ticket, header chip, card pill and verdict, round history, portfolio, Solana wallet (Wallet Standard: Phantom, Solflare, Backpack), Settings faucet
- [x] Vercel env: production and the `feat/vi-rounds` preview (see Operations)
- [x] Preview deployment of `feat/vi-rounds`: every page rendered with the preview env. Three daily series started from Phantom on it: Kanye West, with three presale commits of 25 USDG (finder fees 0.15); Bitcoin, with one commit of 50 USDG (49.50 net; fees 0.10 to the finder, 0.40 to the platform); and Meta. The preview shares production's registry and program but does not run the keeper, so all three waited in presale for production's cron.
- [x] Merged to `main` (PR #12, 2026-10-05): production runs the rounds step with `BM_ROUNDS_ENABLED=1`
- [x] Rounds opened by production's keeper: four daily series started from the user's wallet (Kanye West, Bitcoin and Meta on 2026-10-05, SpaceX on 2026-10-06 at 16:39 UTC), round 1 live on each with round 2 waiting to open; 168 clean ticks overnight
- [x] Market pages and the list show rounds only once the program is deployed (PR #16, 2026-10-06; see [What the trader sees](#what-the-trader-sees))
- [x] The keeper claims its antes on settled and void rounds (PR #17, 2026-10-06; step 6 of the [keeper](#keeper)); the first live run recovered 39.6 USDG and the rent from the two fast test rounds
- [x] The ticket shows one round at a time, with no switch between rounds; the How ATNX works step reworded to match (PR #18, 2026-10-06)
- [x] Markets list: Live and Up next tabs with counts, and a sort control (Virality, Closing soonest, Newest), both in the URL (PR #19, 2026-10-06)
- [x] Market cards: a status pill on the image and a verdict line under the name (PR #20, 2026-10-06)
- [ ] Buy, claim and rollover from the ticket with a real wallet: still unexercised (the e2e covers them with script keypairs; Phantom has made presale commits only). Claim and rollover wait on the first production settlements, due 2026-10-06 between 21:25 and 21:50 UTC
- [ ] A round settled by production's keeper, checked against `vi_history` by hand (same settlements)
- [ ] Selling a position before settlement: the program has none and the exit is buying the other side; whether to add a hedge button is an [open design question](#open-design-questions)
- [ ] EVM port
- [ ] Oracle commitments (the `commitment` field on `settle` is the hook; zeros for now)
- [ ] Solana trade log on the market page
- [ ] Rollover crank (rollovers are by hand, one claim at a time)
- [ ] Extension captions for rounds
- [ ] Admin tab for rounds (`bm.series`, `bm.rounds` and `bm.keeper_log` are the place to look)

## Known limits

- Centralised oracle: the keeper reads the VI history that production ATNX writes and posts the average. The VI itself is computed by production ATNX.
- Trading stops when the settlement window starts. The next round keeps taking commits on chain, but the ticket does not offer them while a round is live; a rollover still lands there.
- A rollover lands in round N+2, not N+1, and pays the 1 % fee on the whole rolled amount, stake included.
- Rounds drift: round N+1 opens only once N is settled, at least `BM_SETTLE_DELAY_SECS` (five minutes) after N's close plus the wait for the next tick, so each round starts 5 to 10 minutes after the previous one closed.
- A correct bet never loses its net stake, but the 1 % fee is not refunded: with little money on the losing side, a winner can get back slightly less than it spent.
- A void round refunds net stakes only; the fee paid on each commit and buy stays with the series.
- The ante is the keeper wallet's faucet USDG, not savings from fees or a treasury. It pays the fee like any commit. On devnet the faucet makes it free; with real money it would need a budget. A round nobody commits to is the keeper against itself.
- The keeper claims its antes only on rounds finished in the last 7 days, at most 50 a tick; an older unclaimed ante stays in the vault until claimed with the keeper key.
- No selling before settlement; the exit is buying the other side, and trading stops 30 minutes before the close of a daily round. See [Open design questions](#open-design-questions).
- No cap on presale commits; a single live buy is capped at 1,000 times its side's money.
- A settlement window settles on whatever prints it holds; if the VI cron missed runs, that may be few. With none, the round is voided 30 minutes after the close.
- The program times trading and settlement by the chain clock, which ran about six seconds behind the wall clock on devnet; a countdown on the page is a few seconds early.
- Pausing a series through the registry ends it: on the next tick the series is paused on chain and its presale round voided, and from then on buys on the live round and rollovers are refused; the live round still settles and can be claimed, and the series cannot be resumed. A new series on the same market gets a new reference from its nonce.
- A market can run a daily and a fast series at the same time, but the market page shows only the daily one. A card shows one round, a live one before one waiting to open and then the daily series first, so a live fast round can stand in for a daily round that has not opened.
- A bounded market still open on a subject has no ticket on the market page once rounds are deployed: its holders see it in the portfolio's EVM section, which redeems a win once it resolves, but its "Trade" link opens the market page, so an open bounded position cannot be sold from the site.
- The faucet and series start are open to anyone (testnet only): one running series per market and speed, the keeper pays the rent.
- The ticket's fast toggle renders only under `next dev` (`NODE_ENV` is `production` on every Vercel deployment, previews included), and `startSeriesAction` ignores `fast=true` on a production build unless `BM_FAST_FROM_CLIENT=1` is set, so a wallet cannot fill production with hourly series. On production the intended route is `rounds:start -- <uuid> --fast` from the laptop.

## Operations

- Env vars (see [development.md](development.md) for the full table and `atnx-web/.env.local.example`): `BM_ROUNDS_ENABLED=1` turns the keeper step on; `BM_SOL_KEEPER_SECRET` is the keeper key; `NEXT_PUBLIC_BM_SOL_PROGRAM`, `NEXT_PUBLIC_BM_SOL_USDG`, `NEXT_PUBLIC_BM_SOL_RPC` point the app at the program; `BM_ROUND_SECS` (86400), `BM_SETTLE_WINDOW_SECS` (1800), `BM_FIRST_PRESALE_SECS` (3600), `BM_FAST_ROUND_SECS` (3600), `BM_FAST_SETTLE_WINDOW_SECS` (900), `BM_FAST_FIRST_PRESALE_SECS` (600), `BM_ANTE_USDG` (10) and `BM_SETTLE_DELAY_SECS` (300) override the defaults; `BM_AUTO_ROLL=0` stops the bounded keeper from rolling new bounded markets.
- Vercel: production has `NEXT_PUBLIC_BM_SOL_PROGRAM`, `NEXT_PUBLIC_BM_SOL_USDG`, `NEXT_PUBLIC_BM_SOL_RPC` (a Helius devnet endpoint), `BM_SOL_KEEPER_SECRET`, `BM_ROUNDS_ENABLED=1` and `BM_AUTO_ROLL=0`. The preview for branch `feat/vi-rounds` (merged 2026-10-05) had the same plus the Supabase variables, with `BM_ROUNDS_ENABLED=0`; crons do not run on previews anyway. Recipe for preview checks in [development.md](development.md#preview-deployments).
- Tests: `cargo test -p vi_rounds --lib` (CI runs it; the local compiler crashes) and `cd atnx-web && npm run test:bm` (`dpm.ts`, the settlement rule, the bounded-market tests).
- Deploy the program: push a change under `programs/`, wait for `solana-build` to go green, then run `programs/deploy.sh vi_rounds` (needs the `gh` CLI and the Solana CLI; `--dry` only fetches the artifact and copies the IDL). It deploys from the laptop and copies the IDL and types into `atnx-web/lib/bm/idl/`. After a fresh program id, run `cd atnx-web && npm run rounds:sol -- init` once (config and mint) and put the printed mint in `NEXT_PUBLIC_BM_SOL_USDG`.
- Check a deploy end to end: `npm run rounds:sol -- e2e` (pays from `~/.config/solana/devnet.json`, or `SOL_PAYER`; needs no `.env.local`).
- Start a series: `npm run rounds:start` lists the ten liveliest candidates; `npm run rounds:start -- "Name"` starts daily rounds, `-- <uuid> --fast` the fast demo, `--finder <pubkey>` names a finder other than the keeper, `--dry` validates only. On the site, the ticket's "Start rounds" starts daily rounds with the connected wallet as finder.
- Run a tick by hand: `BM_ROUNDS_ENABLED=1 npm run rounds:tick` is a dry run (without the variable the rounds step is skipped); add `-- --live` for a real one, handy for on-camera timing on a fast series. On production: `curl -H "Authorization: Bearer $CRON_SECRET" https://markets.atnx.app/api/bm/keeper?dry=1`.
- Stop a series: set its `bm.series.state` to `paused`. The next tick pauses it on chain and voids its presale round (refunds). Buys on the live round and rollovers stop with the pause, the round still settles and its positions can be claimed, and the series then reads `ended`. There is no resume; start a new series instead.
- Logs: every non-dry tick writes `bm.keeper_log` rows with `series_id` and `round_id` (`action`, `tx_hash`, `detail`, `error`); `bm.rounds` holds each round's target, settlement average, print count, winner, ante and transactions. Vercel → Logs, filtered on `/api/bm/keeper`, has the cron's output.

## Open design questions

- Selling a position before settlement. The bounded markets could sell back to their pool at any time; a round has no pool to sell into. For and against a "Lock in" hedge button, and the upstream alternative, in `docs/private/open-question-sell.md` (kept out of the public repository). Not decided; for the market design owner.
- Oracle commitments: what the 32-byte `commitment` on `settle` would point at. A design note, not scheduled, in `docs/private/oracle-commitments-maybe.md`.
