#!/usr/bin/env bash
# Deploys MockUSDG and BoundedVIMarkets to one chain and prints the env
# lines the web app needs.
#
#   contracts/deploy.sh robinhood_testnet   (chain id 46630)
#   contracts/deploy.sh arbitrum_sepolia    (chain id 421614)
#
# The deployer key is read from ~/.foundry/atnx-keeper.json (cast wallet
# new --json) unless PRIVATE_KEY is already set. Verification is best
# effort: Blockscout for Robinhood, Arbiscan (ETHERSCAN_API_KEY) for Sepolia.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.foundry/bin:$PATH"
ALIAS=${1:?chain alias (robinhood_testnet | arbitrum_sepolia)}
case "$ALIAS" in
  robinhood_testnet) CHAIN_ID=46630 ;;
  arbitrum_sepolia) CHAIN_ID=421614 ;;
  *) echo "unknown chain alias $ALIAS" >&2; exit 2 ;;
esac
if [ -z "${PRIVATE_KEY:-}" ]; then
  PRIVATE_KEY=$(node -e "const j=require(process.env.HOME+'/.foundry/atnx-keeper.json'); process.stdout.write(j.data[0].private_key)")
  export PRIVATE_KEY
fi
EXTRA=()
if [ "$ALIAS" = "robinhood_testnet" ]; then
  EXTRA+=(--gas-estimate-multiplier 150)
fi
forge script script/Deploy.s.sol --rpc-url "$ALIAS" --broadcast --slow "${EXTRA[@]}" ${FORGE_EXTRA:-}
RUN="broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"
node - "$RUN" "$CHAIN_ID" <<'JS'
const [, , run, chainId] = process.argv;
const j = require(require('path').resolve(run));
const created = j.transactions.filter((t) => t.transactionType === 'CREATE');
const by = Object.fromEntries(created.map((t) => [t.contractName, t.contractAddress]));
const block = Math.min(...j.receipts.map((r) => parseInt(r.blockNumber, 16)));
console.log('');
console.log(`# chain ${chainId}`);
console.log(`NEXT_PUBLIC_BM_MARKETS_${chainId}=${by.BoundedVIMarkets}`);
console.log(`NEXT_PUBLIC_BM_USDG_${chainId}=${by.MockUSDG}`);
console.log(`NEXT_PUBLIC_BM_DEPLOY_BLOCK_${chainId}=${block}`);
JS
