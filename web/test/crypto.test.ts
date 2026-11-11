import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kemKeygen, openChunk, randomBytes, sealChunk, unwrapKey, wrapKey, pad, unpad, open, seal } from '../src/core/crypto.ts';
import { utf8 } from '../src/core/bytes.ts';

test('hybrid KEM wraps and unwraps, and binds the context', () => {
  const kp = kemKeygen();
  const key = randomBytes(32);
  const w = wrapKey(kp.pk, key, utf8('item|dev'));
  assert.deepEqual(unwrapKey(kp, w, utf8('item|dev')), key);
  assert.throws(() => unwrapKey(kp, w, utf8('item|other')));
  assert.throws(() => unwrapKey(kemKeygen(), w, utf8('item|dev')));
});

test('chunks detect tampering, reordering and truncation', () => {
  const key = randomBytes(32);
  const a = sealChunk(key, 'item1', 0, false, utf8('first'));
  const b = sealChunk(key, 'item1', 1, true, utf8('last'));
  assert.equal(new TextDecoder().decode(openChunk(key, 'item1', 1, true, b)), 'last');
  assert.throws(() => openChunk(key, 'item1', 1, true, a), 'reordered');
  assert.throws(() => openChunk(key, 'item1', 0, true, a), 'truncated: chunk 0 is not the last');
  assert.throws(() => openChunk(key, 'item2', 1, true, b), 'moved to another item');
  const t = b.slice();
  t[3] ^= 1;
  assert.throws(() => openChunk(key, 'item1', 1, true, t), 'tampered');
});

test('padding hides the length and round-trips', () => {
  assert.equal(pad(utf8('4970123456789012'), 256).length, 256);
  assert.equal(pad(new Uint8Array(255), 256).length, 256);
  assert.equal(pad(new Uint8Array(256), 256).length, 512);
  assert.deepEqual(unpad(pad(utf8('abc'), 64)), utf8('abc'));
  const k = randomBytes(32);
  assert.deepEqual(open(k, seal(k, utf8('x'), utf8('aad')), utf8('aad')), utf8('x'));
  assert.throws(() => open(k, seal(k, utf8('x'), utf8('aad')), utf8('other')));
});
