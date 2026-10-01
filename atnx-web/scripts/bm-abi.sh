#!/usr/bin/env bash
# Regenerates lib/bm/abi.ts from the Foundry build.
set -euo pipefail
cd "$(dirname "$0")/../../contracts"
forge build >/dev/null
node - <<'JS'
const { execSync } = require('child_process');
const fs = require('fs');
const abi = (name) => JSON.stringify(JSON.parse(execSync(`forge inspect ${name} abi --json`).toString()), null, 2);
const out = `// Generated from contracts/ with scripts/bm-abi.sh (forge inspect <Contract> abi --json).
// Regenerate after any contract change.

export const boundedViMarketsAbi = ${abi('BoundedVIMarkets')} as const;

export const mockUsdgAbi = ${abi('MockUSDG')} as const;
`;
fs.writeFileSync('../atnx-web/lib/bm/abi.ts', out);
console.log('wrote atnx-web/lib/bm/abi.ts');
JS
