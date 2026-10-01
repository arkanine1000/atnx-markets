// Solana devnet operations for the Anchor program (programs/bounded_vi):
//
//   npm run bm:sol -- init            one-time: config PDA + mock USDG mint
//   npm run bm:sol -- e2e             faucet, open a market, buy, sell, resolve, redeem, sweep
//
// Payer/authority is ~/.config/solana/devnet.json (SOL_PAYER overrides).
// The IDL is programs/bounded_vi.idl.json, written by programs/deploy.sh.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import * as anchor from '@coral-xyz/anchor';
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const ROOT = resolve(__dirname, '..', '..');
const IDL = JSON.parse(readFileSync(resolve(ROOT, 'programs/bounded_vi.idl.json'), 'utf8'));
const PAYER = process.env.SOL_PAYER ?? `${homedir()}/.config/solana/devnet.json`;
const USDG = 1_000_000n;

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
}

function assert(c: unknown, m: string) {
  if (!c) throw new Error(`assertion failed: ${m}`);
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

  if (cmd === 'init') {
    const mint = Keypair.generate();
    const sig = await methods
      .initialize(100)
      .accounts({ config, usdgMint: mint.publicKey, authority: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY })
      .signers([mint])
      .rpc();
    console.log(`initialized: mint ${mint.publicKey.toBase58()} tx ${sig}`);
    console.log(`NEXT_PUBLIC_BM_SOL_PROGRAM=${programId.toBase58()}`);
    console.log(`NEXT_PUBLIC_BM_SOL_USDG=${mint.publicKey.toBase58()}`);
    return;
  }

  const cfg = await accounts.config.fetch(config);
  const mint: PublicKey = cfg.usdgMint;
  const ata = getAssociatedTokenAddressSync(mint, payer.publicKey);
  await provider.sendAndConfirm(
    new anchor.web3.Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, payer.publicKey, mint)),
  );
  const bal = async () => BigInt((await connection.getTokenAccountBalance(ata)).value.amount);

  // faucet
  const before = await bal();
  await methods.faucet(new anchor.BN(2_000n * USDG)).accounts({ config, usdgMint: mint, to: ata, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
  assert((await bal()) - before === 2_000n * USDG, 'faucet minted 2,000');
  console.log('  faucet ok');

  // create market: VI 100 -> bounds 20/500
  const reference = Buffer.alloc(32);
  reference.write(`e2e-${Date.now()}`);
  const [market] = PublicKey.findProgramAddressSync([Buffer.from('market'), reference], programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault'), market.toBuffer()], programId);
  const [creatorPos] = PublicKey.findProgramAddressSync([Buffer.from('pos'), market.toBuffer(), payer.publicKey.toBuffer()], programId);
  await methods
    .createMarket([...reference], new anchor.BN(10_000), new anchor.BN(2_000), new anchor.BN(50_000), new anchor.BN(1_000n * USDG), 5000)
    .accounts({ config, market, vault, creatorPosition: creatorPos, usdgMint: mint, operatorUsdg: ata, operator: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY })
    .rpc();
  let m = await accounts.market.fetch(market);
  assert(BigInt(m.poolUp.toString()) === 1_000n * USDG && BigInt(m.poolDown.toString()) === 1_000n * USDG, 'pools 50/50');
  console.log(`  market ${market.toBase58()} open (#${m.id})`);

  const trade = { config, market, vault, position: creatorPos, traderUsdg: ata, trader: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId };
  // buy UP 100 (expect the EVM vector: 189.081892 shares)
  await methods.buy(0, new anchor.BN(100n * USDG), new anchor.BN(0)).accounts(trade).rpc();
  let pos = await accounts.position.fetch(creatorPos);
  assert(BigInt(pos.up.toString()) === 189_081_892n, `buy matches the Foundry vector (${pos.up})`);
  console.log('  buy UP 100 ok, 189.081892 UP');
  // sell half
  const half = BigInt(pos.up.toString()) / 2n;
  const b1 = await bal();
  await methods.sell(0, new anchor.BN(half), new anchor.BN(0)).accounts(trade).rpc();
  assert((await bal()) > b1, 'sell paid out');
  console.log('  sell half ok');
  // buy DOWN 20, resolve UP, redeem, sweep
  await methods.buy(1, new anchor.BN(20n * USDG), new anchor.BN(0)).accounts(trade).rpc();
  await methods.resolve(0, new anchor.BN(50_000)).accounts({ config, market, oracle: payer.publicKey }).rpc();
  pos = await accounts.position.fetch(creatorPos);
  const win = BigInt(pos.up.toString());
  const b2 = await bal();
  await methods.redeem().accounts(trade).rpc();
  assert((await bal()) - b2 === win, 'redeem paid 1:1');
  await methods.sweep().accounts({ config, market, vault, recipientUsdg: ata, authority: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
  m = await accounts.market.fetch(market);
  assert(BigInt(m.collateral.toString()) === 0n, 'collateral paid out');
  console.log(`  resolved UP, redeemed ${Number(win) / 1e6} USDG, swept`);
  console.log(`e2e OK on Solana devnet: https://explorer.solana.com/address/${market.toBase58()}?cluster=devnet`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
