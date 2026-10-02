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

import { verifyAliases } from './wikipedia';

test('verifyAliases: a one-word alias counts when it is the article under another name', () => {
  const pages = new Map<string, PageInfo>([
    ['Trump', page({ requested: 'Trump', title: 'Donald Trump', redirected: true })],
    ['DJT', page({ requested: 'DJT', title: 'Donald Trump', redirected: true })],
    ['Musk', page({ requested: 'Musk', title: 'Musk' })],
    ['Elon', page({ requested: 'Elon', title: 'Elon', disambiguation: true })],
    ['Chungus', page({ requested: 'Chungus', title: 'Wabbit Twouble', redirected: true, fragment: 'Big Chungus meme' })],
    ['Zorblax', page({ requested: 'Zorblax', title: 'Zorblax', missing: true })],
    ['mrbeast', page({ requested: 'mrbeast', source: 'Mrbeast', title: 'MrBeast', redirected: true })],
  ]);
  assert.deepEqual(verifyAliases('Donald Trump', ['Trump', 'DJT', 'Musk', 'Elon', 'Zorblax', 'Unlooked'], pages), ['Trump', 'DJT']);
  assert.deepEqual(verifyAliases('Elon Musk', ['Musk', 'Elon'], pages), [], 'the substance and a disambiguation page');
  assert.deepEqual(verifyAliases('Wabbit Twouble', ['Chungus'], pages), [], 'a section redirect is not the article');
  assert.deepEqual(verifyAliases('MrBeast', ['mrbeast'], pages), [], 'the title spelled differently adds nothing');
});

import { redirectNamesTerm } from './wikipedia';

test('a one-word term redirected to a longer title that carries the word is that article; a different word or a one-word target is not', () => {
  const chem = judgeCandidate('Chemtrails', page({ requested: 'Chemtrails', title: 'Chemtrail conspiracy theory', redirected: true }));
  assert.equal(chem.title, 'Chemtrail conspiracy theory');
  assert.equal(chem.match, 'redirect');
  const skibidi = judgeCandidate('Skibidi', page({ requested: 'Skibidi', title: 'Skibidi Toilet', redirected: true }));
  assert.equal(skibidi.match, 'redirect');
  assert.equal(judgeCandidate('Trump', page({ requested: 'Trump', title: 'Donald Trump', redirected: true })).match, 'redirect');
  assert.equal(judgeCandidate('Clavicular', page({ requested: 'Clavicular', title: 'Clavicle', redirected: true })).title, null, 'the bone');
  assert.equal(judgeCandidate('Cats', page({ requested: 'Cats', title: 'Cat', redirected: true })).title, null, 'a one-word target is a common noun');
  assert.equal(judgeCandidate('Musk', page({ requested: 'Musk', title: 'Elon Musk', redirected: true })).match, 'redirect');
  assert.equal(redirectNamesTerm('Chemtrails', 'Chemtrail conspiracy theory'), true);
  assert.equal(redirectNamesTerm('Verity', 'Verity (novel)'), false, 'a qualified namesake has one word');
  assert.equal(redirectNamesTerm('Elon', 'Elon University'), true, 'carries the word; the disambiguation check runs before this');
});

import { pickAliasVerdict, type CandidateVerdict } from './wikipedia';

test('pickAliasVerdict: an exact article beats a redirect found earlier; otherwise the first found', () => {
  const v = (title: string, match: CandidateVerdict['match']): CandidateVerdict => ({ title, match, ambiguous: false, namedRedirect: false, redirectTitle: null });
  assert.equal(pickAliasVerdict([v('Nike Flywire', 'redirect'), v('Drosophila connectome', 'exact')])?.title, 'Drosophila connectome');
  assert.equal(pickAliasVerdict([v('Nike Flywire', 'redirect'), v('Flywire (screen)', 'qualified')])?.title, 'Nike Flywire');
  assert.equal(pickAliasVerdict([]), null);
});
