// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoveryDue, discoveryInterval } from './youtube';
import type { SourceComponent } from './score';

const H = 3600_000;
const NOW = Date.parse('2026-09-25T13:07:00Z');

function reading(o: { level?: number | null; momentum?: number | null; ids?: number; inWeek?: number; ageH?: number }): SourceComponent {
  const ids = Array.from({ length: o.ids ?? 25 }, (_, i) => `v${i}`);
  return {
    source: 'youtube',
    level: o.level ?? 500,
    momentum: o.momentum ?? null,
    fetchedAt: new Date(NOW).toISOString(),
    meta: {
      videos: ids.join(','),
      video_count: o.inWeek ?? ids.length,
      discovered_at: o.ageH === undefined ? null : new Date(NOW - o.ageH * H).toISOString(),
    },
  };
}

test('intervals by how the market is moving', () => {
  assert.equal(discoveryInterval(reading({ level: 650 })), 24 * H, 'hot by level');
  assert.equal(discoveryInterval(reading({ level: 450, momentum: 1.6 })), 24 * H, 'hot by momentum');
  assert.equal(discoveryInterval(reading({ level: 450, inWeek: 12 })), 24 * H, 'decaying set');
  assert.equal(discoveryInterval(reading({ level: 450 })), 48 * H, 'steady');
  assert.equal(discoveryInterval(reading({ level: 200 })), 72 * H, 'quiet');
  assert.equal(discoveryInterval(reading({ level: 0, ids: 0 })), 72 * H, 'found nothing');
});

test('a market that never searched is due', () => {
  assert.equal(discoveryDue(null, NOW), true);
  assert.equal(discoveryDue(reading({ ageH: undefined }), NOW), true);
});

test('an empty result is not retried every hour', () => {
  assert.equal(discoveryDue(reading({ level: 0, ids: 0, ageH: 1 }), NOW), false);
  assert.equal(discoveryDue(reading({ level: 0, ids: 0, ageH: 71.9 }), NOW), true, 'within the slack of 72 h');
});

test('the run a day later takes a hot set despite run jitter', () => {
  // Found at 12:09, next day's run starts 12:07: 23h58m.
  assert.equal(discoveryDue(reading({ level: 650, ageH: 23 + 58 / 60 }), NOW), true);
  assert.equal(discoveryDue(reading({ level: 650, ageH: 20 }), NOW), false);
});

test('a steady set waits two days', () => {
  assert.equal(discoveryDue(reading({ level: 450, ageH: 30 }), NOW), false);
  assert.equal(discoveryDue(reading({ level: 450, ageH: 47.9 }), NOW), true);
});
