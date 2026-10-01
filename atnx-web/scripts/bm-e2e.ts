// End-to-end check of a deployed chain with the tester wallet: mint mock
// USDG, open a market straight on the contract (as the keeper, since the
// tester is not an operator), buy UP, sell half, buy DOWN, resolve as the
// oracle, redeem, sweep. Every step asserts the contract's accounting.
// Leaves one resolved market behind, which the demo script uses.
//
//   npm run bm:e2e -- eip155:46630
//
// Reads BM_KEEPER_PRIVATE_KEY from .env.local and the tester key from
// ~/.foundry/atnx-tester.json (BM_TESTER_PRIVATE_KEY overrides).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createWalletClient, http, parseEventLogs, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { boundedViMarketsAbi, mockUsdgAbi } from '../lib/bm/abi';
import { BM_CHAINS, USDG_UNIT, chainByKey, isDeployed } from '../lib/bm/chains';
import { bounds, toE2 } from '../lib/bm/bounds';
import { quoteBuy, quoteSell } from '../lib/bm/fpmm';
import { publicClientFor, keeperAccount, walletClientFor } from '../lib/bm/evm';

const key = process.argv[2] ?? process.env.NEXT_PUBLIC_BM_DEFAULT_CHAIN ?? 'eip155:46630';
const chain = chainByKey(key);
if (!chain || !isDeployed(chain)) {
  console.error(`chain ${key} is not deployed; known: ${Object.keys(BM_CHAINS).join(', ')}`);
  process.exit(2);
}

function testerKey(): Hex {
  if (process.env.BM_TESTER_PRIVATE_KEY) return process.env.BM_TESTER_PRIVATE_KEY as Hex;
  const j = JSON.parse(readFileSync(`${homedir()}/.foundry/atnx-tester.json`, 'utf8'));
  return j.data[0].private_key as Hex;
}

const pc = publicClientFor(chain);
const keeper = walletClientFor(chain);
const tester = privateKeyToAccount(testerKey());
const testerWallet = createWalletClient({ account: tester, chain: chain.viemChain, transport: http(chain.rpcUrl) });

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function send(label: string, who: typeof keeper, req: Parameters<typeof keeper.writeContract>[0]) {
  const hash = await who.writeContract(req);
  const receipt = await pc.waitForTransactionReceipt({ hash, timeout: 90_000 });
  assert(receipt.status === 'success', `${label} reverted (${hash})`);
  console.log(`  ${label}: ${chain.explorer}/tx/${hash}`);
  return receipt;
}

async function market(id: bigint) {
  return pc.readContract({ address: chain.markets, abi: boundedViMarketsAbi, functionName: 'getMarket', args: [id] });
}

async function main() {
  console.log(`e2e on ${chain.label}: keeper ${keeperAccount().address}, tester ${tester.address}`);
  const [kGas, tGas] = await Promise.all([pc.getBalance({ address: keeperAccount().address }), pc.getBalance({ address: tester.address })]);
  console.log(`  gas: keeper ${Number(kGas) / 1e18} ETH, tester ${Number(tGas) / 1e18} ETH`);
  assert(kGas > 0n && tGas > 0n, 'both wallets need testnet ETH');

  // 1. tester mints USDG
  const usdgBefore = await pc.readContract({ address: chain.usdg, abi: mockUsdgAbi, functionName: 'balanceOf', args: [tester.address] });
  await send('mint 1,000 USDG (tester)', testerWallet, { address: chain.usdg, abi: mockUsdgAbi, functionName: 'mint', args: [tester.address, 1_000n * USDG_UNIT], chain: chain.viemChain, account: tester });
  const usdgAfterMint = await pc.readContract({ address: chain.usdg, abi: mockUsdgAbi, functionName: 'balanceOf', args: [tester.address] });
  assert(usdgAfterMint - usdgBefore === 1_000n * USDG_UNIT, 'mint credited 1,000');

  // 2. keeper opens a throwaway market (VI 100 → bounds 20/500), seed 1,000
  const kBal = await pc.readContract({ address: chain.usdg, abi: mockUsdgAbi, functionName: 'balanceOf', args: [keeperAccount().address] });
  if (kBal < 1_000n * USDG_UNIT) {
    await send('mint 10,000 USDG (keeper)', keeper, { address: chain.usdg, abi: mockUsdgAbi, functionName: 'mint', args: [keeperAccount().address, 10_000n * USDG_UNIT], chain: chain.viemChain, account: keeperAccount() });
  }
  const allowance = await pc.readContract({ address: chain.usdg, abi: mockUsdgAbi, functionName: 'allowance', args: [keeperAccount().address, chain.markets] });
  if (allowance < 1_000n * USDG_UNIT) {
    await send('approve (keeper)', keeper, { address: chain.usdg, abi: mockUsdgAbi, functionName: 'approve', args: [chain.markets, 2n ** 256n - 1n], chain: chain.viemChain, account: keeperAccount() });
  }
  const b = bounds(100);
  const ref = `0x${'e2e'.padEnd(8, '0')}${Date.now().toString(16).padStart(56, '0')}` as Hex;
  const created = await send('createMarket (keeper)', keeper, {
    address: chain.markets, abi: boundedViMarketsAbi, functionName: 'createMarket',
    args: [ref, keeperAccount().address, toE2(100), toE2(b.lower), toE2(b.upper), 1_000n * USDG_UNIT, 5000],
    chain: chain.viemChain, account: keeperAccount(),
  });
  const id = parseEventLogs({ abi: boundedViMarketsAbi, logs: created.logs, eventName: 'MarketCreated' })[0].args.id;
  let m = await market(id);
  assert(m.poolUp === 1_000n * USDG_UNIT && m.poolDown === 1_000n * USDG_UNIT, 'pools seeded 50/50');
  console.log(`  market #${id} open, bounds ${b.lower}–${b.upper}`);

  // 3. tester approves and buys UP for 100
  await send('approve (tester)', testerWallet, { address: chain.usdg, abi: mockUsdgAbi, functionName: 'approve', args: [chain.markets, 2n ** 256n - 1n], chain: chain.viemChain, account: tester });
  const feeBps = BigInt(await pc.readContract({ address: chain.markets, abi: boundedViMarketsAbi, functionName: 'feeBps' }));
  const q = quoteBuy({ poolUp: m.poolUp, poolDown: m.poolDown }, 'up', 100n * USDG_UNIT, feeBps);
  const [qShares] = await pc.readContract({ address: chain.markets, abi: boundedViMarketsAbi, functionName: 'quoteBuy', args: [id, 0, 100n * USDG_UNIT] });
  assert(qShares === q.shares, `off-chain quote ${q.shares} == on-chain ${qShares}`);
  await send('buy UP 100', testerWallet, { address: chain.markets, abi: boundedViMarketsAbi, functionName: 'buy', args: [id, 0, 100n * USDG_UNIT, q.shares], chain: chain.viemChain, account: tester });
  let [up] = await pc.readContract({ address: chain.markets, abi: boundedViMarketsAbi, functionName: 'sharesOf', args: [id, tester.address] });
  assert(up === q.shares, 'received the quoted shares');
  m = await market(id);
  const priceUp = Number(m.poolDown) / (Number(m.poolUp) + Number(m.poolDown));
  console.log(`  UP now ${Math.round(priceUp * 100)}¢, holding ${Number(up) / 1e6} UP`);

  // 4. sell half
  const half = up / 2n;
  const sq = quoteSell({ poolUp: m.poolUp, poolDown: m.poolDown }, 'up', half, feeBps);
  const [qOut] = await pc.readContract({ address: chain.markets, abi: boundedViMarketsAbi, functionName: 'quoteSell', args: [id, 0, half] });
  assert(qOut === sq.payout, 'sell quote matches');
  const before = await pc.readContract({ address: chain.usdg, abi: mockUsdgAbi, functionName: 'balanceOf', args: [tester.address] });
  await send('sell half UP', testerWallet, { address: chain.markets, abi: boundedViMarketsAbi, functionName: 'sell', args: [id, 0, half, sq.payout], chain: chain.viemChain, account: tester });
  const after = await pc.readContract({ address: chain.usdg, abi: mockUsdgAbi, functionName: 'balanceOf', args: [tester.address] });
  assert(after - before === sq.payout, 'sell paid the quote');

  // 5. buy DOWN 20
  await send('buy DOWN 20', testerWallet, { address: chain.markets, abi: boundedViMarketsAbi, functionName: 'buy', args: [id, 1, 20n * USDG_UNIT, 0n], chain: chain.viemChain, account: tester });

  // 6. resolve UP as the oracle, redeem, sweep
  await send('resolve UP (oracle)', keeper, { address: chain.markets, abi: boundedViMarketsAbi, functionName: 'resolve', args: [id, 0, toE2(b.upper)], chain: chain.viemChain, account: keeperAccount() });
  [up] = await pc.readContract({ address: chain.markets, abi: boundedViMarketsAbi, functionName: 'sharesOf', args: [id, tester.address] });
  const beforeRedeem = await pc.readContract({ address: chain.usdg, abi: mockUsdgAbi, functionName: 'balanceOf', args: [tester.address] });
  await send('redeem (tester)', testerWallet, { address: chain.markets, abi: boundedViMarketsAbi, functionName: 'redeem', args: [id], chain: chain.viemChain, account: tester });
  const afterRedeem = await pc.readContract({ address: chain.usdg, abi: mockUsdgAbi, functionName: 'balanceOf', args: [tester.address] });
  assert(afterRedeem - beforeRedeem === up, 'redeem paid 1 USDG per UP share');
  await send('sweepPool (owner)', keeper, { address: chain.markets, abi: boundedViMarketsAbi, functionName: 'sweepPool', args: [id], chain: chain.viemChain, account: keeperAccount() });
  m = await market(id);
  assert(m.collateral === 0n, 'collateral fully paid out');
  console.log(`  resolved UP, redeemed ${Number(up) / 1e6} USDG, fees accrued ${Number(m.fees) / 1e6}`);
  console.log(`e2e OK on ${chain.label}: market #${id} is the resolved fixture (not in the registry).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
