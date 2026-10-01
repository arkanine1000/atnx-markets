#!/usr/bin/env bash
# Downloads the latest successful GitHub Actions build of the program and
# deploys it to devnet with the committed program keypair.
#
#   programs/deploy.sh                 uses ~/.config/solana/devnet.json as payer
#   PAYER=~/.config/solana/x.json programs/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
PAYER=${PAYER:-$HOME/.config/solana/devnet.json}
OUT=programs/artifact
rm -rf "$OUT" && mkdir -p "$OUT"
RID=$(gh run list --repo arkanine1000/atnx-markets --workflow solana-build --status success --limit 1 --json databaseId --jq '.[0].databaseId')
echo "artifact from run $RID"
gh run download --repo arkanine1000/atnx-markets "$RID" --name bounded_vi --dir "$OUT"
find "$OUT" -type f | sed 's/^/  /'
SO=$(find "$OUT" -name bounded_vi.so | head -1)
IDL=$(find "$OUT" -name bounded_vi.json | head -1)
PID=$(solana-keygen pubkey programs/keys/bounded_vi-keypair.json)
echo "program id $PID; payer $(solana-keygen pubkey "$PAYER") balance $(solana balance -k "$PAYER" -u devnet)"
solana program deploy "$SO" --program-id programs/keys/bounded_vi-keypair.json -k "$PAYER" -u devnet --with-compute-unit-price 1000
cp "$IDL" programs/bounded_vi.idl.json
echo "deployed: https://explorer.solana.com/address/$PID?cluster=devnet"
