'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
const { encryptJson, decryptJson } = require('./credentialVault');

test('credential vault encrypts and round-trips WordPress credentials', () => {
  const input = { wpUrl: 'https://example.com', wpUser: 'editor', wpAppPassword: 'secret-password' };
  const record = encryptJson(input);
  assert.equal(JSON.stringify(record).includes(input.wpAppPassword), false);
  assert.deepEqual(decryptJson(record), input);
});

test('credential vault rejects tampered ciphertext', () => {
  const record = encryptJson({ secret: 'value' });
  record.data = Buffer.from('tampered').toString('base64');
  assert.throws(() => decryptJson(record));
});

test('credential vault rejects invalid key configuration', () => {
  const old = process.env.CREDENTIAL_ENCRYPTION_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY = 'too-short';
  try { assert.throws(() => encryptJson({ secret: true }), /CREDENTIAL_ENCRYPTION_KEY/); }
  finally { process.env.CREDENTIAL_ENCRYPTION_KEY = old; }
});
