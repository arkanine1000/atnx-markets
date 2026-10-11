// Solana devnet operations for the Anchor program (programs/bounded_vi):
//
//   npm run bm:sol -- init            one-time: config PDA + mock USDG mint
//   npm run bm:sol -- e2e             presale -> open -> trade -> resolve -> redeem -> finalize -> LP claims
//
// Payer/authority is ~/.config/solana/devnet.json (SOL_PAYER overrides); it
// is the operator and the oracle. The e2e funds two fresh wallets, alice
// and bob, with SOL and faucet USDG. The IDL is programs/bounded_vi.idl.json,
// written by `programs/deploy.sh bounded_vi`.
//
// The presale numbers (fee, pots, pool arrangement, lazy shares, LP pot)
// are recomputed here in bigint; programs/bounded_vi/src/math.rs has the
// same run as its `e2e_vector` test. Trades are checked against
// lib/bm/fpmm.ts.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import * as anchor from '@coral-xyz/anchor';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { priceUp, quoteBuy, quoteSell, type Pools } from '../lib/bm/fpmm';

const ROOT = resolve(__dirname, '..', '..');
const IDL = JSON.parse(readFileSync(resolve(ROOT, 'programs/bounded_vi.idl.json'), 'utf8'));
const PAYER = process.env.SOL_PAYER ?? `${homedir()}/.config/solana/devnet.json`;
const USDG = 1_000_000n;
const BPS = 10_000n;
const LP_CUT_BPS = 2_000n; // programs/bounded_vi/src/math.rs
const UP = 0;
const DOWN = 1;
// Market.status (programs/bounded_vi/src/lib.rs)
const OPEN = 1;
const PRESALE = 3;
const FINALIZED = 5;

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
}

function assert(c: unknown, m: string) {
  if (!c) throw new Error(`assertion failed: ${m}`);
}

const big = (v: { toString(): string }) => BigInt(v.toString());
const bn = (v: bigint | number) => new anchor.BN(v.toString());
const fmt = (units: bigint) => (Number(units) / 1e6).toFixed(6);
const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);

async function expectReject(what: string, code: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    const s = String(err) + JSON.stringify((err as { logs?: string[] }).logs ?? []);
    assert(s.includes(code), `${what}: expected ${code}, got ${s.slice(0, 300)}`);
    console.log(`  rejected as expected: ${what} (${code})`);
    return;
  }
  throw new Error(`${what} should have failed with ${code}`);
}

async function main() {
  const cmd = process.argv[2] ?? 'e2e';
  const payer = loadKeypair(PAYER);
  const connection = new anchor.web3.Connection('https://api.devnet.solana.com', 'confirmed');
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: 'confirmed' });
  anchor.setProvider(provider);
  const program = new anchor.Program(IDL as anchor.Idl, provider);
  const programId = program.programId;
  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
  console.log(`program ${programId.toBase58()}, config ${config.toBase58()}, payer ${payer.publicKey.toBase58()}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = program.methods as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accounts = program.account as any;

  const initialize = async () => {
    const mint = Keypair.generate();
    const sig = await methods
      .initialize(100)
      .accountsPartial({ config, usdgMint: mint.publicKey, authority: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY })
      .signers([mint])
      .rpc();
    console.log(`initialized: mint ${mint.publicKey.toBase58()} tx ${sig}`);
    console.log(`NEXT_PUBLIC_BM_SOL_PROGRAM=${programId.toBase58()}`);
    console.log(`NEXT_PUBLIC_BM_SOL_USDG=${mint.publicKey.toBase58()}`);
  };

  if (cmd === 'init') {
    await initialize();
    return;
  }
  if (cmd !== 'e2e') throw new Error(`unknown command ${cmd} (init | e2e)`);

  // The Config layout did not change with the presale, so the deployed
  // config PDA keeps working; a fresh program id needs `init` first.
  if (!(await connection.getAccountInfo(config))) await initialize();
  const cfg = await accounts.config.fetch(config);
  const mint: PublicKey = cfg.usdgMint;
  const feeBps = BigInt(cfg.feeBps);
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner);
  const bal = async (owner: PublicKey) => BigInt((await connection.getTokenAccountBalance(ata(owner))).value.amount);

  // ------------------------------------------------ 1. fund alice and bob
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const fund = new Transaction();
  for (const k of [alice, bob]) {
    fund.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: k.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }));
    fund.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(k.publicKey), k.publicKey, mint));
  }
  await provider.sendAndConfirm(fund);
  for (const k of [alice, bob]) {
    await methods.faucet(bn(2_000n * USDG)).accountsPartial({ config, usdgMint: mint, to: ata(k.publicKey), tokenProgram: TOKEN_PROGRAM_ID }).rpc();
    assert((await bal(k.publicKey)) === 2_000n * USDG, 'faucet minted 2,000');
  }
  console.log(`  funded alice ${alice.publicKey.toBase58()} and bob ${bob.publicKey.toBase58()}: 0.05 SOL + 2,000 USDG each`);

  // ------------------------------------------------ 2. market in presale
  const reference = Buffer.alloc(32);
  reference.write(`e2e-${Date.now()}`);
  const [market] = PublicKey.findProgramAddressSync([Buffer.from('market'), reference], programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault'), market.toBuffer()], programId);
  const backerPda = (k: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('backer'), market.toBuffer(), k.toBuffer()], programId)[0];
  const posPda = (k: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('pos'), market.toBuffer(), k.toBuffer()], programId)[0];
  const vaultBal = async () => BigInt((await connection.getTokenAccountBalance(vault)).value.amount);
  const readMarket = async () => accounts.market.fetch(market);
  const readPos = async (k: PublicKey) => {
    const p = await accounts.position.fetchNullable(posPda(k));
    return { up: p ? big(p.up) : 0n, down: p ? big(p.down) : 0n };
  };

  await methods
    .createMarket([...reference])
    .accountsPartial({ config, market, vault, usdgMint: mint, operator: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY })
    .rpc();
  let m = await readMarket();
  assert(m.status === PRESALE, `status Presale (${m.status})`);
  console.log(`  market ${market.toBase58()} in presale (#${m.id})`);

  const holderAccts = (k: Keypair) => ({ config, market, vault, holderUsdg: ata(k.publicKey), holder: k.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId });
  const claimAccts = (k: Keypair) => ({ ...holderAccts(k), backer: backerPda(k.publicKey), position: posPda(k.publicKey) });
  const tradeAccts = (k: Keypair, withBacker: boolean) => ({
    config,
    market,
    vault,
    position: posPda(k.publicKey),
    backer: withBacker ? backerPda(k.publicKey) : null,
    traderUsdg: ata(k.publicKey),
    trader: k.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });
  const open = (operator: Keypair) => {
    const call = methods.openMarket(bn(10_000), bn(2_000), bn(50_000)).accountsPartial({ config, market, operator: operator.publicKey });
    return operator === payer ? call.rpc() : call.signers([operator]).rpc();
  };
  const commit = (k: Keypair, side: number, amount: bigint) =>
    methods.commit(side, bn(amount)).accountsPartial({ ...holderAccts(k), backer: backerPda(k.publicKey) }).signers([k]).rpc();

  await expectReject('open with an empty presale', 'EmptySide', () => open(payer));

  // ------------------------------------------------ 3. commits
  await commit(alice, UP, 600n * USDG);
  await commit(bob, DOWN, 400n * USDG);
  const feeA = ceilDiv(600n * USDG * feeBps, BPS);
  const feeB = ceilDiv(400n * USDG * feeBps, BPS);
  const U = 600n * USDG - feeA;
  const D = 400n * USDG - feeB;
  m = await readMarket();
  assert(big(m.presaleUp) === U && big(m.presaleDown) === D, `pots ${m.presaleUp}/${m.presaleDown}, expected ${U}/${D}`);
  assert(big(m.fees) === feeA + feeB, 'commit fees accrued');
  assert((await vaultBal()) === 1_000n * USDG, 'vault holds the gross commits');
  console.log(`  commits: alice UP 600, bob DOWN 400 -> pots ${fmt(U)} / ${fmt(D)}, fees ${fmt(feeA + feeB)}`);

  await expectReject('buy during the presale', 'NotOpen', () =>
    methods.buy(UP, bn(USDG), bn(0)).accountsPartial(tradeAccts(alice, false)).signers([alice]).rpc(),
  );
  await expectReject('open signed by alice', 'ConstraintHasOne', () => open(alice));

  // ------------------------------------------------ 4. open at VI 100.00, bounds 20/500
  await open(payer);
  m = await readMarket();
  const T = U + D;
  const L = (T * LP_CUT_BPS) / BPS;
  const expPoolUp = U >= D ? (L * D) / U : L;
  const expPoolDown = U >= D ? L : (L * U) / D;
  assert(m.status === OPEN, 'status Open');
  assert(big(m.collateral) === T, `collateral T = ${T}`);
  assert(big(m.poolUp) === expPoolUp && big(m.poolDown) === expPoolDown, `pools ${m.poolUp}/${m.poolDown}, expected ${expPoolUp}/${expPoolDown}`);
  assert(big(m.lpResidualUp) === L - expPoolUp && big(m.lpResidualDown) === L - expPoolDown, 'LP residual');
  let pools: Pools = { poolUp: big(m.poolUp), poolDown: big(m.poolDown) };
  assert(priceUp(pools) === 0.6, `opens at 60c (${priceUp(pools)})`);
  console.log(`  opened: T ${fmt(T)}, L ${fmt(L)}, pool ${fmt(pools.poolUp)} UP / ${fmt(pools.poolDown)} DOWN, residual UP ${fmt(L - expPoolUp)}, UP at ${priceUp(pools)}`);

  // Lazy shares: computed, not yet on any position.
  const sharesOf = (commitNet: bigint, pot: bigint) => (commitNet * T * (BPS - LP_CUT_BPS)) / (pot * BPS);
  const aliceLazy = sharesOf(U, U);
  const bobLazy = sharesOf(D, D);
  assert(aliceLazy === 792n * USDG && bobLazy === 792n * USDG, `lazy shares ${aliceLazy}/${bobLazy}`);
  const ab = await accounts.backer.fetch(backerPda(alice.publicKey));
  assert(!ab.converted && (await readPos(alice.publicKey)).up === 0n, 'alice not converted yet');
  // Per side: pool + residual + backers' shares == collateral (no dust at these numbers).
  assert(expPoolUp + (L - expPoolUp) + aliceLazy === T && expPoolDown + (L - expPoolDown) + bobLazy === T, 'invariant at open');

  // ------------------------------------------------ 5. alice claims, buys UP 100
  await methods.claimPresale().accountsPartial(claimAccts(alice)).signers([alice]).rpc();
  assert((await readPos(alice.publicKey)).up === aliceLazy, 'claim_presale credited 792 UP');
  await expectReject('second claim_presale', 'AlreadyConverted', () => methods.claimPresale().accountsPartial(claimAccts(alice)).signers([alice]).rpc());
  const qb = quoteBuy(pools, 'up', 100n * USDG, feeBps);
  await methods.buy(UP, bn(100n * USDG), bn(qb.shares)).accountsPartial(tradeAccts(alice, true)).signers([alice]).rpc();
  m = await readMarket();
  assert((await readPos(alice.publicKey)).up === aliceLazy + qb.shares, `buy shares == fpmm quote (${qb.shares})`);
  assert(big(m.poolUp) === qb.after.poolUp && big(m.poolDown) === qb.after.poolDown, 'pools after the buy');
  pools = qb.after;
  console.log(`  alice: claim_presale ${fmt(aliceLazy)} UP, buy UP 100 -> ${fmt(qb.shares)} UP (UP now ${priceUp(pools)})`);

  // ------------------------------------------------ 6. bob sells DOWN 100 (implicit conversion)
  const qs = quoteSell(pools, 'down', 100n * USDG, feeBps);
  const bobBefore = await bal(bob.publicKey);
  await methods.sell(DOWN, bn(100n * USDG), bn(qs.payout)).accountsPartial(tradeAccts(bob, true)).signers([bob]).rpc();
  assert((await bal(bob.publicKey)) - bobBefore === qs.payout, `sell paid the fpmm quote (${qs.payout})`);
  assert((await readPos(bob.publicKey)).down === bobLazy - 100n * USDG, 'bob converted on first touch, 692 DOWN left');
  assert((await accounts.backer.fetch(backerPda(bob.publicKey))).converted, 'bob converted');
  pools = qs.after;
  console.log(`  bob: sell DOWN 100 (converted on the way) -> ${fmt(qs.payout)} USDG`);

  // ------------------------------------------------ 7. resolve UP, redeem
  await expectReject('finalize before resolve', 'NotResolved', () => methods.finalize().accountsPartial({ market }).rpc());
  await methods.resolve(UP, bn(50_000)).accountsPartial({ config, market, oracle: payer.publicKey }).rpc();
  const win = (await readPos(alice.publicKey)).up;
  const a0 = await bal(alice.publicKey);
  await methods.redeem().accountsPartial(tradeAccts(alice, true)).signers([alice]).rpc();
  assert((await bal(alice.publicKey)) - a0 === win, 'redeem paid 1:1');
  console.log(`  resolved UP; alice redeemed ${fmt(win)} USDG`);

  // ------------------------------------------------ 8. finalize, LP claims
  m = await readMarket();
  const expPot = big(m.poolUp) + big(m.lpResidualUp) + big(m.fees);
  await methods.finalize().accountsPartial({ market }).rpc();
  m = await readMarket();
  assert(m.status === FINALIZED, 'status Finalized');
  assert(big(m.lpPot) === expPot, `lp_pot ${m.lpPot}, expected ${expPot}`);
  await expectReject('second finalize', 'AlreadyFinalized', () => methods.finalize().accountsPartial({ market }).rpc());

  const lp: [string, Keypair, bigint][] = [
    ['alice', alice, (expPot * U) / T],
    ['bob', bob, (expPot * D) / T],
  ];
  for (const [name, k, want] of lp) {
    const b0 = await bal(k.publicKey);
    await methods.claimLp().accountsPartial(claimAccts(k)).signers([k]).rpc();
    assert((await bal(k.publicKey)) - b0 === want, `${name} claim_lp paid ${want}`);
    assert((await connection.getAccountInfo(backerPda(k.publicKey))) === null, `${name}'s backer record closed`);
  }
  console.log(`  finalized: lp_pot ${fmt(expPot)}; alice LP ${fmt(lp[0][2])}, bob LP ${fmt(lp[1][2])}`);

  m = await readMarket();
  const left = await vaultBal();
  assert(left === big(m.collateral) + big(m.lpPot) - big(m.lpClaimed), 'vault == collateral + unclaimed LP');
  assert(left <= 4n, `vault empty within dust (${left} units left)`);
  console.log(`  vault left ${left} unit(s) of dust`);
  console.log(`e2e OK on Solana devnet: https://explorer.solana.com/address/${market.toBase58()}?cluster=devnet`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
