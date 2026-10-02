// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameAlternatesFrom } from './naming';
import type { PageInfo } from './vi/wikipedia';

const page = (o: Partial<PageInfo> & { requested: string; title: string }): PageInfo => ({
  source: o.requested,
  fragment: null,
  redirected: false,
  missing: false,
  disambiguation: false,
  ...o,
});
const pages = (...ps: PageInfo[]) => new Map(ps.map((p) => [p.requested, p]));

test('nameAlternatesFrom: a one-word alias Wikipedia redirects to a longer article is offered, as the word and as the title', () => {
  const got = nameAlternatesFrom(
    'Chemtrails Weather Control Conspiracy',
    ['Chemtrails', 'Weather modification conspiracy', 'CIA weather control'],
    false,
    pages(page({ requested: 'Chemtrails', title: 'Chemtrail conspiracy theory', redirected: true }))
  );
  assert.deepEqual(got, ['Chemtrails', 'Chemtrail conspiracy theory']);
});

test('nameAlternatesFrom: nothing when the name itself is known, or for an exact article, a one-word target, a disambiguation page, a section redirect, or a missing page', () => {
  const chem = page({ requested: 'Chemtrails', title: 'Chemtrail conspiracy theory', redirected: true });
  assert.deepEqual(nameAlternatesFrom('Chemtrail conspiracy theory', ['Chemtrails'], true, pages(chem)), [], 'the name is known');
  assert.deepEqual(nameAlternatesFrom('Side Eye Cat', ['cat'], false, pages(page({ requested: 'cat', title: 'Cat' }))), [], 'an exact article under a common noun');
  assert.deepEqual(nameAlternatesFrom('Cat Memes', ['cats'], false, pages(page({ requested: 'cats', title: 'Cat', redirected: true }))), [], 'a one-word target');
  assert.deepEqual(nameAlternatesFrom('Verity ARG', ['Verity'], false, pages(page({ requested: 'Verity', title: 'Verity', disambiguation: true }))), [], 'several things');
  assert.deepEqual(nameAlternatesFrom('Big Chungus Returns', ['Chungus'], false, pages(page({ requested: 'Chungus', title: 'Wabbit Twouble', redirected: true, fragment: 'Big Chungus meme' }))), [], 'a section of something else');
  assert.deepEqual(nameAlternatesFrom('Nosfercatu Cat', ['Nosfercatu'], false, pages(page({ requested: 'Nosfercatu', title: 'Nosfercatu', missing: true }))), []);
  assert.deepEqual(nameAlternatesFrom('Clavicular Edits', ['Clavicular'], false, pages(page({ requested: 'Clavicular', title: 'Clavicle', redirected: true }))), [], 'the bone');
});

test('nameAlternatesFrom: multi-word and function-word aliases are not looked at; duplicates and the name itself are dropped', () => {
  const got = nameAlternatesFrom(
    'Trump Mugshot Meme',
    ['Donald Trump', 'the', 'trump', 'Trump'],
    false,
    pages(page({ requested: 'trump', title: 'Donald Trump', redirected: true }), page({ requested: 'Trump', title: 'Donald Trump', redirected: true }))
  );
  assert.deepEqual(got, ['Trump', 'Donald Trump']);
});
