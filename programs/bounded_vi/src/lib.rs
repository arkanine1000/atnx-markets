//! Bounded VI markets on Solana: the same instrument as
//! contracts/src/BoundedVIMarkets.sol. One `Config` for the program, one
//! `Market` per bounded market (PDA on an off-chain reference), one USDG
//! vault per market, one `Position` per (market, holder).
//!
//! Accounting: one UP plus one DOWN is a complete set backed by exactly
//! one USDG unit of `collateral` in the vault. For each side, the pool's
//! shares plus every holder's shares equal `collateral`. Buys mint sets
//! into the pool and take shares out at the fixed-product price; sells
//! return shares and burn as many sets as keep the product from falling.
//! Rounding always favours the pool. The oracle resolves; winners redeem
//! 1:1; the authority sweeps the pool's own winning shares and the fees.
//!
//! The mock USDG mint has the config PDA as its mint authority, so the
//! `faucet` instruction can hand anyone up to 10,000 USDG per call.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("5xdrKVQPYpCJ4YkzDysTmV3XPQN5vVwHV1RhAQ2xvABG");

pub const BPS: u128 = 10_000;
pub const MAX_FEE_BPS: u16 = 500;
pub const MAX_FAUCET: u64 = 10_000_000_000; // 10,000 USDG at 6 decimals

#[program]
pub mod bounded_vi {
    use super::*;

    /// One-time setup: the config PDA becomes the mint authority of the
    /// (fresh) mock USDG mint. `authority` owns the program's settings,
    /// is the operator and the oracle until changed.
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

    /// Opens a market. The operator's `seed` USDG moves into the vault and
    /// becomes that many complete sets in the pool (50/50 at `up_bps` 5000;
    /// any other opening probability keeps the larger pool at `seed` and
    /// hands the shares taken out of the other to the creator).
    pub fn create_market(ctx: Context<CreateMarket>, reference: [u8; 32], start_e2: u64, lower_e2: u64, upper_e2: u64, seed: u64, up_bps: u16) -> Result<()> {
        require!(lower_e2 < start_e2 && start_e2 < upper_e2, BmError::BadBounds);
        require!((500..=9500).contains(&up_bps), BmError::BadUpBps);
        require!(seed > 0, BmError::ZeroAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer { from: ctx.accounts.operator_usdg.to_account_info(), to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.operator.to_account_info() },
            ),
            seed,
        )?;

        let config = &mut ctx.accounts.config;
        config.market_count += 1;
        let m = &mut ctx.accounts.market;
        m.id = config.market_count;
        m.reference = reference;
        m.creator = ctx.accounts.operator.key();
        m.start_e2 = start_e2;
        m.lower_e2 = lower_e2;
        m.upper_e2 = upper_e2;
        m.status = Status::Open as u8;
        m.collateral = seed;
        m.created_at = Clock::get()?.unix_timestamp;
        m.bump = ctx.bumps.market;

        let s = seed as u128;
        if up_bps == 5000 {
            m.pool_up = seed;
            m.pool_down = seed;
        } else if up_bps > 5000 {
            let pool_up = s * (BPS - up_bps as u128) / up_bps as u128;
            m.pool_down = seed;
            m.pool_up = pool_up as u64;
            ctx.accounts.creator_position.up += seed - pool_up as u64;
        } else {
            let pool_down = s * up_bps as u128 / (BPS - up_bps as u128);
            m.pool_up = seed;
            m.pool_down = pool_down as u64;
            ctx.accounts.creator_position.down += seed - pool_down as u64;
        }
        emit!(MarketCreated { id: m.id, market: m.key(), reference, start_e2, lower_e2, upper_e2, seed, up_bps });
        Ok(())
    }

    pub fn buy(ctx: Context<Trade>, side: u8, invest: u64, min_shares: u64) -> Result<()> {
        let side = Side::try_from(side)?;
        let m = &mut ctx.accounts.market;
        require!(m.status == Status::Open as u8, BmError::NotOpen);
        require!(invest > 0, BmError::ZeroAmount);
        let fee_bps = ctx.accounts.config.fee_bps as u128;

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

        m.collateral += net as u64;
        m.fees += fee as u64;
        m.set_pools(side, new_this as u64, new_other as u64);
        let p = &mut ctx.accounts.position;
        match side { Side::Up => p.up += shares as u64, Side::Down => p.down += shares as u64 }
        emit!(Bought { market: m.key(), trader: ctx.accounts.trader.key(), side: side as u8, invest, fee: fee as u64, shares: shares as u64, pool_up: m.pool_up, pool_down: m.pool_down });
        Ok(())
    }

    pub fn sell(ctx: Context<Trade>, side: u8, shares: u64, min_return: u64) -> Result<()> {
        let side = Side::try_from(side)?;
        let m = &mut ctx.accounts.market;
        require!(m.status == Status::Open as u8, BmError::NotOpen);
        require!(shares > 0, BmError::ZeroAmount);
        let p = &mut ctx.accounts.position;
        let held = match side { Side::Up => p.up, Side::Down => p.down };
        require!(held >= shares, BmError::InsufficientShares);
        let fee_bps = ctx.accounts.config.fee_bps as u128;

        let (burned, fee, new_this, new_other) = sell_math(m.pool(side), m.pool(side.other()), shares as u128, fee_bps);
        require!(burned > 0, BmError::ZeroAmount);
        let payout = burned - fee;
        require!(payout >= min_return as u128, BmError::Slippage);

        match side { Side::Up => p.up = held - shares, Side::Down => p.down = held - shares }
        m.collateral -= burned as u64;
        m.fees += fee as u64;
        m.set_pools(side, new_this as u64, new_other as u64);

        vault_transfer(&ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.trader_usdg, m, payout as u64)?;
        emit!(Sold { market: m.key(), trader: ctx.accounts.trader.key(), side: side as u8, shares, payout: payout as u64, fee: fee as u64, pool_up: m.pool_up, pool_down: m.pool_down });
        Ok(())
    }

    pub fn resolve(ctx: Context<Resolve>, winner: u8, vi_e2: u64) -> Result<()> {
        let w = Side::try_from(winner)?;
        let m = &mut ctx.accounts.market;
        require!(m.status != Status::Resolved as u8, BmError::AlreadyResolved);
        require!(m.status == Status::Open as u8, BmError::NotOpen);
        m.status = Status::Resolved as u8;
        m.winner = w as u8;
        m.resolved_e2 = vi_e2;
        m.resolved_at = Clock::get()?.unix_timestamp;
        emit!(Resolved { market: m.key(), winner: w as u8, vi_e2 });
        Ok(())
    }

    pub fn redeem(ctx: Context<Trade>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == Status::Resolved as u8, BmError::NotResolved);
        let p = &mut ctx.accounts.position;
        let amount = if m.winner == Side::Up as u8 { std::mem::take(&mut p.up) } else { std::mem::take(&mut p.down) };
        if amount == 0 { return Ok(()); }
        m.collateral -= amount;
        vault_transfer(&ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.trader_usdg, m, amount)?;
        emit!(Redeemed { market: m.key(), holder: ctx.accounts.trader.key(), amount });
        Ok(())
    }

    /// After resolution: the pool's own winning shares (what the seed is
    /// worth) and the accrued fees go to the fee recipient.
    pub fn sweep(ctx: Context<Sweep>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == Status::Resolved as u8, BmError::NotResolved);
        let winner = if m.winner == Side::Up as u8 { Side::Up } else { Side::Down };
        let pool = m.pool(winner);
        m.set_pool(winner, 0);
        m.collateral -= pool;
        let fees = std::mem::take(&mut m.fees);
        let total = pool + fees;
        if total > 0 {
            vault_transfer(&ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.recipient_usdg, m, total)?;
        }
        emit!(Swept { market: m.key(), pool, fees });
        Ok(())
    }
}

// ---------------------------------------------------------------- math

/// Gnosis fixed-product buy, two outcomes.
fn buy_math(a: u64, b: u64, invest: u128, fee_bps: u128) -> (u128, u128, u128, u128) {
    let fee = ceil_div(invest * fee_bps, BPS);
    let net = invest - fee;
    let (a, b) = (a as u128, b as u128);
    let new_other = b + net;
    let new_this = ceil_div(a * b, new_other);
    (fee, net, new_this, new_other)
}

/// Exact-shares sell: burn r sets with (a + s - r)(b - r) >= a b.
fn sell_math(a: u64, b: u64, s: u128, fee_bps: u128) -> (u128, u128, u128, u128) {
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

fn ceil_div(x: u128, y: u128) -> u128 {
    if x == 0 { 0 } else { (x - 1) / y + 1 }
}

fn ceil_sqrt(n: u128) -> u128 {
    if n < 2 { return n; }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x { x = y; y = (x + n / x) / 2; }
    if x * x == n { x } else { x + 1 }
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

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Status { None = 0, Open = 1, Resolved = 2 }

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Side { Up = 0, Down = 1 }

impl Side {
    fn other(self) -> Side { match self { Side::Up => Side::Down, Side::Down => Side::Up } }
    fn try_from(v: u8) -> Result<Side> {
        match v { 0 => Ok(Side::Up), 1 => Ok(Side::Down), _ => err!(BmError::BadSide) }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub operator: Pubkey,
    pub oracle: Pubkey,
    pub fee_recipient: Pubkey,
    pub usdg_mint: Pubkey,
    pub fee_bps: u16,
    pub market_count: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub id: u64,
    pub reference: [u8; 32],
    pub creator: Pubkey,
    pub pool_up: u64,
    pub pool_down: u64,
    pub collateral: u64,
    pub fees: u64,
    pub start_e2: u64,
    pub lower_e2: u64,
    pub upper_e2: u64,
    pub resolved_e2: u64,
    pub status: u8,
    pub winner: u8,
    pub created_at: i64,
    pub resolved_at: i64,
    pub bump: u8,
}

impl Market {
    fn pool(&self, side: Side) -> u64 { match side { Side::Up => self.pool_up, Side::Down => self.pool_down } }
    fn set_pool(&mut self, side: Side, v: u64) { match side { Side::Up => self.pool_up = v, Side::Down => self.pool_down = v } }
    fn set_pools(&mut self, side: Side, this: u64, other: u64) { self.set_pool(side, this); self.set_pool(side.other(), other); }
}

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
    pub market: Account<'info, Market>,
    #[account(init, payer = operator, token::mint = usdg_mint, token::authority = market, seeds = [b"vault", market.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(init, payer = operator, space = 8 + Position::INIT_SPACE, seeds = [b"pos", market.key().as_ref(), operator.key().as_ref()], bump)]
    pub creator_position: Account<'info, Position>,
    pub usdg_mint: Account<'info, Mint>,
    #[account(mut, token::mint = usdg_mint, token::authority = operator)]
    pub operator_usdg: Account<'info, TokenAccount>,
    #[account(mut)]
    pub operator: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.reference.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = trader, space = 8 + Position::INIT_SPACE, seeds = [b"pos", market.key().as_ref(), trader.key().as_ref()], bump)]
    pub position: Account<'info, Position>,
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
    pub market: Account<'info, Market>,
    pub oracle: Signer<'info>,
}

#[derive(Accounts)]
pub struct Sweep<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.reference.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.usdg_mint, constraint = recipient_usdg.owner == config.fee_recipient @ BmError::BadRecipient)]
    pub recipient_usdg: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// --------------------------------------------------------------- events

#[event]
pub struct MarketCreated { pub id: u64, pub market: Pubkey, pub reference: [u8; 32], pub start_e2: u64, pub lower_e2: u64, pub upper_e2: u64, pub seed: u64, pub up_bps: u16 }
#[event]
pub struct Bought { pub market: Pubkey, pub trader: Pubkey, pub side: u8, pub invest: u64, pub fee: u64, pub shares: u64, pub pool_up: u64, pub pool_down: u64 }
#[event]
pub struct Sold { pub market: Pubkey, pub trader: Pubkey, pub side: u8, pub shares: u64, pub payout: u64, pub fee: u64, pub pool_up: u64, pub pool_down: u64 }
#[event]
pub struct Resolved { pub market: Pubkey, pub winner: u8, pub vi_e2: u64 }
#[event]
pub struct Redeemed { pub market: Pubkey, pub holder: Pubkey, pub amount: u64 }
#[event]
pub struct Swept { pub market: Pubkey, pub pool: u64, pub fees: u64 }

#[error_code]
pub enum BmError {
    #[msg("fee above the cap")] FeeTooHigh,
    #[msg("mint above the per-call cap")] MintTooLarge,
    #[msg("lower < start < upper required")] BadBounds,
    #[msg("opening probability outside 5%..95%")] BadUpBps,
    #[msg("side must be 0 (UP) or 1 (DOWN)")] BadSide,
    #[msg("amount is zero")] ZeroAmount,
    #[msg("market is not open")] NotOpen,
    #[msg("market is not resolved")] NotResolved,
    #[msg("market already resolved")] AlreadyResolved,
    #[msg("worse than the minimum you set")] Slippage,
    #[msg("not enough shares")] InsufficientShares,
    #[msg("recipient account is not the fee recipient's")] BadRecipient,
}
