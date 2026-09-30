// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tiktokAliases } from './signals';

test('tiktokAliases: when the bare name is dropped from the search, the bare name among the aliases goes too', () => {
  const aliases = ['Cars', 'Cars 1', 'Pixar Cars', 'Cars Movie'];
  assert.deepEqual(tiktokAliases('Cars', aliases, { term: 'Cars 1', aliases: ['Pixar Cars', 'Cars Movie'] }), ['Pixar Cars', 'Cars Movie']);
  assert.deepEqual(tiktokAliases('GTA VI', ['GTA 6', 'gta6'], { term: 'GTA VI', aliases: ['GTA 6', 'gta6'] }), ['GTA 6', 'gta6'], 'bare name searched: every alias stays');
});
