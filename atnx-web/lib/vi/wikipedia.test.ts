// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeCandidate, type PageInfo } from './wikipedia';

const page = (o: Partial<PageInfo> & { requested: string; title: string }): PageInfo => ({
  source: o.requested,
  fragment: null,
  redirected: false,
  missing: false,
  disambiguation: false,
  ...o,
});

test('a section redirect under the name itself is scored on the redirect title', () => {
  const v = judgeCandidate('Big Chungus', page({ requested: 'Big Chungus', title: 'Wabbit Twouble', redirected: true, fragment: 'Big Chungus meme' }));
  assert.equal(v.title, null, 'the cartoon is not the meme');
  assert.equal(v.namedRedirect, true);
  assert.equal(v.redirectTitle, 'Big Chungus');
});

test('the normalised form is what the pageviews API is asked for', () => {
  const v = judgeCandidate('kirkiversary', page({ requested: 'kirkiversary', source: 'Kirkiversary', title: 'Assassination of Charlie Kirk', redirected: true, fragment: 'Social media' }));
  assert.equal(v.redirectTitle, 'Kirkiversary');
});

test('a section redirect under another title does not stand for the term', () => {
  const v = judgeCandidate('Big Chungus', page({ requested: 'Chungus', title: 'Wabbit Twouble', redirected: true, fragment: 'Big Chungus meme' }));
  assert.equal(v.namedRedirect, false);
  assert.equal(v.redirectTitle, null);
});

test('a whole-article redirect keeps its target, as before', () => {
  const v = judgeCandidate('Donald Trump mugshot', page({ requested: 'Donald Trump mugshot', title: 'Mug shot of Donald Trump', redirected: true }));
  assert.equal(v.title, 'Mug shot of Donald Trump');
  assert.equal(v.match, 'redirect');
  assert.equal(v.redirectTitle, null);
});
