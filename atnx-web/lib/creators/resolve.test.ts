// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, exactNameMatch, guessHandles, nameMatches, parseYoutubeUrl, screenHandles, type Candidate, type Channel } from './resolve';

const ch = (o: Partial<Channel> & { id: string }): Channel => ({ title: '', handle: null, subscribers: 0, views: 0, videos: 0, description: '', ...o });

test('parseYoutubeUrl reads videos, shorts, handles and channel ids', () => {
  assert.deepEqual(parseYoutubeUrl('https://youtu.be/abc123'), { videoId: 'abc123' });
  assert.deepEqual(parseYoutubeUrl('https://www.youtube.com/watch?v=abc123&t=4'), { videoId: 'abc123' });
  assert.deepEqual(parseYoutubeUrl('https://m.youtube.com/shorts/xyz'), { videoId: 'xyz' });
  assert.deepEqual(parseYoutubeUrl('https://www.youtube.com/@ForrestsAutoReviewsOfficial/videos'), { handle: 'forrestsautoreviewsofficial' });
  assert.deepEqual(parseYoutubeUrl('https://www.youtube.com/channel/UCabc'), { channelId: 'UCabc' });
  assert.equal(parseYoutubeUrl('https://www.google.com/search?q=forrest'), null);
  assert.equal(parseYoutubeUrl(null), null);
});

test('screenHandles matches handles the app cut short', () => {
  const [f] = screenHandles('Spremi Podijelite Remiks @forre...official Pretplati me');
  assert.ok(f.test('forrestsautoreviewsofficial'));
  assert.ok(!f.test('forrestsautoreviews'));
  assert.ok(!f.test('forreofficial'), 'something must have been cut');
  const [g] = screenHandles('by @MrBeast');
  assert.ok(g.test('mrbeast'));
  assert.deepEqual(screenHandles('email me at a@b'), [], 'too short to be a handle');
});

test('guessHandles runs names together, with and without "official"', () => {
  assert.deepEqual(guessHandles("Forrest Jones", ["Forrest's Auto Reviews"]), ['forrestjones', 'forrestjonesofficial', 'forrestsautoreviews', 'forrestsautoreviewsofficial']);
});

test('nameMatches on title or handle against name and aliases', () => {
  assert.ok(nameMatches(ch({ id: 'a', title: "Forrest's Auto Reviews", handle: 'forrestsautoreviewsofficial' }), 'Forrest Jones', ["Forrest's Auto Reviews"]));
  assert.ok(!nameMatches(ch({ id: 'b', title: 'WestJett', handle: 'westjett' }), 'Andrew Tate', ['Cobra Tate']), 'a clip channel that posted the capture');
});

const cand = (channel: Channel, evidence: Candidate['evidence'], nameMatch = true): Candidate => ({ channel, evidence, nameMatch, fragmentMatch: evidence.includes('screen_handle') });

test('Forrest: two pieces of evidence and a dwarfed lookalike verify', () => {
  const r = decide([
    cand(ch({ id: 'real', handle: 'forrestsautoreviewsofficial', subscribers: 3_790_000 }), ['handle_guess', 'screen_handle']),
    cand(ch({ id: 'empty', handle: 'forrestsautoreviews', subscribers: 30 }), ['handle_guess']),
  ]);
  assert.equal(r.status, 'verified');
  assert.equal(r.best?.channel.id, 'real');
});

test('one guessed handle alone is only a candidate', () => {
  assert.equal(decide([cand(ch({ id: 'x', handle: 'cobratate', subscribers: 18_500 }), ['handle_guess'])]).status, 'candidate');
});

test('two big channels of the same name are left for review', () => {
  const r = decide([
    cand(ch({ id: 'a', handle: 'dolandark', subscribers: 1_510_000 }), ['handle_guess', 'name_search']),
    cand(ch({ id: 'b', handle: 'dolandarkest', subscribers: 484_000 }), ['handle_guess', 'screen_handle']),
  ]);
  assert.equal(r.status, 'candidate');
});

test('Wikidata verifies on its own; a non-matching capture poster never does', () => {
  assert.equal(decide([cand(ch({ id: 'w', handle: 'loganpaulvlogs', subscribers: 23_600_000 }), ['wikidata'])]).status, 'verified');
  assert.equal(decide([cand(ch({ id: 'c', handle: 'westjett', subscribers: 820_000 }), ['capture_url'], false)]).status, 'none');
});

test('small channels stay candidates and are not queued for review', () => {
  const r = decide([cand(ch({ id: 's', handle: 'doveellis', subscribers: 3630 }), ['handle_guess', 'screen_handle'])]);
  assert.equal(r.status, 'candidate');
  assert.equal(r.review, false);
  assert.equal(decide([cand(ch({ id: 'x', handle: 'cobratate', subscribers: 18_500 }), ['handle_guess'])]).review, true);
});

test('exactNameMatch: the exact name or alias, not a variant', () => {
  assert.ok(exactNameMatch(ch({ id: 'l', title: 'Lessons in Meme Culture', handle: 'limc' }), 'Lessons in Meme Culture', ['LIMC']));
  assert.ok(exactNameMatch(ch({ id: 'l2', title: 'LIMC', handle: 'limc' }), 'Lessons in Meme Culture', ['LIMC']));
  assert.ok(!exactNameMatch(ch({ id: 'f', title: 'Elon Musk Fans', handle: 'elonmuskfans' }), 'Elon Musk'));
  assert.ok(!exactNameMatch(ch({ id: 'o', title: 'Forrest Auto', handle: 'forrestsautoreviewsofficial' }), 'Forrest Jones', ["Forrest's Auto Reviews"]), 'an "official" variant is not exact');
});

test('a captured channel with the exact name verifies on its own', () => {
  const r = decide([
    cand(ch({ id: 'limc', handle: 'limc', title: 'Lessons in Meme Culture', subscribers: 2_250_000 }), ['capture_url', 'exact_name']),
    cand(ch({ id: 'x', handle: 'limcofficial', subscribers: 136 }), ['handle_guess']),
  ]);
  assert.equal(r.status, 'verified');
  assert.equal(r.best?.channel.id, 'limc');
});
