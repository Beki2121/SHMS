import { describe, expect, it } from 'vitest';
import {
  decryptIdNumber,
  encryptIdNumber,
  hashIdNumber,
  idNumberLast4,
  maskIdNumber,
} from '../src/guests/pii.js';

describe('guest identity privacy primitives', () => {
  it('encrypts identity numbers and supports keyed duplicate matching without plaintext storage', () => {
    const identity = 'AB-1234-XYZ';
    const encrypted = encryptIdNumber(identity);
    expect(encrypted).not.toContain(identity);
    expect(decryptIdNumber(encrypted)).toBe(identity);
    expect(hashIdNumber(identity)).toBe(hashIdNumber('ab 1234 xyz'));
    expect(idNumberLast4(identity)).toBe('4XYZ');
    expect(maskIdNumber(idNumberLast4(identity))).toBe('****4XYZ');
  });

  it('rejects ciphertext with an invalid authentication tag', () => {
    const encrypted = encryptIdNumber('passport-4567');
    const parts = encrypted.split(':');
    parts[2] = Buffer.from('invalid-tag').toString('base64url');
    expect(() => decryptIdNumber(parts.join(':'))).toThrow();
  });
});
