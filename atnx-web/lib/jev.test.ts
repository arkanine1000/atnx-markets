// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jevMode, roundProbs } from './jev';
import { gateAction, pGenericOf } from './admission-jev';

test('jevMode defaults to shadow and accepts off and on only', () => {
  assert.equal(jevMode(undefined), 'shadow');
  assert.equal(jevMode(''), 'shadow');
  assert.equal(jevMode('nonsense'), 'shadow');
  assert.equal(jevMode('OFF'), 'off');
  assert.equal(jevMode(' on '), 'on');
});

test('the gate rejects at 0.9, reviews from 0.5, allows below', () => {
  assert.equal(gateAction(0.95), 'reject');
  assert.equal(gateAction(0.9), 'reject');
  assert.equal(gateAction(0.6), 'review');
  assert.equal(gateAction(0.5), 'review');
  assert.equal(gateAction(0.49), 'allow');
  assert.equal(gateAction(0), 'allow');
});

test('pGeneric sums the three non-subject kinds and stays in [0, 1]', () => {
  assert.equal(pGenericOf({ specific_subject: 0.09, calendar_or_time: 0.91, generic_phrase: 0, everyday_word_or_category: 0 }), 0.91);
  assert.equal(pGenericOf({ specific_subject: 1 }), 0);
  assert.equal(pGenericOf({ generic_phrase: 0.6, everyday_word_or_category: 0.6 }), 1);
  assert.deepEqual(roundProbs({ a: 0.123456, b: 0.9 }), { a: 0.123, b: 0.9 });
});
