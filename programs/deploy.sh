#!/usr/bin/env bash
# Downloads the latest successful GitHub Actions build of one program and
# deploys it to devnet with the committed program keypair.
#
#   programs/deploy.sh                       bounded_vi, ~/.config/solana/devnet.json pays
#   programs/deploy.sh vi_rounds             vi_rounds
#   programs/deploy.sh vi_rounds --dry       download and copy the IDL, skip the deploy
#   PAYER=~/.config/solana/x.json programs/deploy.sh vi_rounds
#
# The artifact is the one named after the program (see
# .github/workflows/solana-build.yml); the keypair is keys/<name>-keypair.json.
# The IDL is copied to programs/<name>.idl.json; for vi_rounds the IDL and
# the TS types also go to atnx-web/lib/bm/idl/.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

NAME=bounded_vi
DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry) DRY=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) NAME=$arg ;;
  esac
done

KEYPAIR=keys/$NAME-keypair.json
[[ -f "$KEYPAIR" ]] || { echo "no keypair at $KEYPAIR" >&2; exit 1; }

PAYER=${PAYER:-$HOME/.config/solana/devnet.json}
OUT=programs/artifact/$NAME
rm -rf "$OUT" && mkdir -p "$OUT"
RID=$(gh run list --repo arkanine1000/atnx-markets --workflow solana-build --status success --limit 1 --json databaseId --jq '.[0].databaseId')
echo "artifact $NAME from run $RID"
gh run download --repo arkanine1000/atnx-markets "$RID" --name "$NAME" --dir "$OUT"
find "$OUT" -type f | sed 's/^/  /'
SO=$(find "$OUT" -name "$NAME.so" | head -1)
IDL=$(find "$OUT" -name "$NAME.json" | head -1)
TYPES=$(find "$OUT" -name "$NAME.ts" | head -1)
[[ -n "$SO" && -n "$IDL" ]] || { echo "artifact is missing $NAME.so or $NAME.json" >&2; exit 1; }
PID=$(solana-keygen pubkey "$KEYPAIR")

if [[ $DRY == 1 ]]; then
  echo "dry run: skipping deploy of $SO to $PID"
else
  echo "program id $PID; payer $(solana-keygen pubkey "$PAYER") balance $(solana balance -k "$PAYER" -u devnet)"
  solana program deploy "$SO" --program-id "$KEYPAIR" -k "$PAYER" -u devnet --with-compute-unit-price 1000
fi

cp "$IDL" "programs/$NAME.idl.json"
echo "IDL -> programs/$NAME.idl.json"
if [[ $NAME == vi_rounds ]]; then
  WEB=atnx-web/lib/bm/idl
  mkdir -p "$WEB"
  cp "$IDL" "$WEB/vi_rounds.json"
  [[ -n "$TYPES" ]] || { echo "artifact is missing vi_rounds.ts" >&2; exit 1; }
  cp "$TYPES" "$WEB/vi_rounds.ts"
  echo "IDL + types -> $WEB/vi_rounds.{json,ts}"
fi

echo "explorer: https://explorer.solana.com/address/$PID?cluster=devnet"
