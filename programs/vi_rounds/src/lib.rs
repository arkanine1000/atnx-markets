//! Rolling rounds on the ATNX Virality Index (VI), on Solana.
//!
//! One `Series` per subject. A series is a chain of rounds: while round N
//! trades, round N+1 takes presale commits. A round asks one question: will
//! the subject's VI, averaged over the round's final window, be at or above
//! the VI at the round's open.
//!
//! Engine: Pennock's dynamic pari-mutuel market (2004), variant I with price
//! function I (`math.rs`). Presale commits clear at one price per side, the
//! pot share: with pots U and D the round opens with M1 = U, M2 = D and
//! N1 = N2 = U + D. A live buy of `m` on a side with money M and the other
//! side's shares N buys `N · ln(1 + m/M)` shares. At settlement a winner gets
//! their net stake back plus `shares · M_lose / N_win`; a correct bet never
//! loses. There is no selling: the exit before settlement is buying the
//! other side.
//!
//! Money: one USDG vault per series (the series PDA is its authority). Fees
//! accrue in two counters on the series, for the finder (who started the
//! series) and the platform. A rollover moves a payout into the current
//! presale round without leaving the vault.
//!
//! Roles: `authority` owns the config; `keeper` creates series, opens and
//! settles rounds (it is the oracle); `treasury` withdraws platform fees.
//! The mock USDG mint has the config PDA as its mint authority, so the
//! `faucet` instruction can hand anyone up to 10,000 USDG per call.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

pub mod math;
use math::{fee_split, payout, presale_shares, shares_for_spend, MathError};

declare_id!("5PsYwtsaexsFLGz6pwnVAtBTLzRqmGHxQJFnYWv42aQX");

pub const MAX_FEE_BPS: u16 = 500;
pub const MAX_FAUCET: u64 = 10_000_000_000; // 10,000 USDG at 6 decimals
pub const MIN_ROUND_SECS: u32 = 20;

#[program]
pub mod vi_rounds {
    use super::*;

    /// One-time setup. The config PDA becomes the mint authority of the
    /// fresh mock USDG mint; `authority` is also keeper and treasury until
    /// `set_config` changes them.
    pub fn initialize(ctx: Context<Initialize>, fee_bps: u16, finder_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, RoundsError::FeeTooHigh);
        require!(finder_bps as u128 <= math::BPS, RoundsError::FeeTooHigh);
        let c = &mut ctx.accounts.config;
        c.authority = ctx.accounts.authority.key();
        c.keeper = ctx.accounts.authority.key();
        c.treasury = ctx.accounts.authority.key();
        c.usdg_mint = ctx.accounts.usdg_mint.key();
        c.fee_bps = fee_bps;
        c.finder_bps = finder_bps;
        c.series_count = 0;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_config(ctx: Context<SetConfig>, keeper: Option<Pubkey>, treasury: Option<Pubkey>, fee_bps: Option<u16>, finder_bps: Option<u16>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        if let Some(k) = keeper { c.keeper = k; }
        if let Some(t) = treasury { c.treasury = t; }
        if let Some(b) = fee_bps {
            require!(b <= MAX_FEE_BPS, RoundsError::FeeTooHigh);
            c.fee_bps = b;
        }
        if let Some(b) = finder_bps {
            require!(b as u128 <= math::BPS, RoundsError::FeeTooHigh);
            c.finder_bps = b;
        }
        Ok(())
    }

    /// Mints mock USDG to any token account. Testnet only.
    pub fn faucet(ctx: Context<Faucet>, amount: u64) -> Result<()> {
        require!(amount <= MAX_FAUCET, RoundsError::MintTooLarge);
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

    /// Starts a series: its vault and round 1 in presale. The fee terms are
    /// copied from the config so a later config change does not move the
    /// goalposts on a running series.
    pub fn create_series(ctx: Context<CreateSeries>, reference: [u8; 32], round_secs: u32, settle_window_secs: u32, ante: u64, finder: Pubkey) -> Result<()> {
        require!(round_secs >= MIN_ROUND_SECS, RoundsError::BadWindow);
        require!(settle_window_secs < round_secs, RoundsError::BadWindow);
        let config = &mut ctx.accounts.config;
        config.series_count += 1;
        let s = &mut ctx.accounts.series;
        s.finder = finder;
        s.reference = reference;
        s.index = config.series_count;
        s.round_secs = round_secs;
        s.settle_window_secs = settle_window_secs;
        s.fee_bps = config.fee_bps;
        s.finder_bps = config.finder_bps;
        s.ante = ante;
        s.paused = false;
        s.live_round = 0;
        s.presale_round = 1;
        s.finder_fees = 0;
        s.platform_fees = 0;
        s.vault_bump = ctx.bumps.vault;
        s.bump = ctx.bumps.series;
        let r = &mut ctx.accounts.round;
        r.series = s.key();
        r.index = 1;
        r.state = RoundState::Presale as u8;
        r.bump = ctx.bumps.round;
        emit!(SeriesCreated { series: s.key(), reference, finder, round_secs, settle_window_secs });
        Ok(())
    }

    /// Pauses or resumes a series, moves the finder, or changes the ante.
    /// The authority or the keeper.
    pub fn set_series(ctx: Context<SetSeries>, paused: Option<bool>, finder: Option<Pubkey>, ante: Option<u64>) -> Result<()> {
        let s = &mut ctx.accounts.series;
        if let Some(p) = paused { s.paused = p; }
        if let Some(f) = finder { s.finder = f; }
        if let Some(a) = ante { s.ante = a; }
        Ok(())
    }

    /// Presale: lock USDG on UP or DOWN in the series' current presale round.
    pub fn commit(ctx: Context<Commit>, side: u8, amount: u64) -> Result<()> {
        let side = Side::try_from(side)?;
        require!(amount > 0, RoundsError::ZeroAmount);
        let s = &mut ctx.accounts.series;
        let r = &mut ctx.accounts.round;
        require!(!s.paused, RoundsError::Paused);
        require!(r.state == RoundState::Presale as u8 && r.index == s.presale_round, RoundsError::NotPresale);
        let (fee, finder, platform, net) = fee_split(amount, s.fee_bps, s.finder_bps);
        require!(net > 0, RoundsError::ZeroAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer { from: ctx.accounts.holder_usdg.to_account_info(), to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.holder.to_account_info() },
            ),
            amount,
        )?;
        s.finder_fees = s.finder_fees.checked_add(finder).ok_or(RoundsError::Overflow)?;
        s.platform_fees = s.platform_fees.checked_add(platform).ok_or(RoundsError::Overflow)?;
        let p = &mut ctx.accounts.position;
        init_position(p, r.key(), ctx.accounts.holder.key(), ctx.bumps.position);
        match side {
            Side::Up => {
                r.presale_up = r.presale_up.checked_add(net).ok_or(RoundsError::Overflow)?;
                p.presale_up = p.presale_up.checked_add(net).ok_or(RoundsError::Overflow)?;
            }
            Side::Down => {
                r.presale_down = r.presale_down.checked_add(net).ok_or(RoundsError::Overflow)?;
                p.presale_down = p.presale_down.checked_add(net).ok_or(RoundsError::Overflow)?;
            }
        }
        emit!(Committed { round: r.key(), holder: ctx.accounts.holder.key(), side: side as u8, amount, fee, net, presale_up: r.presale_up, presale_down: r.presale_down });
        Ok(())
    }

    /// Opens the presale round for trading at the current VI and creates
    /// the next round's presale. Both pots must hold money: the pot shares
    /// are the opening prices, and the pari-mutuel maths needs money on
    /// both sides. The keeper antes the empty side with an ordinary
    /// `commit` before calling this.
    pub fn open_round(ctx: Context<OpenRound>, target_e2: u64, next_index: u32) -> Result<()> {
        let s = &mut ctx.accounts.series;
        let r = &mut ctx.accounts.round;
        require!(!s.paused, RoundsError::Paused);
        require!(s.live_round == 0, RoundsError::LiveRoundExists);
        require!(r.state == RoundState::Presale as u8 && r.index == s.presale_round, RoundsError::NotPresale);
        require!(next_index == r.index + 1, RoundsError::BadRound);
        require!(r.presale_up > 0 && r.presale_down > 0, RoundsError::EmptySide);
        require!(target_e2 > 0, RoundsError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        let total = r.presale_up.checked_add(r.presale_down).ok_or(RoundsError::Overflow)?;
        r.m_up = r.presale_up;
        r.m_down = r.presale_down;
        r.n_up = total;
        r.n_down = total;
        r.target_e2 = target_e2;
        r.opened_at = now;
        r.close_at = now + s.round_secs as i64;
        r.trade_until = r.close_at - s.settle_window_secs as i64;
        r.state = RoundState::Live as u8;
        let next = &mut ctx.accounts.next_round;
        next.series = s.key();
        next.index = next_index;
        next.state = RoundState::Presale as u8;
        next.bump = ctx.bumps.next_round;
        s.live_round = r.index;
        s.presale_round = next_index;
        emit!(Opened { round: r.key(), index: r.index, target_e2, m_up: r.m_up, m_down: r.m_down, shares: total, close_at: r.close_at, trade_until: r.trade_until, next_round: next.key() });
        Ok(())
    }

    /// Live trading: spend `amount` on a side. Shares come from the pari-
    /// mutuel curve; `min_shares` guards against a worse fill.
    pub fn buy(ctx: Context<Buy>, side: u8, amount: u64, min_shares: u64) -> Result<()> {
        let side = Side::try_from(side)?;
        require!(amount > 0, RoundsError::ZeroAmount);
        let s = &mut ctx.accounts.series;
        let r = &mut ctx.accounts.round;
        require!(!s.paused, RoundsError::Paused);
        require!(r.state == RoundState::Live as u8 && r.index == s.live_round, RoundsError::NotLive);
        let now = Clock::get()?.unix_timestamp;
        require!(now < r.trade_until, RoundsError::TradingClosed);
        let (fee, finder, platform, net) = fee_split(amount, s.fee_bps, s.finder_bps);
        require!(net > 0, RoundsError::ZeroAmount);
        let (m_side, n_other) = match side { Side::Up => (r.m_up, r.n_down), Side::Down => (r.m_down, r.n_up) };
        let shares = shares_for_spend(n_other, m_side, net).map_err(RoundsError::from)?;
        require!(shares > 0, RoundsError::ZeroAmount);
        require!(shares >= min_shares, RoundsError::Slippage);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer { from: ctx.accounts.holder_usdg.to_account_info(), to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.holder.to_account_info() },
            ),
            amount,
        )?;
        s.finder_fees = s.finder_fees.checked_add(finder).ok_or(RoundsError::Overflow)?;
        s.platform_fees = s.platform_fees.checked_add(platform).ok_or(RoundsError::Overflow)?;
        let p = &mut ctx.accounts.position;
        init_position(p, r.key(), ctx.accounts.holder.key(), ctx.bumps.position);
        match side {
            Side::Up => {
                r.m_up = r.m_up.checked_add(net).ok_or(RoundsError::Overflow)?;
                r.n_up = r.n_up.checked_add(shares).ok_or(RoundsError::Overflow)?;
                p.stake_up = p.stake_up.checked_add(net).ok_or(RoundsError::Overflow)?;
                p.shares_up = p.shares_up.checked_add(shares).ok_or(RoundsError::Overflow)?;
            }
            Side::Down => {
                r.m_down = r.m_down.checked_add(net).ok_or(RoundsError::Overflow)?;
                r.n_down = r.n_down.checked_add(shares).ok_or(RoundsError::Overflow)?;
                p.stake_down = p.stake_down.checked_add(net).ok_or(RoundsError::Overflow)?;
                p.shares_down = p.shares_down.checked_add(shares).ok_or(RoundsError::Overflow)?;
            }
        }
        emit!(Bought { round: r.key(), holder: ctx.accounts.holder.key(), side: side as u8, amount, fee, net, shares, m_up: r.m_up, m_down: r.m_down, n_up: r.n_up, n_down: r.n_down });
        Ok(())
    }

    /// Settles the live round from the VI averaged over the final window.
    /// The winner follows from the numbers: UP if the reading is at or
    /// above the target. `commitment` is reserved for a hash of the oracle
    /// inputs (zeros until that ships).
    pub fn settle(ctx: Context<Settle>, settle_e2: u64, commitment: [u8; 32]) -> Result<()> {
        let s = &mut ctx.accounts.series;
        let r = &mut ctx.accounts.round;
        require!(r.state == RoundState::Live as u8 && r.index == s.live_round, RoundsError::NotLive);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= r.close_at, RoundsError::TooEarly);
        let winner = if settle_e2 >= r.target_e2 { Side::Up } else { Side::Down };
        r.state = RoundState::Settled as u8;
        r.winner = winner as u8;
        r.settle_e2 = settle_e2;
        r.commitment = commitment;
        s.live_round = 0;
        emit!(Settled { round: r.key(), index: r.index, winner: winner as u8, settle_e2, target_e2: r.target_e2 });
        Ok(())
    }

    /// Voids a round. A live round past its close with no VI prints to
    /// settle on: everyone gets their net stakes back and the series goes
    /// on. A presale round while the series is paused: refunds, and the
    /// series ends (no presale round remains).
    pub fn void_round(ctx: Context<Settle>) -> Result<()> {
        let s = &mut ctx.accounts.series;
        let r = &mut ctx.accounts.round;
        let now = Clock::get()?.unix_timestamp;
        if r.state == RoundState::Live as u8 {
            require!(r.index == s.live_round, RoundsError::BadRound);
            require!(now >= r.close_at, RoundsError::TooEarly);
            s.live_round = 0;
        } else if r.state == RoundState::Presale as u8 {
            require!(r.index == s.presale_round, RoundsError::BadRound);
            require!(s.paused, RoundsError::NotPaused);
            s.presale_round = 0;
        } else {
            return err!(RoundsError::BadRound);
        }
        r.state = RoundState::Void as u8;
        emit!(Voided { round: r.key(), index: r.index });
        Ok(())
    }

    /// Pays a settled round's position (or refunds a void one) and closes
    /// the position account, returning its rent.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let round_key = ctx.accounts.round.key();
        let r = &mut ctx.accounts.round;
        let p = &ctx.accounts.position;
        let amount = due(r, round_key, p)?;
        if amount > 0 {
            r.paid_out = r.paid_out.checked_add(amount).ok_or(RoundsError::Overflow)?;
            vault_transfer(&ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.holder_usdg, &ctx.accounts.series, amount)?;
        }
        emit!(Claimed { round: r.key(), holder: ctx.accounts.holder.key(), amount, rolled: false });
        Ok(())
    }

    /// Like `claim`, but the payout stays in the vault as a presale commit
    /// on the winning side of the series' current presale round.
    pub fn claim_rollover(ctx: Context<ClaimRollover>) -> Result<()> {
        let s = &mut ctx.accounts.series;
        let r = &mut ctx.accounts.round;
        let next = &mut ctx.accounts.next_round;
        require!(r.state == RoundState::Settled as u8, RoundsError::NotSettled);
        require!(!s.paused, RoundsError::Paused);
        require!(next.state == RoundState::Presale as u8 && next.index == s.presale_round, RoundsError::NotPresale);
        let round_key = r.key();
        let amount = due(r, round_key, &ctx.accounts.position)?;
        require!(amount > 0, RoundsError::NothingToClaim);
        let (fee, finder, platform, net) = fee_split(amount, s.fee_bps, s.finder_bps);
        require!(net > 0, RoundsError::ZeroAmount);
        r.paid_out = r.paid_out.checked_add(amount).ok_or(RoundsError::Overflow)?;
        s.finder_fees = s.finder_fees.checked_add(finder).ok_or(RoundsError::Overflow)?;
        s.platform_fees = s.platform_fees.checked_add(platform).ok_or(RoundsError::Overflow)?;
        let np = &mut ctx.accounts.next_position;
        init_position(np, next.key(), ctx.accounts.holder.key(), ctx.bumps.next_position);
        if r.winner == Side::Up as u8 {
            next.presale_up = next.presale_up.checked_add(net).ok_or(RoundsError::Overflow)?;
            np.presale_up = np.presale_up.checked_add(net).ok_or(RoundsError::Overflow)?;
        } else {
            next.presale_down = next.presale_down.checked_add(net).ok_or(RoundsError::Overflow)?;
            np.presale_down = np.presale_down.checked_add(net).ok_or(RoundsError::Overflow)?;
        }
        emit!(Claimed { round: r.key(), holder: ctx.accounts.holder.key(), amount, rolled: true });
        emit!(Committed { round: next.key(), holder: ctx.accounts.holder.key(), side: r.winner, amount, fee, net, presale_up: next.presale_up, presale_down: next.presale_down });
        Ok(())
    }

    /// Pays accrued fees: the finder's counter to the finder, the
    /// platform's to the treasury, whichever of the two is signing (both
    /// if one key holds both roles).
    pub fn withdraw_fees(ctx: Context<WithdrawFees>) -> Result<()> {
        let s = &mut ctx.accounts.series;
        let signer = ctx.accounts.signer.key();
        let mut finder = 0u64;
        let mut platform = 0u64;
        if signer == s.finder {
            finder = std::mem::take(&mut s.finder_fees);
        }
        if signer == ctx.accounts.config.treasury {
            platform = std::mem::take(&mut s.platform_fees);
        }
        require!(finder > 0 || platform > 0, RoundsError::NothingToClaim);
        let total = finder.checked_add(platform).ok_or(RoundsError::Overflow)?;
        vault_transfer(&ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.to, s, total)?;
        emit!(FeesWithdrawn { series: s.key(), to: signer, finder, platform });
        Ok(())
    }
}

// -------------------------------------------------------------- helpers

/// What a position is owed once its round is settled or void.
fn due(r: &Round, round_key: Pubkey, p: &Position) -> Result<u64> {
    require!(p.round == round_key, RoundsError::BadRound);
    let total_presale = r.presale_up.checked_add(r.presale_down).ok_or(RoundsError::Overflow)?;
    if r.state == RoundState::Void as u8 {
        let refund = p.presale_up as u128 + p.presale_down as u128 + p.stake_up as u128 + p.stake_down as u128;
        return u64::try_from(refund).map_err(|_| error!(RoundsError::Overflow));
    }
    require!(r.state == RoundState::Settled as u8, RoundsError::NotSettled);
    let (stake, shares, m_lose, n_win) = if r.winner == Side::Up as u8 {
        (p.presale_up.checked_add(p.stake_up), presale_shares(p.presale_up, r.presale_up, total_presale).checked_add(p.shares_up), r.m_down, r.n_up)
    } else {
        (p.presale_down.checked_add(p.stake_down), presale_shares(p.presale_down, r.presale_down, total_presale).checked_add(p.shares_down), r.m_up, r.n_down)
    };
    let stake = stake.ok_or(RoundsError::Overflow)?;
    let shares = shares.ok_or(RoundsError::Overflow)?;
    payout(stake, shares, m_lose, n_win).map_err(|e| error!(RoundsError::from(e)))
}

fn init_position(p: &mut Position, round: Pubkey, holder: Pubkey, bump: u8) {
    if p.holder == Pubkey::default() {
        p.holder = holder;
        p.round = round;
        p.bump = bump;
    }
}

fn vault_transfer<'info>(token_program: &Program<'info, Token>, vault: &Account<'info, TokenAccount>, to: &Account<'info, TokenAccount>, series: &Account<'info, Series>, amount: u64) -> Result<()> {
    let seeds: &[&[u8]] = &[b"series", &series.reference, &[series.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer { from: vault.to_account_info(), to: to.to_account_info(), authority: series.to_account_info() },
            &[seeds],
        ),
        amount,
    )
}

// ------------------------------------------------------------- accounts

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RoundState { None = 0, Presale = 1, Live = 2, Settled = 3, Void = 4 }

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Side { Up = 0, Down = 1 }

impl Side {
    fn try_from(v: u8) -> Result<Side> {
        match v { 0 => Ok(Side::Up), 1 => Ok(Side::Down), _ => err!(RoundsError::BadSide) }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub keeper: Pubkey,
    pub treasury: Pubkey,
    pub usdg_mint: Pubkey,
    pub fee_bps: u16,
    pub finder_bps: u16,
    pub series_count: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Series {
    pub finder: Pubkey,          // offset 8
    pub reference: [u8; 32],     // offset 40: ATNX market uuid plus flags, set off chain
    pub index: u64,
    pub round_secs: u32,
    pub settle_window_secs: u32,
    pub fee_bps: u16,
    pub finder_bps: u16,
    pub ante: u64,
    pub paused: bool,
    pub live_round: u32,         // 0 = none
    pub presale_round: u32,      // 0 = none (series ended)
    pub finder_fees: u64,
    pub platform_fees: u64,
    pub vault_bump: u8,
    pub bump: u8,
    pub _reserved: [u8; 64],
}

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub series: Pubkey,          // offset 8
    pub index: u32,
    pub state: u8,
    pub winner: u8,
    pub presale_up: u64,         // net commits, fixed at open (U)
    pub presale_down: u64,       // D
    pub m_up: u64,
    pub m_down: u64,
    pub n_up: u64,
    pub n_down: u64,
    pub opened_at: i64,
    pub close_at: i64,
    pub trade_until: i64,
    pub target_e2: u64,
    pub settle_e2: u64,
    pub commitment: [u8; 32],
    pub paid_out: u64,
    pub bump: u8,
    pub _reserved: [u8; 64],
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub holder: Pubkey,          // offset 8
    pub round: Pubkey,           // offset 40
    pub presale_up: u64,
    pub presale_down: u64,
    pub stake_up: u64,
    pub stake_down: u64,
    pub shares_up: u64,
    pub shares_down: u64,
    pub bump: u8,
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
pub struct SetConfig<'info> {
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
pub struct CreateSeries<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = keeper, has_one = usdg_mint)]
    pub config: Account<'info, Config>,
    #[account(init, payer = keeper, space = 8 + Series::INIT_SPACE, seeds = [b"series", reference.as_ref()], bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(init, payer = keeper, token::mint = usdg_mint, token::authority = series, seeds = [b"vault", series.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(init, payer = keeper, space = 8 + Round::INIT_SPACE, seeds = [b"round", series.key().as_ref(), &1u32.to_le_bytes()], bump)]
    pub round: Box<Account<'info, Round>>,
    pub usdg_mint: Account<'info, Mint>,
    #[account(mut)]
    pub keeper: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SetSeries<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"series", series.reference.as_ref()], bump = series.bump)]
    pub series: Account<'info, Series>,
    #[account(constraint = signer.key() == config.authority || signer.key() == config.keeper @ RoundsError::Unauthorized)]
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct Commit<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"series", series.reference.as_ref()], bump = series.bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [b"round", series.key().as_ref(), &round.index.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [b"vault", series.key().as_ref()], bump = series.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = holder, space = 8 + Position::INIT_SPACE, seeds = [b"pos", round.key().as_ref(), holder.key().as_ref()], bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, token::mint = config.usdg_mint, token::authority = holder)]
    pub holder_usdg: Account<'info, TokenAccount>,
    #[account(mut)]
    pub holder: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(target_e2: u64, next_index: u32)]
pub struct OpenRound<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = keeper)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"series", series.reference.as_ref()], bump = series.bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [b"round", series.key().as_ref(), &round.index.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(init, payer = keeper, space = 8 + Round::INIT_SPACE, seeds = [b"round", series.key().as_ref(), &next_index.to_le_bytes()], bump)]
    pub next_round: Box<Account<'info, Round>>,
    #[account(mut)]
    pub keeper: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"series", series.reference.as_ref()], bump = series.bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [b"round", series.key().as_ref(), &round.index.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [b"vault", series.key().as_ref()], bump = series.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = holder, space = 8 + Position::INIT_SPACE, seeds = [b"pos", round.key().as_ref(), holder.key().as_ref()], bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, token::mint = config.usdg_mint, token::authority = holder)]
    pub holder_usdg: Account<'info, TokenAccount>,
    #[account(mut)]
    pub holder: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Also used by `void_round`.
#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = keeper)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"series", series.reference.as_ref()], bump = series.bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [b"round", series.key().as_ref(), &round.index.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    pub keeper: Signer<'info>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"series", series.reference.as_ref()], bump = series.bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [b"round", series.key().as_ref(), &round.index.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [b"vault", series.key().as_ref()], bump = series.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, close = holder, seeds = [b"pos", round.key().as_ref(), holder.key().as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, token::mint = config.usdg_mint, token::authority = holder)]
    pub holder_usdg: Account<'info, TokenAccount>,
    #[account(mut)]
    pub holder: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimRollover<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"series", series.reference.as_ref()], bump = series.bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [b"round", series.key().as_ref(), &round.index.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [b"round", series.key().as_ref(), &next_round.index.to_le_bytes()], bump = next_round.bump)]
    pub next_round: Box<Account<'info, Round>>,
    #[account(mut, close = holder, seeds = [b"pos", round.key().as_ref(), holder.key().as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(init_if_needed, payer = holder, space = 8 + Position::INIT_SPACE, seeds = [b"pos", next_round.key().as_ref(), holder.key().as_ref()], bump)]
    pub next_position: Box<Account<'info, Position>>,
    #[account(mut)]
    pub holder: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"series", series.reference.as_ref()], bump = series.bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [b"vault", series.key().as_ref()], bump = series.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.usdg_mint, token::authority = signer)]
    pub to: Account<'info, TokenAccount>,
    pub signer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// --------------------------------------------------------------- events

#[event]
pub struct SeriesCreated { pub series: Pubkey, pub reference: [u8; 32], pub finder: Pubkey, pub round_secs: u32, pub settle_window_secs: u32 }
#[event]
pub struct Committed { pub round: Pubkey, pub holder: Pubkey, pub side: u8, pub amount: u64, pub fee: u64, pub net: u64, pub presale_up: u64, pub presale_down: u64 }
#[event]
pub struct Opened { pub round: Pubkey, pub index: u32, pub target_e2: u64, pub m_up: u64, pub m_down: u64, pub shares: u64, pub close_at: i64, pub trade_until: i64, pub next_round: Pubkey }
#[event]
pub struct Bought { pub round: Pubkey, pub holder: Pubkey, pub side: u8, pub amount: u64, pub fee: u64, pub net: u64, pub shares: u64, pub m_up: u64, pub m_down: u64, pub n_up: u64, pub n_down: u64 }
#[event]
pub struct Settled { pub round: Pubkey, pub index: u32, pub winner: u8, pub settle_e2: u64, pub target_e2: u64 }
#[event]
pub struct Voided { pub round: Pubkey, pub index: u32 }
#[event]
pub struct Claimed { pub round: Pubkey, pub holder: Pubkey, pub amount: u64, pub rolled: bool }
#[event]
pub struct FeesWithdrawn { pub series: Pubkey, pub to: Pubkey, pub finder: u64, pub platform: u64 }

#[error_code]
pub enum RoundsError {
    #[msg("fee above the cap")] FeeTooHigh,
    #[msg("mint above the per-call cap")] MintTooLarge,
    #[msg("side must be 0 (UP) or 1 (DOWN)")] BadSide,
    #[msg("amount is zero")] ZeroAmount,
    #[msg("settlement window must be shorter than the round, round at least 20 s")] BadWindow,
    #[msg("round index or state does not fit this call")] BadRound,
    #[msg("round is not the series' presale round")] NotPresale,
    #[msg("round is not the series' live round")] NotLive,
    #[msg("round is not settled")] NotSettled,
    #[msg("trading closed for the settlement window")] TradingClosed,
    #[msg("round has not reached its close")] TooEarly,
    #[msg("series is paused")] Paused,
    #[msg("series is not paused")] NotPaused,
    #[msg("a live round already exists")] LiveRoundExists,
    #[msg("both sides need money before a round can open")] EmptySide,
    #[msg("fewer shares than the minimum you set")] Slippage,
    #[msg("a single buy may not exceed 1000x the money on its side")] RatioTooLarge,
    #[msg("arithmetic overflow")] Overflow,
    #[msg("nothing to claim")] NothingToClaim,
    #[msg("not the authority or the keeper")] Unauthorized,
}

impl From<MathError> for RoundsError {
    fn from(e: MathError) -> Self {
        match e {
            MathError::Overflow => RoundsError::Overflow,
            MathError::RatioTooLarge => RoundsError::RatioTooLarge,
            MathError::ZeroPool => RoundsError::EmptySide,
        }
    }
}
