import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyLicense } from '../src/platform/licensing.js';

describe('offline Ed25519 license verification', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

  function signedDocument(payload) {
    return {
      payload,
      signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64'),
    };
  }

  const basePayload = {
    organizationId: 42,
    maxRooms: 100,
    maxUsers: 20,
    modules: ['reservations', 'reports'],
    expiresAt: '2030-01-01T00:00:00.000Z',
    installationId: 'installation-42',
  };
  const context = { publicKey: publicPem, organizationId: 42, installationId: 'installation-42' };

  it('accepts a valid signed license for this organization and installation', () => {
    expect(verifyLicense(signedDocument(basePayload), { ...context, now: Date.parse('2029-01-01') }))
      .toMatchObject({ status: 'active', payload: basePayload, warning: null });
  });

  it('rejects payload tampering and installation or organization mismatches', () => {
    const tampered = signedDocument(basePayload);
    tampered.payload.maxRooms = 101;
    expect(verifyLicense(tampered, context).status).toBe('invalid');
    expect(verifyLicense(signedDocument(basePayload), { ...context, organizationId: 43 }).status).toBe('invalid');
    expect(verifyLicense(signedDocument(basePayload), { ...context, installationId: 'other' }).status).toBe('invalid');
  });

  it('rejects missing documents and non-Ed25519 verification keys', () => {
    expect(verifyLicense(null, context)).toMatchObject({ status: 'invalid' });
    expect(verifyLicense({}, context)).toMatchObject({ status: 'invalid' });
    const { publicKey: rsaPublicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(verifyLicense(signedDocument(basePayload), {
      ...context,
      publicKey: rsaPublicKey.export({ type: 'spki', format: 'pem' }),
    })).toMatchObject({ status: 'invalid' });
  });

  it('warns during the 14-day grace window and becomes read-only after it', () => {
    const document = signedDocument({ ...basePayload, expiresAt: '2029-01-01T00:00:00.000Z' });
    expect(verifyLicense(document, { ...context, now: Date.parse('2029-01-10') }).status).toBe('grace');
    expect(verifyLicense(document, { ...context, now: Date.parse('2029-01-16') }).status).toBe('read_only');
  });
});
