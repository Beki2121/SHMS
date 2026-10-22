import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

const encryptionKey = createHash('sha256')
  .update(env.GUEST_PII_ENCRYPTION_KEY)
  .digest();
const lookupKey = createHmac('sha256', encryptionKey)
  .update('smarthotel-guest-id-lookup')
  .digest();

export function normalizeIdNumber(value) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function encryptIdNumber(value) {
  const normalized = normalizeIdNumber(value);
  if (!normalized) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value.trim(), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function decryptIdNumber(value) {
  if (typeof value !== 'string') return null;
  const [version, ivPart, tagPart, ciphertextPart] = value.split(':');
  if (version !== 'v1' || !ivPart || !tagPart || !ciphertextPart) {
    throw new Error('Stored guest ID ciphertext is invalid');
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function hashIdNumber(value) {
  const normalized = normalizeIdNumber(value);
  if (!normalized) return null;
  return createHmac('sha256', lookupKey).update(normalized).digest('hex');
}

export function idNumberLast4(value) {
  const normalized = normalizeIdNumber(value);
  return normalized.length ? normalized.slice(-4) : null;
}

export function maskIdNumber(last4) {
  return last4 ? `****${last4}` : null;
}
