// Scores terms through the real sources and prints the breakdown.
//   npx tsx scripts/vi-probe.ts "iPhone Duo" "Taylor Swift" "The"
import { scoreTerms } from '../lib/signals';
import { viTier } from '../lib/vi/score';

const terms = process.argv.slice(2);
if (terms.length === 0) {
  console.error('usage: npx tsx scripts/vi-probe.ts <term> [term...]');
  process.exit(1);
}

(async () => {
  const t0 = Date.now();
  const results = await scoreTerms(terms.map((term) => ({ term })), 'all');
  results.forEach((r, i) => {
    const c = r.composite;
    console.log(`\n${terms[i]}  →  VI ${r.score ?? 'n/a'}${c ? `  (${viTier(c.score).label}; level ${c.level}, momentum ${c.momentum}, ×${c.multiplier} from ${c.sourcesPresent.join('+') || 'nothing'})` : ''}`);
    for (const comp of Object.values(r.components)) {
      if (!comp) continue;
      const mom = comp.momentum === null ? '—' : `${comp.momentum.toFixed(2)}x`;
      const meta = comp.meta ? ' ' + Object.entries(comp.meta).map(([k, v]) => `${k}=${v}`).join(' ') : '';
      console.log(`  ${comp.source.padEnd(10)} level=${comp.level ?? '—'}  momentum=${mom}${meta}`);
    }
  });
  console.log(`\n${Date.now() - t0} ms`);
})();
