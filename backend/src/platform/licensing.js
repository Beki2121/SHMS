import { readFile } from 'node:fs/promises';
import { createPublicKey, verify } from 'node:crypto';
import { env } from '../config/env.js';

const embeddedPublicKey = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAzw5LW98N8hwAqpRWC81oQEsJBEnubUMqOHpG/t20IA4=
-----END PUBLIC KEY-----`;
const gracePeriodMs = 14 * 24 * 60 * 60 * 1000;
const states = new Map();

function licenseResult(status, payload = null, warning = null) {
  return { status, payload, warning };
}

export function verifyLicense(document, {
  publicKey = env.LICENSE_PUBLIC_KEY || embeddedPublicKey,
  organizationId,
  installationId,
  now = Date.now(),
} = {}) {
  try {
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      return licenseResult('invalid', null, 'License document is invalid');
    }
    const { payload, signature } = document;
    if (!payload || typeof signature !== 'string') return licenseResult('invalid', null, 'License signature is missing');
    const validShape = Number.isInteger(payload.organizationId)
      && Number.isInteger(payload.maxRooms) && payload.maxRooms > 0
      && Number.isInteger(payload.maxUsers) && payload.maxUsers > 0
      && Array.isArray(payload.modules) && payload.modules.every((module) => typeof module === 'string')
      && typeof payload.expiresAt === 'string' && Number.isFinite(Date.parse(payload.expiresAt))
      && typeof payload.installationId === 'string' && payload.installationId.length > 0;
    if (!validShape) return licenseResult('invalid', null, 'License payload is invalid');
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519') {
      return licenseResult('invalid', null, 'License verification key must be Ed25519');
    }
    const signed = Buffer.from(JSON.stringify(payload));
    if (!verify(null, signed, key, Buffer.from(signature, 'base64'))) {
      return licenseResult('invalid', null, 'License signature verification failed');
    }
    if (payload.organizationId !== Number(organizationId)
      || payload.installationId !== installationId) {
      return licenseResult('invalid', null, 'License is for a different organization or installation');
    }
    const expiry = Date.parse(payload.expiresAt);
    if (expiry >= now) return licenseResult('active', payload);
    if (now - expiry <= gracePeriodMs) {
      return licenseResult('grace', payload, 'License has expired; renew within 14 days to avoid read-only mode');
    }
    return licenseResult('read_only', payload, 'License grace period has ended; the installation is read-only');
  } catch (error) {
    if (error?.code === 'ERR_OSSL_PEM_NO_START_LINE' || error?.code === 'ERR_INVALID_ARG_TYPE') {
      return licenseResult('invalid', null, 'License or verification key is invalid');
    }
    throw error;
  }
}

export async function initializeLicenses(db) {
  const [organizations] = await db.execute(
    `SELECT id, installation_id FROM organizations WHERE licence_mode = 'local'`,
  );
  states.clear();
  for (const organization of organizations) {
    let state;
    if (!env.LICENSE_FILE_PATH) {
      if (env.NODE_ENV !== 'production') continue;
      state = licenseResult('invalid', null, 'LICENSE_FILE_PATH is not configured');
    } else {
      try {
        const document = JSON.parse(await readFile(env.LICENSE_FILE_PATH, 'utf8'));
        state = verifyLicense(document, {
          organizationId: Number(organization.id),
          installationId: organization.installation_id,
        });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        if (env.NODE_ENV !== 'production') continue;
        state = licenseResult('invalid', null, 'License file is missing');
      }
    }
    states.set(Number(organization.id), state);
  }
  return states;
}

export function getLicenseState(organizationId) {
  const state = states.get(Number(organizationId));
  if (!state || !['active', 'grace'].includes(state.status) || !state.payload) return state ?? null;

  const expiry = Date.parse(state.payload.expiresAt);
  const now = Date.now();
  if (expiry >= now) return licenseResult('active', state.payload);
  if (now - expiry <= gracePeriodMs) {
    return licenseResult('grace', state.payload, 'License has expired; renew within 14 days to avoid read-only mode');
  }
  return licenseResult('read_only', state.payload, 'License grace period has ended; the installation is read-only');
}

export function checkLicenseWriteAccess(db) {
  return async (req, res, next) => {
    try {
      if (!req.auth?.orgId || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
      const plan = await (await import('./plans.js')).getOrganizationPlan(db, req.auth.orgId);
      if (['invalid', 'read_only'].includes(plan.licenseStatus)
        && !req.path.endsWith('/data-export')) {
        return res.status(403).json({
          error: {
            code: 'LICENSE_READ_ONLY',
            message: plan.warning ?? 'This local installation is read-only; customer data export remains available',
          },
        });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export function licensePublicKey() {
  return env.LICENSE_PUBLIC_KEY || embeddedPublicKey;
}
