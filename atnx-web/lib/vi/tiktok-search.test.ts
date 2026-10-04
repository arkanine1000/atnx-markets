// node --test (through tsx): the pure parts of the TikTok keyword search
// source. The actor and the database are not touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSet, encodeSet, groupByQuery, inWindow, mergeSet, readDue, rowToPost, searchDue, INTERVAL_MS, MAX_POSTS, WINDOW_MS, type SetPost } from './tiktok-search';
import type { SourceComponent } from './score';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const H = 3600 * 1000;
const D = 24 * H;
const iso = (agoMs: number) => new Date(T0 - agoMs).toISOString();

function stored(over: Partial<SourceComponent> & { meta?: Record<string, string | number | null> } = {}): SourceComponent {
  return { source: 'tiktok_search', level: 300, momentum: 1, fetchedAt: iso(0), ...over };
}

test('encodeSet / decodeSet: author, id and upload day survive the round trip; junk is dropped', () => {
  const posts: SetPost[] = [
    { author: 'shaiie_foe', id: '7300000000000000001', createdAt: '2026-10-01T00:00:00.000Z' },
    { author: 'someone', id: '7300000000000000002', createdAt: null },
  ];
  const enc = encodeSet(posts);
  assert.equal(enc, 'shaiie_foe/7300000000000000001/20727,someone/7300000000000000002/0');
  assert.deepEqual(decodeSet(enc), posts);
  assert.deepEqual(decodeSet('garbage,/x/1,a/b/c'), []);
  assert.deepEqual(decodeSet(undefined), []);
});

test('inWindow: a post leaves the set a week after upload; an unknown upload time stays', () => {
  const posts: SetPost[] = [
    { author: 'a', id: '1', createdAt: iso(WINDOW_MS - H) },
    { author: 'b', id: '2', createdAt: iso(WINDOW_MS + H) },
    { author: 'c', id: '3', createdAt: null },
  ];
  assert.deepEqual(inWindow(posts, T0).map((p) => p.id), ['1', '3']);
});

test('mergeSet: what was found first, then the previous set still in the window, newest first, no captured post, capped', () => {
  const found: SetPost[] = [
    { author: 'a', id: '10', createdAt: iso(2 * D) },
    { author: 'a', id: '11', createdAt: iso(1 * D) },
    { author: 'a', id: '12', createdAt: iso(3 * D) },
  ];
  const previous: SetPost[] = [
    { author: 'b', id: '20', createdAt: iso(5 * D) },
    { author: 'b', id: '21', createdAt: iso(9 * D) },
    { author: 'a', id: '11', createdAt: iso(1 * D) },
  ];
  const set = mergeSet(found, previous, new Set(['tiktok:12']), T0);
  assert.deepEqual(set.map((p) => p.id), ['11', '10', '20'], 'the captured 12 and the week-old 21 are out; 11 appears once');
  const many = Array.from({ length: MAX_POSTS + 5 }, (_, i) => ({ author: 'z', id: String(100 + i), createdAt: iso(i * H) }));
  assert.equal(mergeSet(many, [], new Set(), T0).length, MAX_POSTS);
});

test('searchDue: never searched; two days for a plain market, one when hot, three after an empty search', () => {
  assert.equal(searchDue(null, T0), true);
  assert.equal(searchDue(stored({ meta: { searched_at: iso(47 * H), found: 8 } }), T0), false);
  assert.equal(searchDue(stored({ meta: { searched_at: iso(47.8 * H), found: 8 } }), T0), true, 'two days less the slack');
  assert.equal(searchDue(stored({ level: 700, meta: { searched_at: iso(23.8 * H), found: 8 } }), T0), true, 'hot: daily');
  assert.equal(searchDue(stored({ level: 200, momentum: 2, meta: { searched_at: iso(23.8 * H), found: 8 } }), T0), true, 'hot by momentum');
  assert.equal(searchDue(stored({ meta: { searched_at: iso(60 * H), found: 0 } }), T0), false, 'empty: not yet');
  assert.equal(searchDue(stored({ meta: { searched_at: iso(72 * H), found: 0 } }), T0), true);
});

test('readDue: a search is a read; otherwise every six hours, and never with an empty set', () => {
  const set = encodeSet([{ author: 'a', id: '1', createdAt: iso(D) }]);
  assert.equal(readDue(stored({ fetchedAt: iso(H), meta: { searched_at: iso(H), found: 1, posts: set } }), T0), false);
  assert.equal(readDue(stored({ fetchedAt: iso(INTERVAL_MS - 10 * 60_000), meta: { searched_at: iso(10 * H), found: 1, posts: set } }), T0), true, 'six hours less the slack');
  assert.equal(readDue(stored({ fetchedAt: iso(7 * H), meta: { searched_at: iso(10 * H), found: 0, posts: '' } }), T0), false, 'nothing to re-read');
  assert.equal(readDue(stored({ fetchedAt: iso(H), meta: { searched_at: iso(50 * H), found: 3, posts: set } }), T0), true, 'the search is due');
});

test('rowToPost: the actor row becomes a set post and its first read; a row without an id or author is skipped', () => {
  const r = rowToPost({ id: '7300000000000000001', webVideoUrl: 'https://www.tiktok.com/@shaiie_foe/video/7300000000000000001', playCount: 9700000, diggCount: '1200', shareCount: 5, commentCount: null, createTimeISO: '2026-09-20T10:00:00.000Z' });
  assert.ok(r);
  assert.deepEqual(r.post, { author: 'shaiie_foe', id: '7300000000000000001', createdAt: '2026-09-20T10:00:00.000Z' });
  assert.equal(r.stats.ref.url, 'https://www.tiktok.com/@shaiie_foe/video/7300000000000000001');
  assert.equal(r.stats.views, 9700000);
  assert.equal(r.stats.likes, 1200);
  assert.equal(r.stats.comments, null);
  const epoch = rowToPost({ id: 1, authorMeta: { name: 'someone' }, createTime: 1_759_000_000, playCount: 10 });
  assert.equal(epoch?.post.author, 'someone');
  assert.equal(epoch?.post.createdAt, new Date(1_759_000_000 * 1000).toISOString());
  assert.equal(rowToPost({ id: 'abc', webVideoUrl: 'https://www.tiktok.com/@x/video/abc' }), null);
  assert.equal(rowToPost({ id: '5', playCount: 1 }), null, 'no author anywhere');
});

test('groupByQuery: rows land under the query they name, case-folded; every asked query is present; strays are dropped', () => {
  const g = groupByQuery(
    [
      { searchQuery: 'Nosfercatu', id: '1' },
      { searchQuery: 'nosfercatu', id: '2' },
      { searchQuery: 'Chemtrails', id: '3' },
      { searchQuery: 'something else', id: '4' },
      { id: '5' },
    ],
    ['Nosfercatu', 'Chemtrails', 'Aura Monster']
  );
  assert.deepEqual([...g.keys()], ['Nosfercatu', 'Chemtrails', 'Aura Monster']);
  assert.deepEqual(g.get('Nosfercatu')?.map((r) => r.id), ['1', '2']);
  assert.deepEqual(g.get('Chemtrails')?.map((r) => r.id), ['3']);
  assert.deepEqual(g.get('Aura Monster'), []);
});
