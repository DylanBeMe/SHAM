const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeCbor, fromB64url } = require('../src/webauthn');

test('WebAuthn CBOR rejects oversized declared containers before allocation', () => {
  assert.throws(() => decodeCbor(Buffer.from([0x9a, 0xff, 0xff, 0xff, 0xff])), /too many items/i);
  assert.throws(() => decodeCbor(Buffer.from([0xba, 0xff, 0xff, 0xff, 0xff])), /too many items/i);
});

test('WebAuthn CBOR rejects excessive nesting, duplicate keys, and trailing bytes', () => {
  assert.throws(() => decodeCbor(Buffer.from([...Array(18).fill(0xc0), 0x00])), /nesting is too deep/i);
  assert.throws(() => decodeCbor(Buffer.from([0xa2, 0x01, 0x01, 0x01, 0x02])), /duplicate key/i);
  assert.throws(() => decodeCbor(Buffer.from([0x00, 0x00])), /trailing bytes/i);
});

test('WebAuthn base64url decoding rejects malformed and oversized inputs', () => {
  assert.throws(() => fromB64url('***'), /valid base64url/i);
  assert.throws(() => fromB64url('A'.repeat(64), 8), /size limit/i);
  assert.deepEqual(fromB64url('AQID'), Buffer.from([1, 2, 3]));
});
