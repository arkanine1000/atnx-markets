import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DpmError, feeSplit, lnFp, mprUp, payout, payoutIf, presalePrice, presaleShares, quoteBuy, S, sharesForSpend } from './dpm';

// floor(ln(x)·1e18), from Python Decimal at 60 digits (2026-10-05). The
// same table lives in programs/vi_rounds/src/math.rs.
const TABLE: Array<[bigint, bigint]> = [
  [S, 0n],
  [1_000_001_000_000_000_000n, 999_999_500_000n],
  [1_001_000_000_000_000_000n, 999_500_333_083_533n],
  [1_100_000_000_000_000_000n, 95_310_179_804_324_860n],
  [1_500_000_000_000_000_000n, 405_465_108_108_164_381n],
  [2n * S, 693_147_180_559_945_309n],
  [3n * S, 1_098_612_288_668_109_691n],
  [10n * S, 2_302_585_092_994_045_684n],
  [1001n * S, 6_908_754_779_315_220_585n],
];

test('ln matches the table from below', () => {
  for (const [x, exact] of TABLE) {
    const got = lnFp(x);
    assert.ok(got <= exact, `ln(${x}) = ${got} exceeds ${exact}`);
    assert.ok(exact - got <= 1_000n, `ln(${x}) = ${got}, exact ${exact}`);
  }
  assert.throws(() => lnFp(S - 1n), DpmError);
});

test('ln tracks Math.log over the domain', () => {
  const lo = Math.log(1.000001);
  const hi = Math.log(1001);
  for (let i = 0; i <= 2000; i++) {
    const xf = Math.exp(lo + ((hi - lo) * i) / 2000);
    const x = BigInt(Math.round(xf * 1e6)) * 1_000_000_000_000n;
    const got = Number(lnFp(x)) / 1e18;
    const want = Math.log(Number(x) / 1e18);
    assert.ok(Math.abs(got - want) < 1e-11, `x=${xf}: got ${got}, want ${want}`);
  }
});

test('Pennock example: 600/400 presale, buy UP with net 100', () => {
  const u = 600_000_000n;
  const d = 400_000_000n;
  const t = u + d;
  const n = sharesForSpend(t, u, 100_000_000n);
  assert.equal(n, 154_150_679n);
  const after = { mUp: u + 100_000_000n, mDown: d, nUp: t + n, nDown: t };
  assert.ok(Math.abs(mprUp(after) - 0.66885) < 1e-4);
  // A presale UP commit of 60 holds 100 shares and is paid 94.657519.
  assert.equal(presaleShares(60_000_000n, u, t), 100_000_000n);
  assert.equal(payout(60_000_000n, 100_000_000n, d, after.nUp), 94_657_519n);
  assert.equal(payout(100_000_000n, n, d, after.nUp), 153_424_802n);
  // payoutIf agrees with the hand computation.
  const pos = { presaleUp: 60_000_000n, presaleDown: 0n, stakeUp: 0n, stakeDown: 0n, sharesUp: 0n, sharesDown: 0n };
  assert.equal(payoutIf(pos, { ...after, presaleUp: u, presaleDown: d }, 'up'), 94_657_519n);
  assert.equal(payoutIf(pos, { ...after, presaleUp: u, presaleDown: d }, 'down'), 0n);
});

test('quoteBuy takes the fee first and mirrors the chain', () => {
  const pools = { mUp: 600_000_000n, mDown: 400_000_000n, nUp: 1_000_000_000n, nDown: 1_000_000_000n };
  // 101.010102 USDG gross is 100 net at 1%: ceil(101010102 * 100 / 10000) = 1010102.
  const q = quoteBuy(pools, 'up', 101_010_102n, 100n, 2000n);
  assert.equal(q.fee, 1_010_102n);
  assert.equal(q.net, 100_000_000n);
  assert.equal(q.shares, 154_150_679n);
  assert.equal(q.after.mUp, 700_000_000n);
  assert.equal(q.after.nUp, 1_154_150_679n);
  assert.equal(q.after.nDown, 1_000_000_000n);
  assert.equal(quoteBuy(pools, 'down', 0n, 100n, 2000n).shares, 0n);
  // The ratio cap.
  assert.throws(() => sharesForSpend(1_000n, 1_000n, 1_000_001n), (e: unknown) => e instanceof DpmError && e.code === 'ratio');
  assert.throws(() => sharesForSpend(1_000n, 0n, 10n), (e: unknown) => e instanceof DpmError && e.code === 'zero_pool');
  assert.equal(sharesForSpend(1_000_000_000n, 1_000_000_000n, 1_000_000_000n), 693_147_180n);
});

test('presale clears at the pot share', () => {
  assert.equal(presalePrice(600n, 400n, 'up'), 0.6);
  assert.equal(presalePrice(600n, 400n, 'down'), 0.4);
  assert.equal(presalePrice(0n, 0n, 'up'), null);
  assert.equal(presaleShares(6_000_000n, 600_000_000n, 1_000_000_000n), 10_000_000n);
  assert.equal(presaleShares(5n, 0n, 1_000n), 0n);
});

test('fee split sums and matches the Rust vectors', () => {
  assert.deepEqual(feeSplit(100_000_000n, 100n, 2000n), { fee: 1_000_000n, finder: 200_000n, platform: 800_000n, net: 99_000_000n });
  assert.deepEqual(feeSplit(1n, 100n, 2000n), { fee: 1n, finder: 0n, platform: 1n, net: 0n });
  for (const amount of [1n, 99n, 100n, 12_345_678n, 1_000_000_000n]) {
    const f = feeSplit(amount, 100n, 2000n);
    assert.equal(f.fee + f.net, amount);
    assert.equal(f.finder + f.platform, f.fee);
  }
});
