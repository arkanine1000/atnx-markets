//! Pure arithmetic for bounded VI markets. No Anchor imports, so this file
//! compiles and its tests run on any host with `cargo test -p bounded_vi --lib`
//! (the SBF toolchain is only needed for the program itself).
//!
//! Two parts:
//!
//! - The fixed-product market maker (Gnosis FPMM, two outcomes), unchanged
//!   from the treasury-seeded version and mirrored in BigInt by
//!   `atnx-web/lib/bm/fpmm.ts` (and in Solidity by
//!   `contracts/src/BoundedVIMarkets.sol`).
//! - The presale: commits clear at one price per side, the pot share. With
//!   net pots U and D, T = U + D complete sets are minted at open; 20 % of
//!   them (L) become the pool, arranged so the pool opens at p_up = U/T,
//!   and the other 80 % go to the backers. Backers also own the pool pro
//!   rata to their commits: at resolution the pool's winning shares, the
//!   residual the skew took out of the pool and the fees form the LP pot.
//!   This part is not mirrored in TypeScript yet; the ticket does not need
//!   it, and `bm-sol.ts` recomputes the few numbers its e2e asserts.
//!
//! Every division floors (or rounds against the trader, as the FPMM does),
//! so a holder never gets more than the exact value and the dust stays in
//! the market.

pub const BPS: u128 = 10_000;
/// Share of the presale's complete sets that becomes pool inventory: 20 %.
pub const LP_CUT_BPS: u128 = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    Overflow,
    /// A presale pot is empty, so there is no clearing price.
    EmptySide,
    /// The presale is so lopsided that the smaller pool side rounds to zero.
    ThinPool,
}

pub fn ceil_div(x: u128, y: u128) -> u128 {
    if x == 0 {
        0
    } else {
        (x - 1) / y + 1
    }
}

pub fn ceil_sqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    if x * x == n {
        x
    } else {
        x + 1
    }
}

/// Splits a gross amount into (fee, net). The fee rounds up.
pub fn fee_of(amount: u64, fee_bps: u16) -> (u64, u64) {
    let fee = ceil_div(amount as u128 * fee_bps as u128, BPS) as u64;
    (fee, amount - fee)
}

/// Gnosis fixed-product buy, two outcomes. `a` is the pool of the side
/// bought, `b` the other. Returns (fee, net, new_this, new_other); the
/// shares out are `a + net - new_this`.
pub fn buy_math(a: u64, b: u64, invest: u128, fee_bps: u128) -> (u128, u128, u128, u128) {
    let fee = ceil_div(invest * fee_bps, BPS);
    let net = invest - fee;
    let (a, b) = (a as u128, b as u128);
    let new_other = b + net;
    let new_this = ceil_div(a * b, new_other);
    (fee, net, new_this, new_other)
}

/// Exact-shares sell: burn r sets with (a + s - r)(b - r) >= a b.
/// Returns (burned, fee, new_this, new_other); the payout is burned - fee.
pub fn sell_math(a: u64, b: u64, s: u128, fee_bps: u128) -> (u128, u128, u128, u128) {
    let (a, b) = (a as u128, b as u128);
    let sum = a + b + s;
    let disc = sum * sum - 4 * s * b;
    let root = ceil_sqrt(disc);
    let mut burned = (sum - root) / 2;
    while burned > 0 && (a + s - burned) * (b - burned) < a * b {
        burned -= 1;
    }
    let fee = ceil_div(burned * fee_bps, BPS);
    (burned, fee, a + s - burned, b - burned)
}

/// The pool and the LP residual at open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Opening {
    /// T = U + D: complete sets minted, equal to the collateral.
    pub total: u64,
    /// L = floor(T · 20 %): sets that go to the pool.
    pub liquidity: u64,
    pub pool_up: u64,
    pub pool_down: u64,
    /// Shares the skew took out of the smaller pool side; held by the
    /// market for the backers. pool_side + residual_side = L on each side.
    pub residual_up: u64,
    pub residual_down: u64,
}

/// Arranges L sets so the pool opens at the clearing price p_up = U/T,
/// i.e. pool_down / (pool_up + pool_down) = U/T. The pool of the less
/// likely side stays at L; the other shrinks to L·min/max (floored) and
/// the shares it gives up are the residual.
pub fn open_pools(u: u64, d: u64) -> Result<Opening, MathError> {
    if u == 0 || d == 0 {
        return Err(MathError::EmptySide);
    }
    let total = u.checked_add(d).ok_or(MathError::Overflow)?;
    let liquidity = (total as u128 * LP_CUT_BPS / BPS) as u64;
    let l = liquidity as u128;
    let (pool_up, pool_down) = if u >= d {
        ((l * d as u128 / u as u128) as u64, liquidity)
    } else {
        (liquidity, (l * u as u128 / d as u128) as u64)
    };
    if pool_up == 0 || pool_down == 0 {
        return Err(MathError::ThinPool);
    }
    Ok(Opening {
        total,
        liquidity,
        pool_up,
        pool_down,
        residual_up: liquidity - pool_up,
        residual_down: liquidity - pool_down,
    })
}

/// Shares a backer's net commit `commit` on a side whose pot closed at
/// `pot_side` converts into, in a presale of `total` = U + D:
/// floor(commit · total · 80 % / pot). The sum over a side's backers is at
/// most T − L, short by less than one unit per backer.
pub fn presale_shares(commit: u64, pot_side: u64, total: u64) -> Result<u64, MathError> {
    if commit == 0 {
        return Ok(0);
    }
    if pot_side == 0 {
        return Err(MathError::EmptySide);
    }
    let num = (commit as u128)
        .checked_mul(total as u128)
        .and_then(|x| x.checked_mul(BPS - LP_CUT_BPS))
        .ok_or(MathError::Overflow)?;
    let den = pot_side as u128 * BPS;
    u64::try_from(num / den).map_err(|_| MathError::Overflow)
}

/// A backer's part of the LP pot: floor(lp_pot · commit / total), where
/// `commit` is the backer's net commits on both sides.
pub fn lp_share(lp_pot: u64, commit: u64, total: u64) -> Result<u64, MathError> {
    if total == 0 {
        return Err(MathError::EmptySide);
    }
    let v = lp_pot as u128 * commit as u128 / total as u128;
    u64::try_from(v).map_err(|_| MathError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    const USDG: u64 = 1_000_000;

    #[test]
    fn buy_matches_the_foundry_vector() {
        // 1,000/1,000 pool, buy UP 100 at 1 %: the EVM and the old Solana
        // e2e both got 189.081892 shares.
        let (fee, net, new_this, new_other) = buy_math(1_000 * USDG, 1_000 * USDG, 100 * USDG as u128, 100);
        assert_eq!((fee, net), (1_000_000, 99_000_000));
        assert_eq!(1_000 * USDG as u128 + net - new_this, 189_081_892);
        assert!(new_this * new_other >= (1_000 * USDG as u128) * (1_000 * USDG as u128));
    }

    #[test]
    fn sell_keeps_the_product() {
        for (a, b, s) in [(1_000u64, 1_000u64, 10u128), (132_000_000, 198_000_000, 50_000_000), (69_120_773, 378_120_773, 1)] {
            let (burned, fee, new_this, new_other) = sell_math(a, b, s, 100);
            assert!(new_this * new_other >= a as u128 * b as u128);
            assert_eq!(new_this + burned, a as u128 + s);
            assert!(fee <= burned && burned < b as u128);
        }
    }

    #[test]
    fn twenty_percent_cut() {
        for (u, d) in [(600 * USDG, 400 * USDG), (1, 1), (5, 5), (123_456_789, 987_654_321), (7 * USDG, 7 * USDG)] {
            let o = open_pools(u, d).ok();
            let t = u + d;
            let l = t / 5;
            match o {
                Some(o) => {
                    assert_eq!(o.total, t);
                    assert_eq!(o.liquidity, l, "L = floor(T/5)");
                    assert_eq!(o.pool_up + o.residual_up, l);
                    assert_eq!(o.pool_down + o.residual_down, l);
                    // Backers hold 80 % of T on each side, less dust.
                    let up = presale_shares(u, u, t).unwrap();
                    assert_eq!(up, (t as u128 * 4 / 5) as u64);
                    assert!(up + o.liquidity <= t);
                }
                None => assert!(t < 5, "only a dust presale can fail to open"),
            }
        }
    }

    #[test]
    fn opening_price_is_the_clearing_price() {
        let pairs = [
            (600 * USDG, 400 * USDG),
            (400 * USDG, 600 * USDG),
            (500 * USDG, 500 * USDG),
            (999 * USDG, USDG),
            (USDG, 999 * USDG),
            (123_456_789, 987_654_321),
            (31_415_926, 27_182_818),
        ];
        for (u, d) in pairs {
            let o = open_pools(u, d).unwrap();
            // pool_up / pool_down = D / U, exact up to the one floored pool.
            let lhs = o.pool_up as u128 * u as u128;
            let rhs = o.pool_down as u128 * d as u128;
            assert!(lhs.abs_diff(rhs) < u.max(d) as u128, "{u}/{d}: {o:?}");
            // The less likely side's pool stays at L, the residual is on the other.
            if u >= d {
                assert_eq!((o.pool_down, o.residual_down), (o.liquidity, 0));
            } else {
                assert_eq!((o.pool_up, o.residual_up), (o.liquidity, 0));
            }
            let p = o.pool_down as f64 / (o.pool_up + o.pool_down) as f64;
            let want = u as f64 / (u + d) as f64;
            assert!((p - want).abs() < 1e-5, "{u}/{d}: opens at {p}, clears at {want}");
        }
    }

    #[test]
    fn empty_or_dust_presales_do_not_open() {
        assert_eq!(open_pools(0, 5 * USDG), Err(MathError::EmptySide));
        assert_eq!(open_pools(5 * USDG, 0), Err(MathError::EmptySide));
        // 1 unit against 1,000 USDG: L·D/U rounds to zero.
        assert_eq!(open_pools(1_000 * USDG, 1), Err(MathError::ThinPool));
        assert!(open_pools(1_000 * USDG, 10).is_ok());
    }

    #[test]
    fn presale_conversion_floors_and_sums_le_t() {
        let (u, d) = (600 * USDG, 400 * USDG);
        let t = u + d;
        // 60 of 600 on UP: 10 % of the UP side's 800 shares.
        assert_eq!(presale_shares(60 * USDG, u, t).unwrap(), 80 * USDG);
        assert_eq!(presale_shares(40 * USDG, d, t).unwrap(), 80 * USDG);
        assert_eq!(presale_shares(0, 0, t).unwrap(), 0);
        assert_eq!(presale_shares(1, 0, t), Err(MathError::EmptySide));
        // Awkward splits: the sum stays at or below T − L, short by fewer
        // units than there are backers.
        let parts = [1u64, 2, 3, 7, 11, 13, 599_999_963];
        let u: u64 = parts.iter().sum();
        let d = 333_333_333u64;
        let t = u + d;
        let o = open_pools(u, d).unwrap();
        let sum: u64 = parts.iter().map(|&c| presale_shares(c, u, t).unwrap()).sum();
        assert!(sum + o.liquidity <= t);
        assert!(t - o.liquidity - sum <= parts.len() as u64, "dust {}", t - o.liquidity - sum);
        let one = presale_shares(d, d, t).unwrap();
        assert!(one + o.liquidity <= t && t - o.liquidity - one <= 1);
    }

    #[test]
    fn lp_shares_never_exceed_the_pot() {
        let commits = [594_000_000u64, 396_000_000];
        let t: u64 = commits.iter().sum();
        let pot = 146_309_566u64;
        let paid: u64 = commits.iter().map(|&c| lp_share(pot, c, t).unwrap()).sum();
        assert!(paid <= pot && pot - paid < commits.len() as u64);
        assert_eq!(lp_share(pot, t, t).unwrap(), pot);
        assert_eq!(lp_share(pot, 1, 0), Err(MathError::EmptySide));
    }

    /// The devnet e2e in `atnx-web/scripts/bm-sol.ts`, step by step.
    #[test]
    fn e2e_vector() {
        let fee_bps = 100u16;
        let (fa, u) = fee_of(600 * USDG, fee_bps);
        let (fb, d) = fee_of(400 * USDG, fee_bps);
        assert_eq!((u, d), (594 * USDG, 396 * USDG));
        let o = open_pools(u, d).unwrap();
        assert_eq!((o.total, o.liquidity), (990 * USDG, 198 * USDG));
        assert_eq!((o.pool_up, o.pool_down, o.residual_up, o.residual_down), (132 * USDG, 198 * USDG, 66 * USDG, 0));
        // Opens at 60c.
        assert_eq!(o.pool_down * 10, (o.pool_up + o.pool_down) * 6);
        let alice = presale_shares(u, u, o.total).unwrap();
        let bob = presale_shares(d, d, o.total).unwrap();
        assert_eq!((alice, bob), (792 * USDG, 792 * USDG));
        let mut fees = fa + fb;
        let mut collateral = o.total;

        // Alice buys UP 100.
        let (fee, net, new_up, new_down) = buy_math(o.pool_up, o.pool_down, 100 * USDG as u128, fee_bps as u128);
        let bought = (o.pool_up as u128 + net - new_up) as u64;
        assert_eq!(bought, 143 * USDG);
        fees += fee as u64;
        collateral += net as u64;
        let (pool_up, pool_down) = (new_up as u64, new_down as u64);

        // Bob sells 100 DOWN.
        let (burned, fee, new_down, new_up) = sell_math(pool_down, pool_up, 100 * USDG as u128, fee_bps as u128);
        assert_eq!((burned, fee), (18_879_227, 188_793));
        fees += fee as u64;
        collateral -= burned as u64;
        let (pool_up, _pool_down) = (new_up as u64, new_down as u64);
        assert_eq!(pool_up, 69_120_773);

        // UP wins. Alice redeems; finalize; both claim the LP pot.
        collateral -= alice + bought;
        let inventory = pool_up + o.residual_up;
        collateral -= inventory;
        let lp_pot = inventory + fees;
        assert_eq!(lp_pot, 146_309_566);
        let la = lp_share(lp_pot, u, o.total).unwrap();
        let lb = lp_share(lp_pot, d, o.total).unwrap();
        assert_eq!((la, lb), (87_785_739, 58_523_826));
        assert_eq!(collateral, 0);
        assert_eq!(lp_pot - la - lb, 1, "one unit of dust stays in the vault");
        // 1,100 USDG in; 1,099.999999 out.
        let out = (burned - fee) as u64 + alice + bought + la + lb;
        assert_eq!(out, 1_100 * USDG - 1);
    }

    // ------------------------------------------------ lifecycle simulation

    #[derive(Clone)]
    struct Sim {
        fee_bps: u16,
        pu: u64,
        pd: u64,
        t: u64,
        pool_up: u64,
        pool_down: u64,
        res_up: u64,
        res_down: u64,
        collateral: u64,
        fees: u64,
        /// The vault's token balance, tracked from transfers alone.
        vault: u64,
        commits: Vec<(u64, u64)>,
        converted: Vec<bool>,
        /// Positions: backers first, then traders.
        pos: Vec<(u64, u64)>,
    }

    impl Sim {
        fn pending(&self, i: usize) -> (u64, u64) {
            if i >= self.commits.len() || self.converted[i] {
                return (0, 0);
            }
            let (u, d) = self.commits[i];
            (presale_shares(u, self.pu, self.t).unwrap(), presale_shares(d, self.pd, self.t).unwrap())
        }

        fn convert(&mut self, i: usize) {
            let (u, d) = self.pending(i);
            if i < self.commits.len() {
                self.converted[i] = true;
            }
            self.pos[i].0 += u;
            self.pos[i].1 += d;
        }

        fn check(&self) {
            let n = self.commits.len() as u128;
            for up in [true, false] {
                let mut sum = if up { self.pool_up as u128 + self.res_up as u128 } else { self.pool_down as u128 + self.res_down as u128 };
                for i in 0..self.pos.len() {
                    let (pu, pd) = self.pending(i);
                    sum += if up { (self.pos[i].0 + pu) as u128 } else { (self.pos[i].1 + pd) as u128 };
                }
                let c = self.collateral as u128;
                assert!(sum <= c, "side {up}: {sum} shares over {c} collateral");
                assert!(c - sum <= n, "side {up}: dust {} over {n} backers", c - sum);
            }
            assert_eq!(self.vault as u128, self.collateral as u128 + self.fees as u128);
        }

        fn buy(&mut self, i: usize, up: bool, invest: u64) {
            self.convert(i);
            let (a, b) = if up { (self.pool_up, self.pool_down) } else { (self.pool_down, self.pool_up) };
            let (fee, net, new_this, new_other) = buy_math(a, b, invest as u128, self.fee_bps as u128);
            let shares = (a as u128 + net - new_this) as u64;
            if shares == 0 {
                return; // the program rejects it
            }
            self.vault += invest;
            self.collateral += net as u64;
            self.fees += fee as u64;
            if up {
                self.pool_up = new_this as u64;
                self.pool_down = new_other as u64;
                self.pos[i].0 += shares;
            } else {
                self.pool_down = new_this as u64;
                self.pool_up = new_other as u64;
                self.pos[i].1 += shares;
            }
        }

        fn sell(&mut self, i: usize, up: bool, pct: u64) {
            self.convert(i);
            let held = if up { self.pos[i].0 } else { self.pos[i].1 };
            let s = held * pct / 100;
            if s == 0 {
                return;
            }
            let (a, b) = if up { (self.pool_up, self.pool_down) } else { (self.pool_down, self.pool_up) };
            let (burned, fee, new_this, new_other) = sell_math(a, b, s as u128, self.fee_bps as u128);
            if burned == 0 {
                return; // the program rejects it
            }
            let payout = (burned - fee) as u64;
            self.vault = self.vault.checked_sub(payout).expect("vault overdrawn by a sell");
            self.collateral -= burned as u64;
            self.fees += fee as u64;
            if up {
                self.pos[i].0 -= s;
                self.pool_up = new_this as u64;
                self.pool_down = new_other as u64;
            } else {
                self.pos[i].1 -= s;
                self.pool_down = new_this as u64;
                self.pool_up = new_other as u64;
            }
        }

        fn redeem(&mut self, i: usize, up: bool) -> u64 {
            let w = if up { std::mem::take(&mut self.pos[i].0) } else { std::mem::take(&mut self.pos[i].1) };
            self.collateral -= w;
            self.vault = self.vault.checked_sub(w).expect("vault overdrawn by a redeem");
            w
        }
    }

    #[test]
    fn presale_open_trade_resolve_finalize_claim() {
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let mut rnd = |max: u64| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) % max + 1
        };
        for _market in 0..40 {
            let fee_bps = [0u16, 100, 500][rnd(3) as usize - 1];
            let n_backers = rnd(11) as usize + 1; // 2..=12
            let n_traders = 5usize;
            let mut commits = vec![(0u64, 0u64); n_backers];
            let (mut pu, mut pd, mut fees, mut vault) = (0u64, 0u64, 0u64, 0u64);
            for (i, c) in commits.iter_mut().enumerate() {
                for _ in 0..rnd(3) {
                    let amount = rnd(500 * USDG) + USDG;
                    // Backer 0 is on UP, backer 1 on DOWN, the rest anywhere.
                    let up = match i { 0 => true, 1 => false, _ => rnd(2) == 1 };
                    let (fee, net) = fee_of(amount, fee_bps);
                    vault += amount;
                    fees += fee;
                    if up {
                        c.0 += net;
                        pu += net;
                    } else {
                        c.1 += net;
                        pd += net;
                    }
                }
            }
            let o = open_pools(pu, pd).unwrap();
            let mut sim = Sim {
                fee_bps,
                pu,
                pd,
                t: o.total,
                pool_up: o.pool_up,
                pool_down: o.pool_down,
                res_up: o.residual_up,
                res_down: o.residual_down,
                collateral: o.total,
                fees,
                vault,
                commits,
                converted: vec![false; n_backers],
                pos: vec![(0, 0); n_backers + n_traders],
            };
            sim.check();
            let holders = (n_backers + n_traders) as u64;
            for _ in 0..300 {
                let i = rnd(holders) as usize - 1;
                let up = rnd(2) == 1;
                match rnd(3) {
                    1 | 2 => sim.buy(i, up, rnd(200 * USDG)),
                    _ => sim.sell(i, up, rnd(100)),
                }
                sim.check();
            }
            for up_wins in [true, false] {
                let mut s = sim.clone();
                // At resolution the vault holds exactly collateral + fees.
                let at_resolve = s.vault;
                let mut paid = 0u64;
                // Half the backers convert before redeeming; the rest only
                // at claim_lp.
                for i in 0..s.pos.len() {
                    if i < n_backers && i % 2 == 0 {
                        s.convert(i);
                    }
                    paid += s.redeem(i, up_wins);
                }
                // finalize
                let inventory = if up_wins {
                    std::mem::take(&mut s.pool_up) + std::mem::take(&mut s.res_up)
                } else {
                    std::mem::take(&mut s.pool_down) + std::mem::take(&mut s.res_down)
                };
                s.collateral -= inventory;
                let lp_pot = inventory + std::mem::take(&mut s.fees);
                // claim_lp converts whoever has not, then they redeem.
                let mut lp_paid = 0u64;
                for i in 0..n_backers {
                    s.convert(i);
                    let (u, d) = s.commits[i];
                    let a = lp_share(lp_pot, u + d, s.t).unwrap();
                    lp_paid += a;
                    s.vault = s.vault.checked_sub(a).expect("vault overdrawn by claim_lp");
                    paid += s.redeem(i, up_wins);
                }
                assert!(lp_paid <= lp_pot);
                assert!(paid + lp_paid <= at_resolve, "paid {} of {at_resolve}", paid + lp_paid);
                assert_eq!(s.vault as u128, s.collateral as u128 + (lp_pot - lp_paid) as u128);
                // Dust: under one unit per backer from the conversion floors
                // and under one per backer from the LP floors.
                assert!(s.vault <= 2 * n_backers as u64, "dust {} with {n_backers} backers", s.vault);
            }
        }
    }
}
