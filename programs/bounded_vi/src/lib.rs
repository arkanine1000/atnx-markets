//! Bounded VI markets on Solana: two-outcome UP/DOWN markets on a subject's
//! Virality Index that resolve when the VI touches a bound. One `Config`
//! for the program, one `Market` per bounded market (PDA on an off-chain
//! reference), one USDG vault per market, one `Backer` per (market,
//! presale backer) and one `Position` per (market, holder).
//!
//! Lifecycle (no house money):
//!
//! 1. Presale. The operator creates the market; anyone `commit`s USDG to UP
//!    or DOWN. A fee of `fee_bps` (100 = 1 % on devnet) goes to `fees`; the
//!    net goes into the pots U and D and onto the backer's record.
//! 2. Open. The operator `open_market`s with the VI and the bounds. The
//!    vault already holds the money: T = U + D complete sets are minted
//!    (collateral = T). L = floor(20 % · T) sets become the pool, arranged
//!    so it opens at the clearing price p_up = U/T (the less likely side's
//!    pool stays at L, the other shrinks; the shares the shrink removes
//!    are the LP residual, held by the market for the backers). The other
//!    80 % belong to the backers: a UP backer with net commit u holds
//!    floor(0.8 · u · T/U) UP shares, DOWN likewise with D. Conversion is
//!    lazy: `claim_presale`, or the backer's first buy/sell/redeem with the
//!    `backer` account passed, or `claim_lp`, credits the Position.
//!    A presale with an empty side cannot open; the operator may
//!    `void_market` instead, and `claim_presale` then refunds every commit
//!    in full, fee included.
//! 3. Trading. Unchanged fixed-product market maker (`math.rs`): buys mint
//!    sets into the pool and take shares out; sells return shares and burn
//!    as many sets as keep the product from falling. Rounding favours the
//!    pool. 1 % fee on buys and sells, into `fees`.
//! 4. Resolution. The oracle resolves; winners `redeem` 1:1.
//! 5. LP pot. Once resolved, anyone may `finalize` (once): the pool's
//!    winning shares, the winning residual and all fees become `lp_pot`.
//!    Each backer's `claim_lp` pays floor(lp_pot · (u + d) / T) and closes
//!    the Backer record. The platform takes nothing from a bounded market.
//!
//! Accounting invariant. For each side, while the market is Open:
//!
//!   pool + lp_residual + Σ Position shares
//!        + Σ unconverted backers' presale shares + dust == collateral
//!
//! where dust = (T − L) − Σ every backer's floored presale shares, fixed at
//! open, 0 ≤ dust ≤ number of backers. The vault's balance is
//! presale_up + presale_down + fees in Presale and Void, collateral + fees
//! while Open or Resolved, and collateral + lp_pot − lp_claimed once
//! Finalized. After every winner has redeemed and every backer has claimed,
//! what is left is the dust, at most about two units per backer.
//!
//! The mock USDG mint has the config PDA as its mint authority, so the
//! `faucet` instruction can hand anyone up to 10,000 USDG per call.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

pub mod math;
use math::{buy_math, fee_of, lp_share, open_pools, presale_shares, sell_math, MathError};

declare_id!("5xdrKVQPYpCJ4YkzDysTmV3XPQN5vVwHV1RhAQ2xvABG");

pub const MAX_FEE_BPS: u16 = 500;
pub const MAX_FAUCET: u64 = 10_000_000_000; // 10,000 USDG at 6 decimals

#[program]
pub mod bounded_vi {
    use super::*;

    /// One-time setup: the config PDA becomes the mint authority of the
    /// (fresh) mock USDG mint. `authority` owns the program's settings,
    /// is the operator and the oracle until changed. `fee_recipient` is
    /// kept for layout compatibility; nothing pays it since the presale.
    pub fn initialize(ctx: Context<Initialize>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, BmError::FeeTooHigh);
        let c = &mut ctx.accounts.config;
        c.authority = ctx.accounts.authority.key();
        c.operator = ctx.accounts.authority.key();
        c.oracle = ctx.accounts.authority.key();
        c.fee_recipient = ctx.accounts.authority.key();
        c.usdg_mint = ctx.accounts.usdg_mint.key();
        c.fee_bps = fee_bps;
        c.market_count = 0;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_roles(ctx: Context<SetRoles>, operator: Option<Pubkey>, oracle: Option<Pubkey>, fee_recipient: Option<Pubkey>, fee_bps: Option<u16>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        if let Some(o) = operator { c.operator = o; }
        if let Some(o) = oracle { c.oracle = o; }
        if let Some(f) = fee_recipient { c.fee_recipient = f; }
        if let Some(b) = fee_bps {
            require!(b <= MAX_FEE_BPS, BmError::FeeTooHigh);
            c.fee_bps = b;
        }
        Ok(())
    }

    /// Mints mock USDG to any token account. Testnet only.
    pub fn faucet(ctx: Context<Faucet>, amount: u64) -> Result<()> {
        require!(amount <= MAX_FAUCET, BmError::MintTooLarge);
        let seeds: &[&[u8]] = &[b"config", &[ctx.accounts.config.bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo { mint: ctx.accounts.usdg_mint.to_account_info(), to: ctx.accounts.to.to_account_info(), authority: ctx.accounts.config.to_account_info() },
                &[seeds],
            ),
            amount,
        )
    }

    /// Creates a market and its vault in presale. No money moves; the
    /// bounds are set when the operator opens it.
    pub fn create_market(ctx: Context<CreateMarket>, reference: [u8; 32]) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.market_count = config.market_count.checked_add(1).ok_or(BmError::Overflow)?;
        let m = &mut ctx.accounts.market;
        m.id = config.market_count;
        m.reference = reference;
        m.creator = ctx.accounts.operator.key();
        m.status = Status::Presale as u8;
        m.created_at = Clock::get()?.unix_timestamp;
        m.bump = ctx.bumps.market;
        emit!(MarketCreated { id: m.id, market: m.key(), reference });
        Ok(())
    }

    /// Presale: lock `amount` USDG on UP (0) or DOWN (1). The fee goes to
    /// the market's fees (and so, at the end, back to the backers); the net
    /// joins the side's pot and the backer's record.
    pub fn commit(ctx: Context<Commit>, side: u8, amount: u64) -> Result<()> {
        let side = Side::try_from(side)?;
        require!(amount > 0, BmError::ZeroAmount);
        let m = &mut ctx.accounts.market;
        require!(m.status == Status::Presale as u8, BmError::NotPresale);
        let (fee, net) = fee_of(amount, ctx.accounts.config.fee_bps);
        require!(net > 0, BmError::ZeroAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer { from: ctx.accounts.holder_usdg.to_account_info(), to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.holder.to_account_info() },
            ),
            amount,
        )?;

        m.fees = m.fees.checked_add(fee).ok_or(BmError::Overflow)?;
        let b = &mut ctx.accounts.backer;
        if b.holder == Pubkey::default() {
            b.market = m.key();
            b.holder = ctx.accounts.holder.key();
            b.bump = ctx.bumps.backer;
        }
        b.fee_paid = b.fee_paid.checked_add(fee).ok_or(BmError::Overflow)?;
        match side {
            Side::Up => {
                m.presale_up = m.presale_up.checked_add(net).ok_or(BmError::Overflow)?;
                b.presale_up = b.presale_up.checked_add(net).ok_or(BmError::Overflow)?;
            }
            Side::Down => {
                m.presale_down = m.presale_down.checked_add(net).ok_or(BmError::Overflow)?;
                b.presale_down = b.presale_down.checked_add(net).ok_or(BmError::Overflow)?;
            }
        }
        emit!(Committed { market: m.key(), holder: ctx.accounts.holder.key(), side: side as u8, amount, fee, net, presale_up: m.presale_up, presale_down: m.presale_down });
        Ok(())
    }

    /// Ends the presale: mints T = U + D sets, puts 20 % of them in the
    /// pool at the clearing price U/T, sets the bounds and opens trading.
    /// Both pots must hold money.
    pub fn open_market(ctx: Context<OperatorMarket>, start_e2: u64, lower_e2: u64, upper_e2: u64) -> Result<()> {
        require!(lower_e2 < start_e2 && start_e2 < upper_e2, BmError::BadBounds);
        let m = &mut ctx.accounts.market;
        require!(m.status == Status::Presale as u8, BmError::NotPresale);
        let o = open_pools(m.presale_up, m.presale_down).map_err(BmError::from)?;
        m.collateral = o.total;
        m.pool_up = o.pool_up;
        m.pool_down = o.pool_down;
        m.lp_residual_up = o.residual_up;
        m.lp_residual_down = o.residual_down;
        m.start_e2 = start_e2;
        m.lower_e2 = lower_e2;
        m.upper_e2 = upper_e2;
        m.opened_at = Clock::get()?.unix_timestamp;
        m.status = Status::Open as u8;
        emit!(MarketOpened {
            market: m.key(),
            start_e2,
            lower_e2,
            upper_e2,
            presale_up: m.presale_up,
            presale_down: m.presale_down,
            liquidity: o.liquidity,
            pool_up: o.pool_up,
            pool_down: o.pool_down,
            residual_up: o.residual_up,
            residual_down: o.residual_down,
        });
        Ok(())
    }

    /// Cancels a market still in presale. Every backer then gets their
    /// commits back in full, fee included, through `claim_presale`.
    pub fn void_market(ctx: Context<OperatorMarket>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == Status::Presale as u8, BmError::NotPresale);
        m.status = Status::Void as u8;
        emit!(MarketVoided { market: m.key(), presale_up: m.presale_up, presale_down: m.presale_down });
        Ok(())
    }

    /// On an open (or resolved) market: converts the backer's commits into
    /// Position shares. On a void market: refunds the commits and their
    /// fees and closes the backer's record (and the empty position).
    pub fn claim_presale(ctx: Context<ClaimPresale>) -> Result<()> {
        let status = ctx.accounts.market.status;
        if status == Status::Void as u8 {
            let b = &ctx.accounts.backer;
            let (up, down, fee) = (b.presale_up, b.presale_down, b.fee_paid);
            let refund = up.checked_add(down).and_then(|x| x.checked_add(fee)).ok_or(BmError::Overflow)?;
            let m = &mut ctx.accounts.market;
            m.presale_up = m.presale_up.checked_sub(up).ok_or(BmError::Overflow)?;
            m.presale_down = m.presale_down.checked_sub(down).ok_or(BmError::Overflow)?;
            m.fees = m.fees.checked_sub(fee).ok_or(BmError::Overflow)?;
            if refund > 0 {
                vault_transfer(&ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.holder_usdg, m, refund)?;
            }
            emit!(Refunded { market: m.key(), holder: ctx.accounts.holder.key(), amount: refund });
            ctx.accounts.backer.close(ctx.accounts.holder.to_account_info())?;
            ctx.accounts.position.close(ctx.accounts.holder.to_account_info())?;
            return Ok(());
        }
        require!(is_live(status), BmError::NotOpen);
        require!(!ctx.accounts.backer.converted, BmError::AlreadyConverted);
        let market_key = ctx.accounts.market.key();
        let holder = ctx.accounts.holder.key();
        convert(&ctx.accounts.market, market_key, holder, &mut ctx.accounts.backer, &mut ctx.accounts.position)
    }

    /// Spend `invest` USDG on a side. Pass the trader's `backer` account
    /// (or null) to convert their presale commits first.
    pub fn buy(ctx: Context<Trade>, side: u8, invest: u64, min_shares: u64) -> Result<()> {
        let side = Side::try_from(side)?;
        require!(invest > 0, BmError::ZeroAmount);
        require!(ctx.accounts.market.status == Status::Open as u8, BmError::NotOpen);
        touch(&ctx.accounts.market, ctx.accounts.trader.key(), &mut ctx.accounts.backer, &mut ctx.accounts.position)?;
        let fee_bps = ctx.accounts.config.fee_bps as u128;
        let m = &mut ctx.accounts.market;

        let (fee, net, new_this, new_other) = buy_math(m.pool(side), m.pool(side.other()), invest as u128, fee_bps);
        let shares = m.pool(side) as u128 + net - new_this;
        require!(shares > 0, BmError::ZeroAmount);
        require!(shares >= min_shares as u128, BmError::Slippage);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer { from: ctx.accounts.trader_usdg.to_account_info(), to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.trader.to_account_info() },
            ),
            invest,
        )?;

        m.collateral = m.collateral.checked_add(net as u64).ok_or(BmError::Overflow)?;
        m.fees = m.fees.checked_add(fee as u64).ok_or(BmError::Overflow)?;
        m.set_pools(side, new_this as u64, new_other as u64);
        let p = &mut ctx.accounts.position;
        match side {
            Side::Up => p.up = p.up.checked_add(shares as u64).ok_or(BmError::Overflow)?,
            Side::Down => p.down = p.down.checked_add(shares as u64).ok_or(BmError::Overflow)?,
        }
        emit!(Bought { market: m.key(), trader: ctx.accounts.trader.key(), side: side as u8, invest, fee: fee as u64, shares: shares as u64, pool_up: m.pool_up, pool_down: m.pool_down });
        Ok(())
    }

    /// Sell `shares` of a side back to the pool.
    pub fn sell(ctx: Context<Trade>, side: u8, shares: u64, min_return: u64) -> Result<()> {
        let side = Side::try_from(side)?;
        require!(shares > 0, BmError::ZeroAmount);
        require!(ctx.accounts.market.status == Status::Open as u8, BmError::NotOpen);
        touch(&ctx.accounts.market, ctx.accounts.trader.key(), &mut ctx.accounts.backer, &mut ctx.accounts.position)?;
        let fee_bps = ctx.accounts.config.fee_bps as u128;
        let m = &mut ctx.accounts.market;
        let p = &mut ctx.accounts.position;
        let held = match side { Side::Up => p.up, Side::Down => p.down };
        require!(held >= shares, BmError::InsufficientShares);

        let (burned, fee, new_this, new_other) = sell_math(m.pool(side), m.pool(side.other()), shares as u128, fee_bps);
        require!(burned > 0, BmError::ZeroAmount);
        let payout = burned - fee;
        require!(payout >= min_return as u128, BmError::Slippage);

        match side { Side::Up => p.up = held - shares, Side::Down => p.down = held - shares }
        m.collateral = m.collateral.checked_sub(burned as u64).ok_or(BmError::Overflow)?;
        m.fees = m.fees.checked_add(fee as u64).ok_or(BmError::Overflow)?;
        m.set_pools(side, new_this as u64, new_other as u64);

        vault_transfer(&ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.trader_usdg, m, payout as u64)?;
        emit!(Sold { market: m.key(), trader: ctx.accounts.trader.key(), side: side as u8, shares, payout: payout as u64, fee: fee as u64, pool_up: m.pool_up, pool_down: m.pool_down });
        Ok(())
    }

    pub fn resolve(ctx: Context<Resolve>, winner: u8, vi_e2: u64) -> Result<()> {
        let w = Side::try_from(winner)?;
        let m = &mut ctx.accounts.market;
        require!(m.status != Status::Resolved as u8 && m.status != Status::Finalized as u8, BmError::AlreadyResolved);
        require!(m.status == Status::Open as u8, BmError::NotOpen);
        m.status = Status::Resolved as u8;
        m.winner = w as u8;
        m.resolved_e2 = vi_e2;
        m.resolved_at = Clock::get()?.unix_timestamp;
        emit!(Resolved { market: m.key(), winner: w as u8, vi_e2 });
        Ok(())
    }

    /// Pays the holder's winning shares 1:1. Pass the `backer` account (or
    /// null) to convert unclaimed presale shares first.
    pub fn redeem(ctx: Context<Trade>) -> Result<()> {
        let status = ctx.accounts.market.status;
        require!(status == Status::Resolved as u8 || status == Status::Finalized as u8, BmError::NotResolved);
        touch(&ctx.accounts.market, ctx.accounts.trader.key(), &mut ctx.accounts.backer, &mut ctx.accounts.position)?;
        let m = &mut ctx.accounts.market;
        let p = &mut ctx.accounts.position;
        let amount = if m.winner == Side::Up as u8 { std::mem::take(&mut p.up) } else { std::mem::take(&mut p.down) };
        if amount == 0 { return Ok(()); }
        m.collateral = m.collateral.checked_sub(amount).ok_or(BmError::Overflow)?;
        vault_transfer(&ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.trader_usdg, m, amount)?;
        emit!(Redeemed { market: m.key(), holder: ctx.accounts.trader.key(), amount });
        Ok(())
    }

    /// After resolution, once, by anyone: the pool's winning shares, the
    /// winning LP residual and every fee become the LP pot.
    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status != Status::Finalized as u8, BmError::AlreadyFinalized);
        require!(m.status == Status::Resolved as u8, BmError::NotResolved);
        let (pool, residual) = if m.winner == Side::Up as u8 {
            (std::mem::take(&mut m.pool_up), std::mem::take(&mut m.lp_residual_up))
        } else {
            (std::mem::take(&mut m.pool_down), std::mem::take(&mut m.lp_residual_down))
        };
        let inventory = pool.checked_add(residual).ok_or(BmError::Overflow)?;
        m.collateral = m.collateral.checked_sub(inventory).ok_or(BmError::Overflow)?;
        let fees = std::mem::take(&mut m.fees);
        m.lp_pot = inventory.checked_add(fees).ok_or(BmError::Overflow)?;
        m.status = Status::Finalized as u8;
        emit!(MarketFinalized { market: m.key(), winner: m.winner, pool, residual, fees, lp_pot: m.lp_pot });
        Ok(())
    }

    /// A backer's share of the LP pot, (u + d) / T of it. Converts any
    /// unclaimed presale shares into the Position first, then closes the
    /// Backer record.
    pub fn claim_lp(ctx: Context<ClaimLp>) -> Result<()> {
        require!(ctx.accounts.market.status == Status::Finalized as u8, BmError::NotFinalized);
        require!(!ctx.accounts.backer.lp_claimed, BmError::NothingToClaim);
        let market_key = ctx.accounts.market.key();
        let holder = ctx.accounts.holder.key();
        if !ctx.accounts.backer.converted {
            convert(&ctx.accounts.market, market_key, holder, &mut ctx.accounts.backer, &mut ctx.accounts.position)?;
        }
        let m = &mut ctx.accounts.market;
        let b = &mut ctx.accounts.backer;
        let total = m.presale_up.checked_add(m.presale_down).ok_or(BmError::Overflow)?;
        let commit = b.presale_up.checked_add(b.presale_down).ok_or(BmError::Overflow)?;
        let amount = lp_share(m.lp_pot, commit, total).map_err(BmError::from)?;
        b.lp_claimed = true;
        m.lp_claimed = m.lp_claimed.checked_add(amount).ok_or(BmError::Overflow)?;
        if amount > 0 {
            vault_transfer(&ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.holder_usdg, m, amount)?;
        }
        emit!(LpClaimed { market: market_key, holder, amount });
        Ok(())
    }
}

// -------------------------------------------------------------- helpers

/// Open, Resolved or Finalized: the presale has cleared.
fn is_live(status: u8) -> bool {
    status == Status::Open as u8 || status == Status::Resolved as u8 || status == Status::Finalized as u8
}

/// Credits a backer's presale shares to their position, once.
fn convert(m: &Market, market_key: Pubkey, holder: Pubkey, b: &mut Backer, p: &mut Position) -> Result<()> {
    require!(b.market == market_key && b.holder == holder, BmError::BadBacker);
    require!(!b.converted, BmError::AlreadyConverted);
    let total = m.presale_up.checked_add(m.presale_down).ok_or(BmError::Overflow)?;
    let up = presale_shares(b.presale_up, m.presale_up, total).map_err(BmError::from)?;
    let down = presale_shares(b.presale_down, m.presale_down, total).map_err(BmError::from)?;
    p.up = p.up.checked_add(up).ok_or(BmError::Overflow)?;
    p.down = p.down.checked_add(down).ok_or(BmError::Overflow)?;
    b.converted = true;
    emit!(PresaleClaimed { market: market_key, holder, up, down });
    Ok(())
}

/// The implicit conversion in buy/sell/redeem when the trader passes their
/// Backer account. A no-op once converted.
fn touch<'info>(market: &Account<'info, Market>, holder: Pubkey, backer: &mut Option<Box<Account<'info, Backer>>>, p: &mut Position) -> Result<()> {
    if let Some(b) = backer.as_mut() {
        if !b.converted {
            convert(market, market.key(), holder, b, p)?;
        } else {
            require!(b.market == market.key() && b.holder == holder, BmError::BadBacker);
        }
    }
    Ok(())
}

fn vault_transfer<'info>(token_program: &Program<'info, Token>, vault: &Account<'info, TokenAccount>, to: &Account<'info, TokenAccount>, market: &Account<'info, Market>, amount: u64) -> Result<()> {
    let seeds: &[&[u8]] = &[b"market", &market.reference, &[market.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer { from: vault.to_account_info(), to: to.to_account_info(), authority: market.to_account_info() },
            &[seeds],
        ),
        amount,
    )
}

// ------------------------------------------------------------- accounts

/// Market status. 0–2 keep their pre-presale values.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Status { None = 0, Open = 1, Resolved = 2, Presale = 3, Void = 4, Finalized = 5 }

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Side { Up = 0, Down = 1 }

impl Side {
    fn other(self) -> Side { match self { Side::Up => Side::Down, Side::Down => Side::Up } }
    fn try_from(v: u8) -> Result<Side> {
        match v { 0 => Ok(Side::Up), 1 => Ok(Side::Down), _ => err!(BmError::BadSide) }
    }
}

/// Unchanged from the treasury-seeded version, so the deployed config PDA
/// keeps working without a new `initialize`.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub operator: Pubkey,
    pub oracle: Pubkey,
    pub fee_recipient: Pubkey,   // unused since the presale: fees go to backers
    pub usdg_mint: Pubkey,
    pub fee_bps: u16,
    pub market_count: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub id: u64,                 // offset 8
    pub reference: [u8; 32],     // offset 16
    pub creator: Pubkey,
    pub pool_up: u64,
    pub pool_down: u64,
    pub collateral: u64,         // complete sets in the vault (T at open)
    pub fees: u64,               // commit, buy and sell fees until finalize
    pub start_e2: u64,
    pub lower_e2: u64,
    pub upper_e2: u64,
    pub resolved_e2: u64,
    pub status: u8,
    pub winner: u8,
    pub created_at: i64,
    pub resolved_at: i64,
    pub bump: u8,
    // presale
    pub presale_up: u64,         // U, net of fees; fixed at open
    pub presale_down: u64,       // D
    pub lp_residual_up: u64,     // shares the skew took out of the pool
    pub lp_residual_down: u64,
    pub lp_pot: u64,             // set by finalize
    pub lp_claimed: u64,
    pub opened_at: i64,
    pub _reserved: [u8; 64],
}

impl Market {
    fn pool(&self, side: Side) -> u64 { match side { Side::Up => self.pool_up, Side::Down => self.pool_down } }
    fn set_pool(&mut self, side: Side, v: u64) { match side { Side::Up => self.pool_up = v, Side::Down => self.pool_down = v } }
    fn set_pools(&mut self, side: Side, this: u64, other: u64) { self.set_pool(side, this); self.set_pool(side.other(), other); }
}

/// One per (market, presale backer), PDA ["backer", market, holder].
#[account]
#[derive(InitSpace)]
pub struct Backer {
    pub market: Pubkey,          // offset 8
    pub holder: Pubkey,          // offset 40
    pub presale_up: u64,         // net commits
    pub presale_down: u64,
    pub fee_paid: u64,           // refunded with the commits if the market is voided
    pub converted: bool,         // presale shares credited to the Position
    pub lp_claimed: bool,
    pub bump: u8,
}

/// One per (market, holder), PDA ["pos", market, holder].
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub up: u64,
    pub down: u64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = authority, mint::decimals = 6, mint::authority = config)]
    pub usdg_mint: Account<'info, Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SetRoles<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Faucet<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = usdg_mint)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub usdg_mint: Account<'info, Mint>,
    #[account(mut, token::mint = usdg_mint)]
    pub to: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(reference: [u8; 32])]
pub struct CreateMarket<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = operator, has_one = usdg_mint)]
    pub config: Account<'info, Config>,
    #[account(init, payer = operator, space = 8 + Market::INIT_SPACE, seeds = [b"market", reference.as_ref()], bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(init, payer = operator, token::mint = usdg_mint, token::authority = market, seeds = [b"vault", market.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    pub usdg_mint: Account<'info, Mint>,
    #[account(mut)]
    pub operator: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Commit<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.reference.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = holder, space = 8 + Backer::INIT_SPACE, seeds = [b"backer", market.key().as_ref(), holder.key().as_ref()], bump)]
    pub backer: Box<Account<'info, Backer>>,
    #[account(mut, token::mint = config.usdg_mint, token::authority = holder)]
    pub holder_usdg: Account<'info, TokenAccount>,
    #[account(mut)]
    pub holder: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// `open_market` and `void_market`.
#[derive(Accounts)]
pub struct OperatorMarket<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = operator)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.reference.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    pub operator: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimPresale<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.reference.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"backer", market.key().as_ref(), holder.key().as_ref()], bump = backer.bump)]
    pub backer: Box<Account<'info, Backer>>,
    #[account(init_if_needed, payer = holder, space = 8 + Position::INIT_SPACE, seeds = [b"pos", market.key().as_ref(), holder.key().as_ref()], bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, token::mint = config.usdg_mint, token::authority = holder)]
    pub holder_usdg: Account<'info, TokenAccount>,
    #[account(mut)]
    pub holder: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// `buy`, `sell` and `redeem`. `backer` is optional: pass the trader's
/// Backer PDA to convert their presale shares on first touch, or null.
#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.reference.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = trader, space = 8 + Position::INIT_SPACE, seeds = [b"pos", market.key().as_ref(), trader.key().as_ref()], bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut)]
    pub backer: Option<Box<Account<'info, Backer>>>,
    #[account(mut, token::mint = config.usdg_mint, token::authority = trader)]
    pub trader_usdg: Account<'info, TokenAccount>,
    #[account(mut)]
    pub trader: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = oracle)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.reference.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    pub oracle: Signer<'info>,
}

/// Anyone may finalize; the fee payer signs the transaction.
#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(mut, seeds = [b"market", market.reference.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
}

#[derive(Accounts)]
pub struct ClaimLp<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.reference.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, close = holder, seeds = [b"backer", market.key().as_ref(), holder.key().as_ref()], bump = backer.bump)]
    pub backer: Box<Account<'info, Backer>>,
    #[account(init_if_needed, payer = holder, space = 8 + Position::INIT_SPACE, seeds = [b"pos", market.key().as_ref(), holder.key().as_ref()], bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, token::mint = config.usdg_mint, token::authority = holder)]
    pub holder_usdg: Account<'info, TokenAccount>,
    #[account(mut)]
    pub holder: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// --------------------------------------------------------------- events

#[event]
pub struct MarketCreated { pub id: u64, pub market: Pubkey, pub reference: [u8; 32] }
#[event]
pub struct Committed { pub market: Pubkey, pub holder: Pubkey, pub side: u8, pub amount: u64, pub fee: u64, pub net: u64, pub presale_up: u64, pub presale_down: u64 }
#[event]
pub struct MarketOpened { pub market: Pubkey, pub start_e2: u64, pub lower_e2: u64, pub upper_e2: u64, pub presale_up: u64, pub presale_down: u64, pub liquidity: u64, pub pool_up: u64, pub pool_down: u64, pub residual_up: u64, pub residual_down: u64 }
#[event]
pub struct MarketVoided { pub market: Pubkey, pub presale_up: u64, pub presale_down: u64 }
#[event]
pub struct PresaleClaimed { pub market: Pubkey, pub holder: Pubkey, pub up: u64, pub down: u64 }
#[event]
pub struct Refunded { pub market: Pubkey, pub holder: Pubkey, pub amount: u64 }
#[event]
pub struct Bought { pub market: Pubkey, pub trader: Pubkey, pub side: u8, pub invest: u64, pub fee: u64, pub shares: u64, pub pool_up: u64, pub pool_down: u64 }
#[event]
pub struct Sold { pub market: Pubkey, pub trader: Pubkey, pub side: u8, pub shares: u64, pub payout: u64, pub fee: u64, pub pool_up: u64, pub pool_down: u64 }
#[event]
pub struct Resolved { pub market: Pubkey, pub winner: u8, pub vi_e2: u64 }
#[event]
pub struct Redeemed { pub market: Pubkey, pub holder: Pubkey, pub amount: u64 }
#[event]
pub struct MarketFinalized { pub market: Pubkey, pub winner: u8, pub pool: u64, pub residual: u64, pub fees: u64, pub lp_pot: u64 }
#[event]
pub struct LpClaimed { pub market: Pubkey, pub holder: Pubkey, pub amount: u64 }

#[error_code]
pub enum BmError {
    #[msg("fee above the cap")] FeeTooHigh,
    #[msg("mint above the per-call cap")] MintTooLarge,
    #[msg("lower < start < upper required")] BadBounds,
    #[msg("side must be 0 (UP) or 1 (DOWN)")] BadSide,
    #[msg("amount is zero")] ZeroAmount,
    #[msg("market is not open")] NotOpen,
    #[msg("market is not resolved")] NotResolved,
    #[msg("market already resolved")] AlreadyResolved,
    #[msg("worse than the minimum you set")] Slippage,
    #[msg("not enough shares")] InsufficientShares,
    #[msg("market is not in presale")] NotPresale,
    #[msg("both sides need presale money before the market can open")] EmptySide,
    #[msg("presale too lopsided: the smaller pool side rounds to zero")] ThinPool,
    #[msg("presale shares already claimed")] AlreadyConverted,
    #[msg("backer account belongs to another market or holder")] BadBacker,
    #[msg("market is not finalized")] NotFinalized,
    #[msg("market already finalized")] AlreadyFinalized,
    #[msg("nothing to claim")] NothingToClaim,
    #[msg("arithmetic overflow")] Overflow,
}

impl From<MathError> for BmError {
    fn from(e: MathError) -> Self {
        match e {
            MathError::Overflow => BmError::Overflow,
            MathError::EmptySide => BmError::EmptySide,
            MathError::ThinPool => BmError::ThinPool,
        }
    }
}
