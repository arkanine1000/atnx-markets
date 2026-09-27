// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelReading, effectiveYoutube, ofChannel } from './channel';
import { youtubeLevel } from '../vi/youtube';
import { CALIBRATION } from '../vi/score';
import type { Sample } from '../vi/samples';

const NOW = Date.parse('2026-09-28T15:07:00Z');
const H = 3600_000;
const total = (hoursAgo: number, v: number): Sample => ({ sampled_at: new Date(NOW - hoursAgo * H).toISOString(), value: v, meta: { kind: 'total' } });
const boot = (hoursAgo: number, v: number): Sample => ({ sampled_at: new Date(NOW - hoursAgo * H).toISOString(), value: v, meta: { kind: 'recent_uploads' } });

// Hourly samples of a total that YouTube refreshes once a day by `perDay`.
function stepped(hours: number, perDay: number, base = 2_835_792_884): Sample[] {
  const out: Sample[] = [];
  for (let h = hours; h >= 0; h--) out.push(total(h, base + Math.floor((hours - h) / 24) * perDay));
  return out;
}

test('a day of step-updated totals gives the weekly growth', () => {
  const r = channelReading(stepped(26, 600_000), NOW);
  assert.equal(r.basis, 'growth');
  // One 600k step over a 26 h span, scaled to a week.
  assert.equal(r.views7d, Math.round((600_000 * 7 * 24) / 26));
  assert.equal(r.level, youtubeLevel(r.views7d!));
});

test('under a day of totals, the recent uploads stand in', () => {
  const r = channelReading([...stepped(10, 600_000), boot(2, 4_114_970)], NOW);
  assert.equal(r.basis, 'recent_uploads');
  assert.equal(r.views7d, 4_114_970);
  assert.equal(r.momentum, null);
});

test('totals that have not moved yet are not growth', () => {
  const flat = [total(30, 100), total(20, 100), total(0, 100)];
  assert.equal(channelReading(flat, NOW).basis, null);
});

test('a steady channel over a week has momentum near 1', () => {
  const r = channelReading(stepped(24 * 7 - 6, 600_000), NOW);
  assert.equal(r.basis, 'growth');
  assert.ok(r.momentum !== null && Math.abs(r.momentum - 1) < 0.01, `momentum ${r.momentum}`);
});

test('stale totals and stale bootstraps read nothing', () => {
  assert.equal(channelReading([total(80, 1), total(50, 5)], NOW).level, null);
  assert.equal(channelReading([boot(30, 5_000_000)], NOW).level, null);
});

// Own-channel factor 1 in these tests; the fitted default is covered by score.test.ts.
const ONE = { ...CALIBRATION, ownChannelFactor: 1 };

test('the channel scores the slot only when its week beats the name search', () => {
  const base = { source: 'youtube' as const, level: 0, momentum: null, fetchedAt: new Date(NOW).toISOString() };
  const forrest = effectiveYoutube({ ...base, meta: { views_7d: 0, channel_views_7d: 23_755_300, channel_momentum: null } }, ONE);
  assert.equal(forrest.channel, true);
  assert.equal(forrest.component?.meta?.views_7d, 23_755_300);
  assert.equal(forrest.component?.meta?.views_basis, 'channel');
  assert.equal(forrest.component?.level, youtubeLevel(23_755_300));
  const trump = effectiveYoutube({ ...base, level: 650, momentum: 0.45, meta: { views_7d: 31_689_610, channel_views_7d: 175_889, channel_momentum: 1.1 } }, ONE);
  assert.equal(trump.channel, false);
  assert.equal(trump.component?.level, 650);
  assert.equal(trump.component?.momentum, 0.45, 'the name search keeps its own momentum');
  assert.equal(effectiveYoutube(undefined).channel, false);
  assert.equal(effectiveYoutube({ ...base, meta: { views_7d: 100 } }, ONE).channel, false, 'no channel reading');
});

test('a channel is discounted for its Shorts share before it competes with the name search', () => {
  const base = { source: 'youtube' as const, level: 0, momentum: null, fetchedAt: new Date(NOW).toISOString() };
  const shorts = effectiveYoutube({ ...base, meta: { views_7d: 0, channel_views_7d: 24e6, channel_shorts_share: 1, channel_momentum: 1.2 } }, ONE);
  assert.equal(shorts.channel, true);
  assert.equal(shorts.component?.meta?.views_7d, 6e6, 'all Shorts: x0.25');
  assert.equal(shorts.component?.momentum, 1.2, 'the channel momentum is used when the channel wins');
  const loses = effectiveYoutube({ ...base, meta: { views_7d: 7e6, channel_views_7d: 24e6, channel_shorts_share: 1 } }, ONE);
  assert.equal(loses.channel, false, 'discounted 6M loses to 7M of name search');
  const mixed = effectiveYoutube({ ...base, meta: { views_7d: 7e6, channel_views_7d: 24e6, channel_shorts_share: 0.6 } }, ONE);
  assert.equal(mixed.channel, true);
  assert.equal(mixed.component?.meta?.views_7d, 24e6 * (1 - 0.75 * 0.6), 'linear in the share');
  const unknown = effectiveYoutube({ ...base, meta: { views_7d: 7e6, channel_views_7d: 24e6 } }, ONE);
  assert.equal(unknown.component?.meta?.views_7d, 24e6, 'no share known: no discount');
  const half = { ...CALIBRATION, ownChannelFactor: 0.5 };
  const factored = effectiveYoutube({ ...base, meta: { views_7d: 7e6, channel_views_7d: 24e6 } }, half);
  assert.equal(factored.component?.meta?.views_7d, 12e6, 'the own-channel factor applies to what the channel stands for');
  assert.equal(effectiveYoutube({ ...base, meta: { views_7d: 7e6, channel_views_7d: 12e6 } }, half).channel, false, '6M loses to 7M');
});

test('a switched channel never mixes the old one in', () => {
  const old = { sampled_at: new Date(NOW - 20 * H).toISOString(), value: 100, meta: { kind: 'total', channel_id: 'UCold' } };
  const cur = { sampled_at: new Date(NOW).toISOString(), value: 500_000_000, meta: { kind: 'total', channel_id: 'UCnew' } };
  assert.deepEqual(ofChannel([old, cur], 'UCnew'), [cur]);
  assert.equal(channelReading(ofChannel([old, cur], 'UCnew'), NOW).basis, null, 'one total is not growth');
});

import { parseIsoDuration, shortsShare } from './channel';

test('parseIsoDuration reads YouTube durations', () => {
  assert.equal(parseIsoDuration('PT1M5S'), 65);
  assert.equal(parseIsoDuration('PT3M'), 180);
  assert.equal(parseIsoDuration('PT1H'), 3600);
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
  assert.equal(parseIsoDuration('P0D'), 0);
  assert.equal(parseIsoDuration('P1DT1S'), 86401);
  assert.equal(parseIsoDuration(''), null);
  assert.equal(parseIsoDuration(undefined), null);
  assert.equal(parseIsoDuration('3:05'), null);
});

test('shortsShare at the 180 s line, and unknown under five uploads', () => {
  assert.equal(shortsShare([55, 103, 180, 181, 600]), 0.6);
  assert.equal(shortsShare([55, 60, 70, 90, 100, 120]), 1);
  assert.equal(shortsShare([55, 60, 70, null]), null, 'four known durations');
  assert.equal(shortsShare([55, 60, 70, 80, null, null]), null, 'nulls do not count');
  assert.equal(shortsShare([]), null);
});

test('channelReading carries the newest Shorts share within a week', () => {
  const share = (hoursAgo: number, v: number, kind = 'shorts_share'): Sample => ({ sampled_at: new Date(NOW - hoursAgo * H).toISOString(), value: 1, meta: { kind, shorts_share: v } });
  const r = channelReading([...stepped(26, 600_000), share(30, 0.4), share(5, 0.9)], NOW);
  assert.equal(r.basis, 'growth');
  assert.equal(r.shortsShare, 0.9);
  const bootWithShare = channelReading([...stepped(10, 600_000), { ...boot(2, 4_114_970), meta: { kind: 'recent_uploads', shorts_share: 1 } }], NOW);
  assert.equal(bootWithShare.basis, 'recent_uploads');
  assert.equal(bootWithShare.shortsShare, 1);
  assert.equal(channelReading([...stepped(26, 600_000), share(24 * 8, 1)], NOW).shortsShare, null, 'older than a week');
  assert.equal(channelReading(stepped(26, 600_000), NOW).shortsShare, null);
});
