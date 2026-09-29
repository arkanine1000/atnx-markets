// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDescribePrompt, dueForDescription, ownArticleTitle } from './describe';
import type { Components } from './vi/score';
import { isSiteSlogan } from './thumbnails';

const wiki = (meta: Record<string, string | number>): Components => ({ wikipedia: { source: 'wikipedia', level: 300, momentum: 1, fetchedAt: '2026-09-29T00:00:00Z', meta } });

test('ownArticleTitle: only an owned exact, redirect or qualified article; not a section of another, not a namesake', () => {
  assert.equal(ownArticleTitle(wiki({ own: 1, match: 'exact', title: 'Nujabes' })), 'Nujabes');
  assert.equal(ownArticleTitle(wiki({ own: 1, match: 'redirect', title: 'Michael Saylor' })), 'Michael Saylor');
  assert.equal(ownArticleTitle(wiki({ own: 1, match: 'qualified', title: 'Clavicular (streamer)' })), 'Clavicular (streamer)');
  assert.equal(ownArticleTitle(wiki({ own: 1, match: 'section_redirect', title: 'Wabbit Twouble' })), null, 'the target article is about something else');
  assert.equal(ownArticleTitle(wiki({ own: 0, match: 'exact', title: 'Fruit fly' })), null, 'a namesake');
  assert.equal(ownArticleTitle(wiki({ own: 1, match: 'exact', title: '' })), null);
  assert.equal(ownArticleTitle(null), null);
});

test('dueForDescription: none yet and not looked at this week, or forced; never once one exists', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  assert.equal(dueForDescription({ description_source: null, description_checked_at: null }, { now }), true);
  assert.equal(dueForDescription({ description_source: null, description_checked_at: '2026-09-28T12:00:00Z' }, { now }), false, 'looked at yesterday');
  assert.equal(dueForDescription({ description_source: null, description_checked_at: '2026-09-20T12:00:00Z' }, { now }), true, 'over a week ago');
  assert.equal(dueForDescription({ description_source: null, description_checked_at: '2026-09-28T12:00:00Z' }, { now, force: true }), true);
  assert.equal(dueForDescription({ description_source: 'model', description_checked_at: null }, { now, force: true }), false);
  assert.equal(dueForDescription({ description_source: 'manual', description_checked_at: null }, { now }), false);
});

test('buildDescribePrompt lists the subject, its names and the context in order', () => {
  const p = buildDescribePrompt({ entity_name: 'Dolan Dark', entity_type: 'person', category: 'people', aliases: ['dolandarkest'] }, ['{"name":"Dolan Dark","description":"A YouTuber known for meme edits"}']);
  assert.match(p, /^Subject: Dolan Dark\nType: person \(people\)\nAlso known as: dolandarkest\n\nContext, newest first:\n1\. \{"name"/);
  const bare = buildDescribePrompt({ entity_name: 'X', entity_type: null, category: null, aliases: [] }, ['ctx']);
  assert.match(bare, /^Subject: X\nType: unknown\n\nContext/);
});

test('isSiteSlogan: a gallery page\'s own line is not a description', () => {
  assert.equal(isSiteSlogan("See more '90s Nostalgia' images on Know Your Meme!"), true);
  assert.equal(isSiteSlogan('Browse the latest memes and viral videos.'), true);
  assert.equal(isSiteSlogan('Trollface is a Rage Comic character wearing a mischievous smile.'), false);
});
