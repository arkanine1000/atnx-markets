// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyVerdict, buildRelevancePrompt, filterRelevantTitles } from './relevance';

const ids = ['a', 'b', 'c', 'd'];

test('applyVerdict keeps the numbered titles in their original order', () => {
  assert.deepEqual(applyVerdict(ids, [3, 1]), ['a', 'c']);
  assert.deepEqual(applyVerdict(ids, []), []);
});

test('applyVerdict ignores numbers outside the list and keeps all on no verdict', () => {
  assert.deepEqual(applyVerdict(ids, [0, 2, 5, 99, -1]), ['b']);
  assert.deepEqual(applyVerdict(ids, [2.5, 2]), ['b']);
  assert.deepEqual(applyVerdict(ids, null), ids, 'fail-open');
});

test('the prompt names the subject, its aliases and category, and numbers the titles from 1', () => {
  const p = buildRelevancePrompt(
    { name: 'Trollface', aliases: ['troll face', ''], entityType: 'meme', category: 'memes' },
    [
      { id: 'x', title: 'Trollface origin  story' },
      { id: 'y', title: 'Best  memes compilation #trollface', channel: 'Meme  Hub' },
    ]
  );
  assert.match(p, /^Subject: Trollface$/m);
  assert.match(p, /^Also known as: troll face$/m);
  assert.match(p, /^Category: memes$/m);
  assert.match(p, /^1\. Trollface origin story$/m);
  assert.match(p, /^2\. Best memes compilation #trollface — by Meme Hub$/m);
});

test('the kill switch keeps every video without calling a model', async () => {
  const prev = process.env.YT_TITLE_FILTER;
  process.env.YT_TITLE_FILTER = '0';
  try {
    const r = await filterRelevantTitles({ name: 'Anything' }, [{ id: 'a', title: 't' }]);
    assert.deepEqual(r, { keep: ['a'], filteredOut: 0, status: 'off', dropped: [] });
  } finally {
    if (prev === undefined) delete process.env.YT_TITLE_FILTER;
    else process.env.YT_TITLE_FILTER = prev;
  }
});

test('no titles is an empty verdict, not a model call', async () => {
  const r = await filterRelevantTitles({ name: 'Anything' }, []);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.keep, []);
});
