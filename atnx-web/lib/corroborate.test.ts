// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blueskyLine, corroborationTerm, knowYourMemeLine, tiktokLine, trendsLine, wikipediaLine, youtubeLine } from './corroborate';

test('corroborationTerm: only a not_cultural_content reject with a specific tentative name', () => {
  assert.equal(corroborationTerm({ admit: false, reject_reason: 'not_cultural_content', tentative_name: 'NOSFERCATU!' }), 'NOSFERCATU');
  assert.equal(corroborationTerm({ admit: false, reject_reason: 'not_cultural_content', tentative_name: '#nosfercatu' }), 'nosfercatu');
  assert.equal(corroborationTerm({ admit: true, reject_reason: null, tentative_name: 'Nosfercatu' }), null, 'admitted');
  assert.equal(corroborationTerm({ admit: false, reject_reason: 'policy', tentative_name: 'Nosfercatu' }), null, 'policy is final');
  assert.equal(corroborationTerm({ admit: false, reject_reason: 'unreadable', tentative_name: 'Nosfercatu' }), null);
  assert.equal(corroborationTerm({ admit: false, reject_reason: 'not_cultural_content', tentative_name: null }), null, 'nothing to check');
  assert.equal(corroborationTerm({ admit: false, reject_reason: 'not_cultural_content', tentative_name: 'ab' }), null, 'too short');
  assert.equal(corroborationTerm({ admit: false, reject_reason: 'not_cultural_content', tentative_name: 'November 2026' }), null, 'a calendar period');
});

test('evidence lines: a source that found nothing gives no line', () => {
  assert.equal(knowYourMemeLine('X', null), null);
  assert.match(knowYourMemeLine('Nosfercatu', { description: 'A sleeping cat posed as the vampire.' })!.line, /^Know Your Meme has an entry for "Nosfercatu": A sleeping cat/);
  assert.match(knowYourMemeLine('Nosfercatu', {})!.line, /entry for "Nosfercatu"\.$/);
  assert.equal(wikipediaLine('X', null), null);
  assert.match(wikipediaLine('X', 'X (meme)')!.line, /titled "X \(meme\)"/);
  assert.equal(youtubeLine('X', null), null);
  assert.equal(youtubeLine('X', { videos: 0, views: 0, titles: [] }), null);
  assert.equal(youtubeLine('X', { videos: 3, views: 900, titles: ['a'] }), null, 'too few views to count as circulation');
  const yt = youtubeLine('Nosfercatu', { videos: 12, views: 2_400_000, titles: ['Nosfercatu rises', 'the cat'] })!;
  assert.match(yt.line, /12 videos from the last week naming "Nosfercatu" with 2,400,000 views/);
  assert.match(yt.line, /such as "Nosfercatu rises", "the cat"\.$/);
  assert.equal(tiktokLine('X', null), null);
  assert.equal(tiktokLine('X', { hashtag: 'x', video_count: 3, view_count: 4_000 }), null, 'too few views');
  assert.equal(tiktokLine('X', { hashtag: 'x', video_count: 3, view_count: null }), null);
  assert.match(tiktokLine('Nosfercatu', { hashtag: 'nosfercatu', video_count: 9, view_count: 9_210_558 })!.line, /^TikTok's #nosfercatu has 9 videos with 9,210,558 views\.$/);
  assert.equal(blueskyLine('X', null), null);
  assert.equal(blueskyLine('X', { level: 0, meta: { posts_24h: 0 } }), null);
  assert.equal(blueskyLine('X', { level: 100, meta: { posts_24h: 2 } }), null, 'too few posts');
  assert.match(blueskyLine('X', { level: 300, meta: { posts_24h: 12 } })!.line, /12 posts naming "X" in the last day/);
  assert.equal(trendsLine('X', { level: null, meta: { below_resolution: 1 } }), null, 'below resolution is not evidence');
  assert.match(trendsLine('X', { level: 40, meta: { ratio_to_benchmark: 0.42, benchmark: 'sudoku' } })!.line, /at 42% of searches for "sudoku"/);
});
