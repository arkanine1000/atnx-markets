// Solana devnet operations for the rolling-rounds program (programs/vi_rounds):
//
//   npm run rounds:sol -- init        one-time: config PDA + mock USDG mint (fee 1 %, finder 20 % of it)
//   npm run rounds:sol -- e2e         a full series on a 30 s round: presale, open, buys, negatives,
//                                     settle, rollover, ante, second round, pause + void, fee withdrawals
//
// Payer is ~/.config/solana/devnet.json (SOL_PAYER overrides); after `init`
// it is authority, keeper and treasury. RPC is NEXT_PUBLIC_BM_SOL_RPC or
// public devnet, the program NEXT_PUBLIC_BM_SOL_PROGRAM or the declared id.
// No .env.local needed. The IDL is lib/bm/idl/vi_rounds.json, written by
// `programs/deploy.sh vi_rounds`.
//
// The e2e goes through lib/bm/sol.ts (the keeper's senders) and the
// instruction builders in lib/bm/sol-shared.ts (the web ticket's), and
// checks every quote against lib/bm/dpm.ts.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
  type Signer,
  type TransactionInstruction,
} from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  PROGRAM_ID,
  USDG_MINT,
  anchorErrorName,
  computeBudgetIxs,
  configPda,
  ensureKeeperUsdg,
  fetchConfig,
  fetchPosition,
  instructionBuilders,
  keeperInstructionBuilders,
  keeperProgram,
  pdas,
  readRound,
  readSeries,
  refForSeries,
  refToHex,
  sendCommit,
  sendCreateSeries,
  sendOpenRound,
  sendSetSeries,
  sendSettle,
  sendVoid,
  solConnection,
  txLogs,
  type PositionAccount,
  type RoundAccount,
  type RoundSide,
  type SeriesAccount,
} from '../lib/bm/sol';
import { feeSplit, payoutIf, quoteBuy } from '../lib/bm/dpm';

const PAYER = process.env.SOL_PAYER ?? `${homedir()}/.config/solana/devnet.json`;
const USDG = 1_000_000n;
const FEE_BPS = 100;
const FINDER_BPS = 2000;

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
}

const fmt = (units: bigint) => (Number(units) / 1e6).toFixed(6);
const short = (s: string) => `${s.slice(0, 8)}…`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(step: string, detail = '') {
  console.log(`  ${step}${detail ? `: ${detail}` : ''}`);
}

async function main() {
  const cmd = process.argv[2] ?? 'e2e';
  const payer = loadKeypair(PAYER);
  // The payer is the keeper: lib/bm/sol.ts reads the keeper from this.
  process.env.BM_SOL_KEEPER_SECRET = JSON.stringify(Array.from(payer.secretKey));
  const conn = solConnection();
  const program = keeperProgram();
  const config = configPda();
  console.log(`program ${PROGRAM_ID.toBase58()}, config ${config.toBase58()}, payer ${payer.publicKey.toBase58()}, rpc ${conn.rpcEndpoint}`);

  // Every transaction: compute budget first; program errors surface by name.
  async function send(label: string, ixs: TransactionInstruction[], signers: Signer[]): Promise<string> {
    const tx = new Transaction().add(...computeBudgetIxs(), ...ixs);
    try {
      return await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed' });
    } catch (err) {
      let logs = txLogs(err);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = err as any;
      if (logs.length === 0 && typeof e?.getLogs === 'function') logs = await e.getLogs(conn).catch(() => []);
      const name = anchorErrorName({ message: e?.message, logs });
      const out = new Error(`${label}: ${name ?? e?.message ?? String(err)}`, { cause: err }) as Error & { anchorError: string | null; logs: string[] };
      out.anchorError = name;
      out.logs = logs;
      throw out;
    }
  }

  if (cmd === 'init') {
    const mint = Keypair.generate();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ix: TransactionInstruction = await (program.methods as any)
      .initialize(FEE_BPS, FINDER_BPS)
      .accountsStrict({
        config,
        usdgMint: mint.publicKey,
        authority: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();
    const sig = await send('initialize', [ix], [payer, mint]);
    console.log(`initialized: fee ${FEE_BPS} bps, finder ${FINDER_BPS} bps, mint ${mint.publicKey.toBase58()} tx ${sig}`);
    console.log(`NEXT_PUBLIC_BM_SOL_PROGRAM=${PROGRAM_ID.toBase58()}`);
    console.log(`NEXT_PUBLIC_BM_SOL_USDG=${mint.publicKey.toBase58()}`);
    return;
  }
  if (cmd !== 'e2e') throw new Error(`unknown command ${cmd} (init | e2e)`);

  // ------------------------------------------------------------ helpers
  const txs: { step: string; sig: string }[] = [];
  const record = (step: string, sig: string) => {
    txs.push({ step, sig });
    return sig;
  };

  const cfg = await fetchConfig(conn);
  assert.ok(cfg, 'config not initialised: run `npm run rounds:sol -- init` first');
  assert.ok(cfg.keeper.equals(payer.publicKey), `config keeper is ${cfg.keeper.toBase58()}, not the payer`);
  assert.ok(cfg.treasury.equals(payer.publicKey), `config treasury is ${cfg.treasury.toBase58()}, not the payer`);
  assert.equal(cfg.feeBps, FEE_BPS);
  assert.equal(cfg.finderBps, FINDER_BPS);
  if (USDG_MINT) assert.ok(USDG_MINT.equals(cfg.usdgMint), `NEXT_PUBLIC_BM_SOL_USDG ${USDG_MINT.toBase58()} is not the config mint ${cfg.usdgMint.toBase58()}`);
  const mint = cfg.usdgMint;
  const fee = BigInt(cfg.feeBps);
  const finderBps = BigInt(cfg.finderBps);
  const b = instructionBuilders(program);
  const kb = keeperInstructionBuilders(program);

  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner);
  const usdgOf = async (owner: PublicKey) => BigInt((await conn.getTokenAccountBalance(ata(owner))).value.amount);
  const chainNow = async () => {
    const t = await conn.getBlockTime(await conn.getSlot('confirmed')).catch(() => null);
    return t ?? Math.floor(Date.now() / 1000);
  };
  const sleepUntil = async (t: number, what: string) => {
    const now = await chainNow();
    if (now >= t) return;
    log(`waiting ${t - now} s`, what);
    while ((await chainNow()) < t) await sleep(1000);
  };
  const mustRound = async (k: PublicKey): Promise<RoundAccount> => {
    const r = await readRound(k);
    assert.ok(r, `round ${k.toBase58()} missing`);
    return r;
  };
  const mustSeries = async (k: PublicKey): Promise<SeriesAccount> => {
    const s = await readSeries(k);
    assert.ok(s, `series ${k.toBase58()} missing`);
    return s;
  };
  const mustPosition = async (k: PublicKey): Promise<PositionAccount> => {
    const p = await fetchPosition(conn, k);
    assert.ok(p, `position ${k.toBase58()} missing`);
    return p;
  };
  async function expectReject(label: string, code: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (err) {
      const got = anchorErrorName(err);
      assert.equal(got, code, `${label}: expected ${code}, got ${got ?? (err as Error).message}`);
      log(`${label} rejected`, code);
      return;
    }
    assert.fail(`${label}: expected ${code}, but it succeeded`);
  }

  // Expected fee counters, kept beside the chain's.
  const ledger = { finder: 0n, platform: 0n };
  const charge = (amount: bigint) => {
    const s = feeSplit(amount, fee, finderBps);
    ledger.finder += s.finder;
    ledger.platform += s.platform;
    return s;
  };

  // ------------------------------------------------------- 1. accounts
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const finder = Keypair.generate();
  const people = [alice, bob, finder];
  const fundIxs: TransactionInstruction[] = [];
  for (const k of people) {
    fundIxs.push(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: k.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }));
    fundIxs.push(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(k.publicKey), k.publicKey, mint));
    fundIxs.push(await b.faucet({ to: ata(k.publicKey), amount: 2_000n * USDG }));
  }
  record('fund alice/bob/finder', await send('fund', fundIxs, [payer]));
  for (const k of people) assert.equal(await usdgOf(k.publicKey), 2_000n * USDG);
  log('funded', `alice ${short(alice.publicKey.toBase58())}, bob ${short(bob.publicKey.toBase58())}, finder ${short(finder.publicKey.toBase58())}: 0.05 SOL + 2,000 USDG each`);
  await ensureKeeperUsdg(100n * USDG);
  const keeperStart = await usdgOf(payer.publicKey);

  // --------------------------------------------------- 2. create series
  const ref = refForSeries(randomUUID(), false);
  const P = pdas(ref);
  const created = await sendCreateSeries({ ref, roundSecs: 30, settleWindowSecs: 10, ante: 10n * USDG, finder: finder.publicKey });
  record('create_series', created.sig);
  let series = await mustSeries(P.series);
  assert.ok(series.finder.equals(finder.publicKey));
  assert.equal(refToHex(series.reference), refToHex(ref));
  assert.deepEqual(
    [series.roundSecs, series.settleWindowSecs, series.feeBps, series.finderBps, series.ante, series.liveRound, series.presaleRound, series.paused],
    [30, 10, FEE_BPS, FINDER_BPS, 10n * USDG, 0, 1, false],
  );
  const r1Key = P.round(1);
  const r2Key = P.round(2);
  const r3Key = P.round(3);
  assert.equal((await mustRound(r1Key)).state, 'presale');
  log('create_series', `${P.series.toBase58()} (#${series.index}), ref ${refToHex(ref)}`);

  // ------------------------------------------------ 3. round 1 presale
  const commitAs = async (who: Keypair, roundIndex: number, side: RoundSide, amount: bigint, step: string) => {
    charge(amount);
    return record(step, await send(step, [await b.commit({ ref, roundIndex, side, amount, holder: who.publicKey })], [who]));
  };
  await commitAs(alice, 1, 'up', 600n * USDG, 'alice commit UP 600 (r1)');
  await commitAs(bob, 1, 'down', 400n * USDG, 'bob commit DOWN 400 (r1)');
  let r1 = await mustRound(r1Key);
  assert.equal(r1.presaleUp, 594n * USDG, 'U = 600 less 1 %');
  assert.equal(r1.presaleDown, 396n * USDG, 'D = 400 less 1 %');
  series = await mustSeries(P.series);
  assert.equal(series.finderFees, 2n * USDG, 'finder 20 % of 10 USDG fees');
  assert.equal(series.platformFees, 8n * USDG, 'platform 80 % of 10 USDG fees');
  assert.deepEqual([series.finderFees, series.platformFees], [ledger.finder, ledger.platform]);
  log('presale r1', `U ${fmt(r1.presaleUp)}, D ${fmt(r1.presaleDown)}, fees finder ${fmt(series.finderFees)} / platform ${fmt(series.platformFees)}`);

  // ------------------------------------------------------- 4. open r1
  const opened1 = await sendOpenRound({ ref, roundIndex: 1, targetE2: 10_000n });
  record('open_round r1 (target 100.00)', opened1.sig);
  assert.ok(opened1.nextRound.equals(r2Key));
  r1 = await mustRound(r1Key);
  const T1 = r1.presaleUp + r1.presaleDown;
  assert.equal(r1.state, 'live');
  assert.deepEqual([r1.mUp, r1.mDown, r1.nUp, r1.nDown], [r1.presaleUp, r1.presaleDown, T1, T1]);
  assert.equal(r1.targetE2, 10_000n);
  assert.equal(r1.closeAt - r1.openedAt, 30);
  assert.equal(r1.tradeUntil, r1.closeAt - 10);
  assert.equal((await mustRound(r2Key)).state, 'presale');
  series = await mustSeries(P.series);
  assert.deepEqual([series.liveRound, series.presaleRound], [1, 2]);
  log('open r1', `M = (${fmt(r1.mUp)}, ${fmt(r1.mDown)}), N = ${fmt(T1)} each, close ${new Date(r1.closeAt * 1000).toISOString()}`);

  // ------------------------------------------------------ 5. live buys
  const buyAs = async (who: Keypair, side: RoundSide, amount: bigint, step: string) => {
    const before = await mustRound(r1Key);
    const q = quoteBuy(before, side, amount, fee, finderBps);
    const posKey = P.position(r1Key, who.publicKey);
    const posBefore = await fetchPosition(conn, posKey);
    const sig = await send(step, [await b.buy({ ref, roundIndex: 1, side, amount, minShares: q.shares, holder: who.publicKey })], [who]);
    record(step, sig);
    charge(amount);
    const after = await mustRound(r1Key);
    const pos = await mustPosition(posKey);
    const gained = side === 'up' ? pos.sharesUp - (posBefore?.sharesUp ?? 0n) : pos.sharesDown - (posBefore?.sharesDown ?? 0n);
    assert.equal(gained, q.shares, `${step}: chain shares ${gained} vs quote ${q.shares}`);
    assert.deepEqual([after.mUp, after.mDown, after.nUp, after.nDown], [q.after.mUp, q.after.mDown, q.after.nUp, q.after.nDown], `${step}: pools`);
    return { sig, q };
  };
  const aliceBuy = await buyAs(alice, 'up', 101_010_102n, 'alice buy UP 101.010102 (r1)');
  assert.equal(aliceBuy.q.net, 100n * USDG, 'gross 101.010102 nets exactly 100');
  let cu: number | null = null;
  for (let i = 0; i < 10 && cu === null; i++) {
    const t = await conn.getTransaction(aliceBuy.sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    cu = t?.meta?.computeUnitsConsumed ?? null;
    if (cu === null) await sleep(1000);
  }
  assert.ok(cu !== null, 'buy: no computeUnitsConsumed');
  assert.ok(cu < 100_000, `buy used ${cu} CU`);
  log('alice buy UP', `net ${fmt(aliceBuy.q.net)} -> ${fmt(aliceBuy.q.shares)} shares (== dpm quote), ${cu} CU`);
  const bobBuy = await buyAs(bob, 'down', 50n * USDG, 'bob buy DOWN 50 (r1)');
  log('bob buy DOWN', `net ${fmt(bobBuy.q.net)} -> ${fmt(bobBuy.q.shares)} shares (== dpm quote)`);
  // UP, so that round 2 is one-sided after alice's UP rollover and the
  // keeper has to ante the DOWN side.
  await commitAs(bob, 2, 'up', 20n * USDG, 'bob commit UP 20 (r2)');
  log('bob commit r2', 'UP 20');

  // ------------------------------------------------------ 6. negatives
  // Settle-early first: it needs chain time < close_at, and the window
  // between trade_until and close_at is only 10 s.
  r1 = await mustRound(r1Key);
  assert.ok((await chainNow()) < r1.closeAt - 2, 'too slow: round 1 already near close before the negatives');
  await expectReject('settle before close_at', 'TooEarly', () => sendSettle({ ref, roundIndex: 1, settleE2: 10_000n }));
  await expectReject('settle signed by bob', 'ConstraintHasOne', async () =>
    send('settle by bob', [await kb.settle({ ref, roundIndex: 1, settleE2: 10_000n, keeper: bob.publicKey })], [bob]),
  );
  await sleepUntil(r1.tradeUntil, 'trade_until (r1)');
  await expectReject('buy after trade_until', 'TradingClosed', async () =>
    send('late buy', [await b.buy({ ref, roundIndex: 1, side: 'up', amount: USDG, minShares: 0n, holder: alice.publicKey })], [alice]),
  );

  // ------------------------------------------------- 7. settle r1 (UP)
  await sleepUntil(r1.closeAt, 'close_at (r1)');
  record('settle r1 (100.00 >= 100.00)', await sendSettle({ ref, roundIndex: 1, settleE2: 10_000n }));
  r1 = await mustRound(r1Key);
  assert.equal(r1.state, 'settled');
  assert.equal(r1.winner, 'up', 'UP wins on settle == target');
  assert.equal(r1.settleE2, 10_000n);
  series = await mustSeries(P.series);
  assert.deepEqual([series.liveRound, series.presaleRound], [0, 2]);
  log('settle r1', 'UP wins');

  // ------------------------------- 8. alice rolls over, bob claims (0)
  const alicePos1Key = P.position(r1Key, alice.publicKey);
  const alicePos1 = await mustPosition(alicePos1Key);
  const aliceDue = payoutIf(alicePos1, r1, 'up');
  const aliceRoll = charge(aliceDue);
  const aliceUsdg0 = await usdgOf(alice.publicKey);
  record(
    'alice claim_rollover r1 -> r2',
    await send('claim_rollover', [await b.claimRollover({ ref, roundIndex: 1, nextRoundIndex: 2, holder: alice.publicKey })], [alice]),
  );
  const alicePos2 = await mustPosition(P.position(r2Key, alice.publicKey));
  assert.equal(alicePos2.presaleUp, aliceRoll.net, 'rolled = payoutIf less the fee');
  assert.equal(alicePos2.presaleDown, 0n);
  assert.equal(await conn.getAccountInfo(alicePos1Key), null, 'alice round-1 position closed');
  assert.equal(await usdgOf(alice.publicKey), aliceUsdg0, 'rollover moves no tokens');
  log('alice rollover', `payout ${fmt(aliceDue)}, fee ${fmt(aliceRoll.fee)}, ${fmt(aliceRoll.net)} UP in round 2`);

  const bobPos1Key = P.position(r1Key, bob.publicKey);
  const bobDue1 = payoutIf(await mustPosition(bobPos1Key), r1, 'up');
  assert.equal(bobDue1, 0n, 'bob lost round 1');
  const bobLamports0 = await conn.getBalance(bob.publicKey, 'confirmed');
  const bobUsdg0 = await usdgOf(bob.publicKey);
  record('bob claim r1 (0)', await send('claim', [await b.claim({ ref, roundIndex: 1, holder: bob.publicKey })], [bob]));
  assert.equal(await usdgOf(bob.publicKey), bobUsdg0, 'bob paid 0');
  assert.equal(await conn.getAccountInfo(bobPos1Key), null, 'bob round-1 position closed');
  const bobLamports1 = await conn.getBalance(bob.publicKey, 'confirmed');
  assert.ok(bobLamports1 > bobLamports0, 'position rent returned');
  log('bob claim r1', `0 USDG, rent back +${bobLamports1 - bobLamports0} lamports net of fees`);
  r1 = await mustRound(r1Key);
  const dust1 = r1.mUp + r1.mDown - r1.paidOut;

  // ---------------------------------------- 9. round 2: ante, open, DOWN
  let r2 = await mustRound(r2Key);
  assert.equal(r2.presaleUp, 19_800_000n + aliceRoll.net);
  const empty: RoundSide | null = r2.presaleUp === 0n ? 'up' : r2.presaleDown === 0n ? 'down' : null;
  if (empty) {
    series = await mustSeries(P.series);
    charge(series.ante);
    record(`keeper ante ${empty.toUpperCase()} (r2)`, await sendCommit({ ref, roundIndex: 2, side: empty, amount: series.ante }));
    log('ante', `${fmt(series.ante)} on ${empty.toUpperCase()}`);
  }
  r2 = await mustRound(r2Key);
  assert.ok(r2.presaleUp > 0n && r2.presaleDown > 0n);
  record('open_round r2', (await sendOpenRound({ ref, roundIndex: 2, targetE2: 10_000n })).sig);
  r2 = await mustRound(r2Key);
  assert.equal(r2.state, 'live');
  assert.equal((await mustRound(r3Key)).state, 'presale');
  series = await mustSeries(P.series);
  assert.deepEqual([series.liveRound, series.presaleRound], [2, 3]);
  log('open r2', `U ${fmt(r2.presaleUp)}, D ${fmt(r2.presaleDown)}`);
  await sleepUntil(r2.closeAt, 'close_at (r2)');
  record('settle r2 (90.00 < 100.00)', await sendSettle({ ref, roundIndex: 2, settleE2: 9_000n }));
  r2 = await mustRound(r2Key);
  assert.equal(r2.state, 'settled');
  assert.equal(r2.winner, 'down');
  log('settle r2', 'DOWN wins');

  const claimed: { who: string; amount: bigint }[] = [];
  for (const [name, k] of [
    ['bob', bob],
    ['alice', alice],
    ['keeper', payer],
  ] as const) {
    const posKey = P.position(r2Key, k.publicKey);
    const pos = await fetchPosition(conn, posKey);
    if (!pos) continue;
    const due = payoutIf(pos, r2, 'down');
    const before = await usdgOf(k.publicKey);
    record(`${name} claim r2`, await send('claim', [await b.claim({ ref, roundIndex: 2, holder: k.publicKey })], [k]));
    const delta = (await usdgOf(k.publicKey)) - before;
    assert.equal(delta, due, `${name}: paid ${delta}, payoutIf ${due}`);
    assert.equal(await conn.getAccountInfo(posKey), null, `${name} round-2 position closed`);
    claimed.push({ who: name, amount: delta });
    log(`${name} claim r2`, `${fmt(delta)} USDG (== payoutIf)`);
  }
  r2 = await mustRound(r2Key);
  const dust2 = r2.mUp + r2.mDown - r2.paidOut;

  // ------------------------------------------------ 10. pause and void
  record('set_series paused', await sendSetSeries({ ref, paused: true }));
  series = await mustSeries(P.series);
  assert.equal(series.paused, true);
  record('void_round r3 (presale)', await sendVoid({ ref, roundIndex: 3 }));
  const r3 = await mustRound(r3Key);
  assert.equal(r3.state, 'void');
  series = await mustSeries(P.series);
  assert.equal(series.presaleRound, 0);
  log('pause + void', 'round 3 void, series ended');

  // --------------------------------------------------- 11. fees out
  assert.deepEqual([series.finderFees, series.platformFees], [ledger.finder, ledger.platform], 'fee counters match the ledger');
  const finderFees = series.finderFees;
  const platformFees = series.platformFees;
  let before = await usdgOf(finder.publicKey);
  record('withdraw_fees finder', await send('withdraw_fees', [await b.withdrawFees({ ref, signer: finder.publicKey })], [finder]));
  assert.equal((await usdgOf(finder.publicKey)) - before, finderFees);
  before = await usdgOf(payer.publicKey);
  record('withdraw_fees treasury', await send('withdraw_fees', [await b.withdrawFees({ ref, signer: payer.publicKey })], [payer]));
  assert.equal((await usdgOf(payer.publicKey)) - before, platformFees);
  series = await mustSeries(P.series);
  assert.deepEqual([series.finderFees, series.platformFees], [0n, 0n]);
  log('withdraw_fees', `finder ${fmt(finderFees)}, treasury ${fmt(platformFees)}`);

  // ------------------------------------------------- 12. conservation
  const vault = BigInt((await conn.getTokenAccountBalance(P.vault)).value.amount);
  assert.equal(vault, dust1 + dust2, `vault ${vault} vs rounding dust ${dust1} + ${dust2}`);
  assert.ok(vault <= 10n, `vault dust ${vault} units is too large`);
  const keeperNet = (await usdgOf(payer.publicKey)) - keeperStart;

  // ------------------------------------------------------- summary
  const rows: { step: string; cu: number | string; sig: string }[] = [];
  for (const t of txs) {
    const tx = await conn.getTransaction(t.sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null);
    rows.push({ step: t.step, cu: tx?.meta?.computeUnitsConsumed ?? '?', sig: short(t.sig) });
  }
  console.log('');
  console.table(rows);
  console.table([
    { item: 'round 1 pots (U / D)', value: `${fmt(r1.presaleUp)} / ${fmt(r1.presaleDown)}` },
    { item: 'alice buy UP shares (chain == dpm)', value: fmt(aliceBuy.q.shares) },
    { item: 'bob buy DOWN shares (chain == dpm)', value: fmt(bobBuy.q.shares) },
    { item: 'buy compute units', value: String(cu) },
    { item: 'alice rollover into r2 (net)', value: fmt(aliceRoll.net) },
    ...claimed.map((c) => ({ item: `${c.who} claim r2`, value: fmt(c.amount) })),
    { item: 'fees: finder / treasury', value: `${fmt(finderFees)} / ${fmt(platformFees)}` },
    { item: 'keeper net USDG (ante result + platform fees)', value: fmt(keeperNet) },
    { item: 'vault left (rounding dust, units)', value: `${vault} (r1 ${dust1}, r2 ${dust2})` },
  ]);
  console.log(`e2e OK on Solana devnet: https://explorer.solana.com/address/${P.series.toBase58()}?cluster=devnet`);
}

main().catch((err) => {
  console.error(err);
  const logs = txLogs(err);
  if (logs.length) console.error(logs.join('\n'));
  process.exit(1);
});
