// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeableText } from './relevance-x-jev';

test('judgeableText: a bare media link or a handle-only reply has nothing to judge; hashtags and words do', () => {
  assert.equal(judgeableText('https://t.co/wOCGZHXLgQ'), '');
  assert.equal(judgeableText('@someone @other https://t.co/abc'), '');
  assert.equal(judgeableText('   '), '');
  assert.equal(judgeableText('#GTA6 https://t.co/abc'), '#GTA6');
  assert.equal(judgeableText('@someone this is it https://t.co/abc'), 'this is it');
  assert.equal(judgeableText('email me@example.com'), 'email me@example.com', 'a handle inside a word is not a mention');
});
