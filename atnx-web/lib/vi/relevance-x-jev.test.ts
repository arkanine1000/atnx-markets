// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeableText, subjectLine } from './relevance-x-jev';

test('judgeableText: a bare media link or a handle-only reply has nothing to judge; hashtags and words do', () => {
  assert.equal(judgeableText('https://t.co/wOCGZHXLgQ'), '');
  assert.equal(judgeableText('@someone @other https://t.co/abc'), '');
  assert.equal(judgeableText('   '), '');
  assert.equal(judgeableText('#GTA6 https://t.co/abc'), '#GTA6');
  assert.equal(judgeableText('@someone this is it https://t.co/abc'), 'this is it');
  assert.equal(judgeableText('email me@example.com'), 'email me@example.com', 'a handle inside a word is not a mention');
});

test('subjectLine carries the description after the names, trimmed', () => {
  assert.equal(subjectLine({ name: 'Zach Cregger Resident Evil', entityType: 'other', category: 'film_tv', aliases: ['Resident Evil 2026'], description: '  The 2026 Resident Evil film\n directed by Zach Cregger. ' }),
    'Zach Cregger Resident Evil (other, film_tv) also known as Resident Evil 2026 : The 2026 Resident Evil film directed by Zach Cregger.');
  assert.equal(subjectLine({ name: 'Meta', description: null }), 'Meta');
});
