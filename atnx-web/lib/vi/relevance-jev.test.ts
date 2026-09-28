// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareKeeps } from './relevance-jev';

test('compareKeeps counts agreements and lists each side\'s extras in order', () => {
  const all = ['a', 'b', 'c', 'd', 'e'];
  const r = compareKeeps(all, ['a', 'b', 'c'], ['a', 'c', 'e']);
  assert.equal(r.agree, 3, 'a and c kept by both, d dropped by both');
  assert.deepEqual(r.aOnly, ['b']);
  assert.deepEqual(r.bOnly, ['e']);
  assert.deepEqual(compareKeeps(all, all, all), { agree: 5, aOnly: [], bOnly: [] });
  assert.deepEqual(compareKeeps(all, [], all), { agree: 0, aOnly: [], bOnly: all });
});
