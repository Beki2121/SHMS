import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';
import { clearPermissionCache } from '../src/auth/permissions.js';

describe('Phase 15 platform administration', () => {
  const app = createApp();
  let superAdminToken;

  beforeAll(async () => {
    clearPermissionCache();
    const [users] = await pool.execute(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name = 'super_admin' AND u.organization_id IS NULL LIMIT 1`,
    );
    if (!users[0]) throw new Error('Platform tests require the seeded super-admin account');
    superAdminToken = jwt.sign({
      orgId: null,
      role: 'super_admin',
      propertyIds: [],
      activePropertyId: null,
    }, env.JWT_ACCESS_SECRET, { subject: String(users[0].id), expiresIn: '10m' });

    const unapprovedGuestRead = await request(app).get('/api/guests')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(unapprovedGuestRead.status).toBe(403);
  });

  it('creates organizations, bounds and revokes support sessions, and keeps export available', async () => {
    const [packages] = await pool.execute("SELECT id FROM packages WHERE name = 'Enterprise' LIMIT 1");
    expect(packages[0]).toBeTruthy();
    const organizationResponse = await request(app).post('/api/platform/organizations')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        name: `Platform test ${Date.now()}`,
        packageId: Number(packages[0].id),
        licenseMode: 'cloud',
        property: { name: 'Platform test property', city: 'Addis Ababa' },
        owner: {
          name: 'Platform test owner',
          email: `platform-test-${Date.now()}@example.test`,
          password: 'PlatformTestPassword!42',
        },
      });
    expect(organizationResponse.status, JSON.stringify(organizationResponse.body)).toBe(201);
    const organizationId = organizationResponse.body.data.organizationId;

    const [owners] = await pool.execute(
      `SELECT u.id, u.role_id, up.property_id
       FROM users u
       JOIN roles r ON r.id = u.role_id AND r.name = 'owner_gm'
       JOIN user_properties up ON up.user_id = u.id
       WHERE u.organization_id = ? LIMIT 1`,
      [organizationId],
    );
    expect(owners[0]).toBeTruthy();
    const propertyId = Number(owners[0].property_id);
    const ownerToken = jwt.sign({
      orgId: Number(organizationId),
      role: 'owner_gm',
      propertyIds: [propertyId],
      activePropertyId: propertyId,
    }, env.JWT_ACCESS_SECRET, { subject: String(owners[0].id), expiresIn: '10m' });

    const supportRequest = await request(app).post('/api/platform/support-requests')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        organizationId,
        propertyId,
        reason: 'Review the customer reported reservation issue',
        durationMinutes: 30,
      });
    expect(supportRequest.status, JSON.stringify(supportRequest.body)).toBe(201);
    const requestId = supportRequest.body.data.id;

    const approval = await request(app).post(`/api/platform/support-requests/${requestId}/decision`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ decision: 'approved' });
    expect(approval.status).toBe(204);

    const activation = await request(app).post(`/api/platform/support-requests/${requestId}/activate`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({});
    expect(activation.status, activation.text).toBe(200);
    const supportToken = activation.body.data.accessToken;

    const guestRead = await request(app).get('/api/guests')
      .set('Authorization', `Bearer ${supportToken}`);
    expect(guestRead.status).toBe(200);

    const guestWrite = await request(app).post('/api/guests')
      .set('Authorization', `Bearer ${supportToken}`)
      .send({});
    expect(guestWrite.status).toBe(403);
    expect(guestWrite.body.error.code).toBe('SUPPORT_READ_ONLY');

    const supportExport = await request(app).get('/api/platform/data-export?format=json')
      .set('Authorization', `Bearer ${supportToken}`);
    expect(supportExport.status).toBe(403);
    expect(supportExport.body.error.code).toBe('SUPPORT_READ_ONLY');
    const supportApprovalMutation = await request(app).post(`/api/platform/support-requests/${requestId}/decision`)
      .set('Authorization', `Bearer ${supportToken}`)
      .send({ decision: 'denied' });
    expect(supportApprovalMutation.status).toBe(403);
    expect(supportApprovalMutation.body.error.code).toBe('SUPPORT_READ_ONLY');

    const revoke = await request(app).post(`/api/platform/support-requests/${requestId}/revoke`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});
    expect(revoke.status).toBe(204);
    const revokedRead = await request(app).get('/api/guests')
      .set('Authorization', `Bearer ${supportToken}`);
    expect(revokedRead.status).toBe(401);

    const essential = await pool.execute("SELECT id FROM packages WHERE name = 'Essential' LIMIT 1");
    const downgrade = await request(app).patch(`/api/platform/organizations/${organizationId}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ packageId: Number(essential[0][0].id) });
    expect(downgrade.status).toBe(204);
    const disabledModule = await request(app).get('/api/maintenance')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(disabledModule.status).toBe(403);
    expect(disabledModule.body.error.code).toBe('MODULE_DISABLED');

    const cancel = await request(app).patch(`/api/platform/organizations/${organizationId}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ subscriptionStatus: 'cancelled' });
    expect(cancel.status).toBe(204);
    const cancelledRead = await request(app).get('/api/guests')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(cancelledRead.status).toBe(403);
    expect(cancelledRead.body.error.code).toBe('SUBSCRIPTION_CANCELLED');
    const cancelledExport = await request(app).get('/api/platform/data-export?format=json')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(cancelledExport.status).toBe(200);

    const suspend = await request(app).patch(`/api/platform/organizations/${organizationId}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ status: 'suspended' });
    expect(suspend.status).toBe(204);
    const suspendedRead = await request(app).get('/api/guests')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(suspendedRead.status).toBe(403);
    expect(suspendedRead.body.error.code).toBe('ORGANIZATION_UNAVAILABLE');
    const session = await request(app).get('/api/auth/me')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(session.status).toBe(200);
    const exportResponse = await request(app).get('/api/platform/data-export?format=json')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(exportResponse.status, JSON.stringify(exportResponse.body)).toBe(200);
    expect(exportResponse.body.data).toHaveProperty('role_permissions');
    expect(exportResponse.body.data).toHaveProperty('user_properties');
    expect(exportResponse.body.data).toHaveProperty('permissions');
    expect(exportResponse.body.data).toHaveProperty('packages');
    expect(exportResponse.body.data.users[0]).not.toHaveProperty('password_hash');
    expect(exportResponse.body.data).not.toHaveProperty('refresh_tokens');
    const csvExport = await request(app).get('/api/platform/data-export?format=csv')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(csvExport.status).toBe(200);
    expect(csvExport.headers['content-type']).toContain('text/csv');
  });
});
