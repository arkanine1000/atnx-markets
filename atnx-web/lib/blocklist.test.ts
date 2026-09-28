// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGenericPhrase } from './blocklist';

test('calendar periods are generic phrases', () => {
  for (const n of ['November 2026', 'november 2026', 'Nov 2026', 'Nov. 2026', 'NOVEMBER  2026', 'Q4 2026', 'H1 2027', 'November 5, 2026', 'the 90s', '2026 November']) {
    assert.equal(isGenericPhrase(n), true, n);
  }
});

test('subjects that merely contain a month or a year are not', () => {
  // Bare years and weekdays are titles too: "1984", "2012", "1917", "Wednesday".
  for (const n of ['November Rain', 'Kirkiversary', 'iPhone Duo', '2026 World Cup', 'Halloween', 'May Calamawy', 'Blade Runner 2049', 'Cyberpunk 2077', 'GTA 6', 'Friday the 13th', 'Rebecca Black Friday', '1984', '2012', '1917', 'Wednesday', '2020s']) {
    assert.equal(isGenericPhrase(n), false, n);
  }
});
