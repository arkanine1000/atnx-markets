// Scores terms through the real sources and prints the breakdown.
//   npm run vi:probe -- "iPhone Duo" "Taylor Swift|iPhone Fold|foldable iPhone"
// Aliases follow the name after "|".
import { scoreTerms } from '../lib/signals';
import { viTier } from '../lib/vi/score';

const args = process.argv.slice(2);
const queries = args.map((a) => { const [term, ...aliases] = a.split('|').map((s) => s.trim()); return { term, aliases }; });
const terms = queries.map((q) => q.term);
if (queries.length === 0) {
  console.error('usage: npx tsx scripts/vi-probe.ts <term> [term...]');
  process.exit(1);
}

(async () => {
  const t0 = Date.now();
  const results = await scoreTerms(queries, 'all');
  results.forEach((r, i) => {
    const c = r.composite;
    console.log(`\n${terms[i]}  →  VI ${r.score ?? 'n/a'}${c ? `  (${viTier(c.score).label}; level ${c.level}, momentum ${c.momentum}, A ${c.attention.toExponential(2)}, top ${c.topSource ?? '-'} ${Math.round((c.topSource ? c.shares[c.topSource] ?? 0 : 0) * 100)}% of ${c.sourcesPresent.join('+') || 'nothing'})` : ''}`);
    for (const comp of Object.values(r.components)) {
      if (!comp) continue;
      const mom = comp.momentum === null ? '—' : `${comp.momentum.toFixed(2)}x`;
      const meta = comp.meta ? ' ' + Object.entries(comp.meta).map(([k, v]) => `${k}=${v}`).join(' ') : '';
      console.log(`  ${comp.source.padEnd(10)} level=${comp.level ?? '—'}  momentum=${mom}${meta}`);
    }
  });
  console.log(`\n${Date.now() - t0} ms`);
})();
