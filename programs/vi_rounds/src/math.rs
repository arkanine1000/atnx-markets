//! Pure arithmetic for the rounds engine. No Anchor imports, so this file
//! compiles and its tests run on any host with `cargo test -p vi_rounds --lib`
//! (the SBF toolchain is only needed for the program itself).
//!
//! The engine is Pennock's dynamic pari-mutuel market (EC 2004), variant I
//! (winning wagers are refunded and only the losing side's money is
//! redistributed) with price function I (the price of an UP share equals
//! the payoff per DOWN share). With M the money and N the shares on each
//! side, buying UP with `m` costs `m = M1·(e^{n/N2} − 1)`, so the shares
//! for a given spend are `n = N2·ln(1 + m/M1)`. Only `ln` is needed on
//! chain because buys are by spend.
//!
//! Every step rounds down, so a result never exceeds the exact value and
//! rounding always favours the pool. `atnx-web/lib/bm/dpm.ts` mirrors this
//! file in BigInt and must agree with it bit for bit.

/// Fixed-point scale: 1e18.
pub const S: u128 = 1_000_000_000_000_000_000;
/// floor(ln 2 · 1e18).
pub const LN2: u128 = 693_147_180_559_945_309;
pub const BPS: u128 = 10_000;
/// A single buy may not exceed this many times the money already on its
/// side. Keeps `(M + m)·1e18` and `N·ln` inside u128 and stops one spend
/// from swallowing a thin pool.
pub const MAX_RATIO: u128 = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    Overflow,
    RatioTooLarge,
    ZeroPool,
}

/// floor(ln(x / 1e18) · 1e18) for x ≥ 1e18.
///
/// Reduce by the exact power of two (`y = x >> k`, so y/1e18 ∈ [1, 2)),
/// then ln(y) = 2·atanh(z) with z = (y − 1)/(y + 1) ≤ 1/3, summed until a
/// term drops under 1e3 (about fifteen terms). Each operation floors.
pub fn ln_fp(x: u128) -> Result<u128, MathError> {
    if x < S {
        return Err(MathError::Overflow);
    }
    let q = x / S;
    let k = 127 - q.leading_zeros();
    let y = x >> k;
    let z = (y - S) * S / (y + S);
    let z2 = z * z / S;
    let mut term = z;
    let mut sum = z;
    let mut i: u128 = 3;
    while term > 1_000 {
        term = term * z2 / S;
        sum += term / i;
        i += 2;
    }
    (k as u128)
        .checked_mul(LN2)
        .and_then(|a| a.checked_add(2 * sum))
        .ok_or(MathError::Overflow)
}

/// Shares bought on one side by spending `net` (after fee) when that side
/// holds `m_side` money and the other side holds `n_other` shares:
/// `n_other · ln(1 + net/m_side)`, floored.
pub fn shares_for_spend(n_other: u64, m_side: u64, net: u64) -> Result<u64, MathError> {
    if m_side == 0 || n_other == 0 {
        return Err(MathError::ZeroPool);
    }
    let m = m_side as u128;
    let net = net as u128;
    if net > MAX_RATIO * m {
        return Err(MathError::RatioTooLarge);
    }
    let x = (m + net).checked_mul(S).ok_or(MathError::Overflow)? / m;
    let ln = ln_fp(x)?;
    let n = (n_other as u128).checked_mul(ln).ok_or(MathError::Overflow)? / S;
    u64::try_from(n).map_err(|_| MathError::Overflow)
}

/// Splits `amount` into (fee, finder's part, platform's part, net).
/// The fee rounds up; the finder's part of it rounds down.
pub fn fee_split(amount: u64, fee_bps: u16, finder_bps: u16) -> (u64, u64, u64, u64) {
    let a = amount as u128;
    let fee = ceil_div(a * fee_bps as u128, BPS);
    let finder = fee * finder_bps as u128 / BPS;
    let platform = fee - finder;
    let net = a - fee;
    (fee as u64, finder as u64, platform as u64, net as u64)
}

/// Shares a presale commit of `commit` (net) on a side whose pot closed at
/// `pot_side`, in a round whose pots total `total`: `commit · total / pot`.
/// Every commit on a side clears at the same price, pot/total.
pub fn presale_shares(commit: u64, pot_side: u64, total: u64) -> u64 {
    if pot_side == 0 || commit == 0 {
        return 0;
    }
    (commit as u128 * total as u128 / pot_side as u128) as u64
}

/// Payout to a holder on the winning side: their net stake back plus
/// `shares · M_lose / N_win`.
pub fn payout(stake_win: u64, shares_win: u64, m_lose: u64, n_win: u64) -> Result<u64, MathError> {
    if shares_win == 0 {
        return Ok(stake_win);
    }
    if n_win == 0 {
        return Err(MathError::ZeroPool);
    }
    let share = shares_win as u128 * m_lose as u128 / n_win as u128;
    let total = stake_win as u128 + share;
    u64::try_from(total).map_err(|_| MathError::Overflow)
}

fn ceil_div(x: u128, y: u128) -> u128 {
    if x == 0 {
        0
    } else {
        (x - 1) / y + 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // floor(ln(x)·1e18), from Python Decimal at 60 digits (2026-10-05).
    const TABLE: &[(u128, u128)] = &[
        (S, 0),
        (1_000_001_000_000_000_000, 999_999_500_000),
        (1_001_000_000_000_000_000, 999_500_333_083_533),
        (1_100_000_000_000_000_000, 95_310_179_804_324_860),
        (1_500_000_000_000_000_000, 405_465_108_108_164_381),
        (2 * S, 693_147_180_559_945_309),
        (3 * S, 1_098_612_288_668_109_691),
        (10 * S, 2_302_585_092_994_045_684),
        (1001 * S, 6_908_754_779_315_220_585),
    ];

    #[test]
    fn ln_matches_the_table_from_below() {
        for &(x, exact) in TABLE {
            let got = ln_fp(x).unwrap();
            assert!(got <= exact, "ln({x}) = {got} exceeds {exact}");
            assert!(exact - got <= 1_000, "ln({x}) = {got}, exact {exact}");
        }
    }

    #[test]
    fn ln_tracks_f64_over_the_domain() {
        // 2,000 geometric points in [1.000001, 1001].
        let lo = 1.000001f64.ln();
        let hi = 1001f64.ln();
        for i in 0..=2000 {
            let l = lo + (hi - lo) * i as f64 / 2000.0;
            let xf = l.exp();
            let x = (xf * 1e18) as u128;
            let got = ln_fp(x).unwrap() as f64 / 1e18;
            let want = (x as f64 / 1e18).ln();
            assert!((got - want).abs() < 1e-11, "x={xf}: got {got}, want {want}");
        }
    }

    #[test]
    fn ln_is_monotonic() {
        let mut prev = 0u128;
        let mut x = S;
        while x < 2000 * S {
            let v = ln_fp(x).unwrap();
            assert!(v >= prev, "not monotonic at {x}");
            prev = v;
            x += x / 97 + 1;
        }
        assert_eq!(ln_fp(S - 1), Err(MathError::Overflow));
    }

    #[test]
    fn pennock_example() {
        // Presale U = 600, D = 400 USDG (6 decimals): T = 1000.
        let (u, d) = (600_000_000u64, 400_000_000u64);
        let t = u + d;
        // Live: buy UP with net 100.
        let n = shares_for_spend(t, u, 100_000_000).unwrap();
        assert_eq!(n, 154_150_679);
        let (m1, n1, m2) = (u + 100_000_000, t + n, d);
        // Implied probability of UP after the buy, about 0.669.
        let mpr = (m1 as f64 * n1 as f64) / (m1 as f64 * n1 as f64 + m2 as f64 * t as f64);
        assert!((mpr - 0.66885).abs() < 1e-4, "mpr {mpr}");
        // UP wins. A presale UP commit of 60 holds 100 shares.
        let ps = presale_shares(60_000_000, u, t);
        assert_eq!(ps, 100_000_000);
        assert_eq!(payout(60_000_000, ps, m2, n1).unwrap(), 94_657_519);
        // The live buyer.
        assert_eq!(payout(100_000_000, n, m2, n1).unwrap(), 153_424_802);
    }

    #[test]
    fn presale_clears_at_one_price_per_side() {
        let (u, d) = (600_000_000u64, 400_000_000u64);
        let t = u + d;
        // Price per UP share = U/T = 0.60: 60 USDG buys 100 shares, 6 buys 10.
        assert_eq!(presale_shares(60_000_000, u, t), 100_000_000);
        assert_eq!(presale_shares(6_000_000, u, t), 10_000_000);
        // DOWN at 0.40: 40 USDG buys 100 shares.
        assert_eq!(presale_shares(40_000_000, d, t), 100_000_000);
        // All UP commits together hold at most T shares.
        let parts = [1u64, 2, 3, 599_999_994];
        let sum: u64 = parts.iter().map(|&c| presale_shares(c, u, t)).sum();
        assert!(sum <= t && t - sum <= parts.len() as u64);
        assert_eq!(presale_shares(5, 0, t), 0);
    }

    #[test]
    fn fee_split_sums() {
        for amount in [1u64, 99, 100, 12_345_678, 1_000_000_000] {
            let (fee, finder, platform, net) = fee_split(amount, 100, 2000);
            assert_eq!(fee + net, amount);
            assert_eq!(finder + platform, fee);
            assert!(fee >= amount / 100);
        }
        assert_eq!(fee_split(100_000_000, 100, 2000), (1_000_000, 200_000, 800_000, 99_000_000));
        assert_eq!(fee_split(1, 100, 2000), (1, 0, 1, 0));
    }

    #[test]
    fn payouts_never_exceed_the_pots() {
        // A deterministic LCG drives 300 random commits and buys; the
        // winning side's payouts must sum to at most M1 + M2 and to at
        // least that minus one unit per holder (rounding dust).
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let mut rnd = |max: u64| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) % max + 1
        };
        for _round in 0..20 {
            let holders = 15usize;
            let mut presale = vec![(0u64, 0u64); holders];
            let (mut u, mut d) = (0u64, 0u64);
            for p in presale.iter_mut() {
                p.0 = rnd(50_000_000);
                p.1 = rnd(50_000_000);
                u += p.0;
                d += p.1;
            }
            let t = u + d;
            let (mut m1, mut m2, mut n1, mut n2) = (u, d, t, t);
            let mut live = vec![(0u64, 0u64, 0u64, 0u64); holders]; // stake_up, shares_up, stake_down, shares_down
            for _ in 0..300 {
                let h = rnd(holders as u64) as usize - 1;
                let spend = rnd(20_000_000);
                if rnd(2) == 1 {
                    let n = shares_for_spend(n2, m1, spend).unwrap();
                    m1 += spend;
                    n1 += n;
                    live[h].0 += spend;
                    live[h].1 += n;
                } else {
                    let n = shares_for_spend(n1, m2, spend).unwrap();
                    m2 += spend;
                    n2 += n;
                    live[h].2 += spend;
                    live[h].3 += n;
                }
            }
            for up_wins in [true, false] {
                let mut total = 0u128;
                for h in 0..holders {
                    let (stake, shares, m_lose, n_win) = if up_wins {
                        (presale[h].0 + live[h].0, presale_shares(presale[h].0, u, t) + live[h].1, m2, n1)
                    } else {
                        (presale[h].1 + live[h].2, presale_shares(presale[h].1, d, t) + live[h].3, m1, n2)
                    };
                    total += payout(stake, shares, m_lose, n_win).unwrap() as u128;
                }
                let pots = m1 as u128 + m2 as u128;
                assert!(total <= pots, "paid {total} of {pots}");
                assert!(pots - total <= 2 * holders as u128, "dust {} too large", pots - total);
            }
        }
    }

    #[test]
    fn ratio_cap_and_zero_pools_are_errors() {
        assert_eq!(shares_for_spend(1_000, 1_000, 1_000_001), Err(MathError::RatioTooLarge));
        assert_eq!(shares_for_spend(1_000, 0, 10), Err(MathError::ZeroPool));
        assert_eq!(shares_for_spend(0, 1_000, 10), Err(MathError::ZeroPool));
        assert_eq!(shares_for_spend(1_000_000_000, 1_000_000_000, 1_000_000_000).unwrap(), 693_147_180);
        assert_eq!(payout(5, 1, 7, 0), Err(MathError::ZeroPool));
        assert_eq!(payout(5, 0, 7, 0).unwrap(), 5);
    }
}
