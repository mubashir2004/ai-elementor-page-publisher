'use strict';

const crypto = require('crypto');

function encryptionKey() {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY || '';
  let key;
  if (/^[a-f0-9]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else {
    try { key = Buffer.from(raw, 'base64'); } catch (_) { key = null; }
  }
  if (!key || key.length !== 32) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a 32-byte key encoded as 64 hex characters or base64.');
  }
  return key;
}

/** AES-256-GCM authenticated encryption; output contains no plaintext secrets. */
function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, alg: 'A256GCM', iv: iv.toString('base64'), tag: tag.toString('base64'), data: ciphertext.toString('base64') };
}

function decryptJson(record) {
  if (!record || record.v !== 1 || record.alg !== 'A256GCM') throw new Error('Unsupported credential record.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

module.exports = { encryptJson, decryptJson };
