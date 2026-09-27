// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideX, guessXHandles, handleAliases, parseXUrl, xExactHandle, xNameMatches, type XAccount, type XCandidate } from './resolve-x';

const acc = (o: Partial<XAccount> & { userName: string }): XAccount => ({ id: o.userName, name: '', followers: 0, posts: 0, verified: false, ...o });

test('parseXUrl reads profile and status URLs on x.com and twitter.com, not site paths', () => {
  assert.deepEqual(parseXUrl('https://x.com/elonmusk'), { handle: 'elonmusk' });
  assert.deepEqual(parseXUrl('https://x.com/ElonMusk/status/1234'), { handle: 'elonmusk' });
  assert.deepEqual(parseXUrl('https://twitter.com/MrBeast?s=20'), { handle: 'mrbeast' });
  assert.deepEqual(parseXUrl('https://mobile.twitter.com/cobratate'), { handle: 'cobratate' });
  assert.equal(parseXUrl('https://x.com/home'), null);
  assert.equal(parseXUrl('https://x.com/i/status/1234'), null);
  assert.equal(parseXUrl('https://x.com/search?q=trump'), null);
  assert.equal(parseXUrl('https://www.youtube.com/@mrbeast'), null);
  assert.equal(parseXUrl(null), null);
});

test('handle-like aliases and guesses', () => {
  assert.deepEqual(handleAliases(['@DolanDark', 'Dolan Darkest', 'elonmusk', 'Top G', 'AndrewTate']), ['dolandark', 'elonmusk', 'andrewtate']);
  assert.deepEqual(guessXHandles('Elon Musk', ['Elon', 'Musk', 'elonmusk']), ['elonmusk', 'elon', 'musk']);
  assert.deepEqual(guessXHandles('Lessons in Meme Culture', ['LIMC']), ['limc'], 'the run-together name is too long for a handle');
});

test('name matching on display name or handle', () => {
  const musk = acc({ userName: 'elonmusk', name: 'Elon Musk', followers: 241e6 });
  assert.equal(xNameMatches(musk, 'Elon Musk', ['Elon', 'Musk']), true);
  assert.equal(xNameMatches(acc({ userName: 'cobratate', name: 'Andrew Tate' }), 'Andrew Tate', ['Cobra Tate']), true);
  assert.equal(xNameMatches(acc({ userName: 'musk_fans', name: 'Musk Fan Page' }), 'Elon Musk', ['Musk']), false, 'a fan page is not the name');
  assert.equal(xExactHandle(acc({ userName: 'dolandark' }), ['@DolanDark']), true);
  assert.equal(xExactHandle(acc({ userName: 'dolandarkest' }), ['@DolanDark']), false);
});

test('decideX: Wikidata verifies; two pieces of evidence and a dwarfing audience verify; else a candidate', () => {
  const c = (o: Partial<XCandidate> & { account: XAccount }): XCandidate => ({ evidence: [], nameMatch: true, fragmentMatch: false, ...o });
  const musk = acc({ userName: 'elonmusk', name: 'Elon Musk', followers: 241e6 });
  assert.equal(decideX([c({ account: musk, evidence: ['wikidata'] })]).status, 'verified');
  assert.equal(decideX([c({ account: musk, evidence: ['capture_url', 'exact_name'] })]).status, 'verified');
  const one = decideX([c({ account: musk, evidence: ['handle_guess'] })]);
  assert.equal(one.status, 'candidate');
  assert.equal(one.review, true, 'big enough to look at');
  const small = decideX([c({ account: acc({ userName: 'x', name: 'X', followers: 500 }), evidence: ['capture_url', 'exact_name'] })]);
  assert.equal(small.status, 'candidate');
  assert.equal(small.review, false);
  const rival = decideX([
    c({ account: musk, evidence: ['handle_guess', 'exact_name'] }),
    c({ account: acc({ userName: 'elon', name: 'Elon Musk', followers: 100e6 }), evidence: ['handle_guess'] }),
  ]);
  assert.equal(rival.status, 'candidate', 'a comparable account exists');
  assert.equal(decideX([c({ account: musk, nameMatch: false })]).status, 'none');
});
