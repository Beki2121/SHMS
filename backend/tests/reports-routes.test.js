import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';
import { clearPermissionCache } from '../src/auth/permissions.js';

describe('Phase 14 property reports', () => {
  const app = createApp();
  let propertyId;
  let organizationId;
  let ownerToken;
  let frontDeskToken;
  let businessDate;

  function tokenFor(userId, role) {
    return jwt.sign({
      orgId: organizationId,
      role,
      propertyIds: [propertyId],
      activePropertyId: propertyId,
    }, env.JWT_ACCESS_SECRET, { subject: String(userId), expiresIn: '10m' });
  }

  function authorized(token, path) {
    return request(app).get(path).set('Authorization', ['Bearer', token].join(' '));
  }

  beforeAll(async () => {
    clearPermissionCache();
    const [owners] = await pool.execute(
      `SELECT user.id, user.organization_id, membership.property_id, property.business_date
       FROM users user
       JOIN roles role ON role.id = user.role_id AND role.name = 'owner_gm'
       JOIN user_properties membership ON membership.user_id = user.id
       JOIN properties property ON property.id = membership.property_id
       WHERE user.email = 'owner@smarthotel.local' LIMIT 1`,
    );
    if (!owners[0]) throw new Error('Report tests require the seeded owner');
    propertyId = Number(owners[0].property_id);
    organizationId = Number(owners[0].organization_id);
    businessDate = String(owners[0].business_date).slice(0, 10);
    ownerToken = tokenFor(Number(owners[0].id), 'owner_gm');

    const [frontDeskUsers] = await pool.execute(
      `SELECT user.id FROM users user
       JOIN roles role ON role.id = user.role_id AND role.name = 'front_desk'
       JOIN user_properties membership ON membership.user_id = user.id
       WHERE membership.property_id = ? LIMIT 1`,
      [propertyId],
    );
    if (!frontDeskUsers[0]) throw new Error('Report tests require the seeded front-desk user');
    frontDeskToken = tokenFor(Number(frontDeskUsers[0].id), 'front_desk');
  });

  afterAll(async () => {
    clearPermissionCache();
  });

  it('reconciles reported folio revenue to the append-only charge ledger', async () => {
    const reportResponse = await authorized(ownerToken, `/api/reports?from=${businessDate}&to=${businessDate}`);
    expect(reportResponse.status, JSON.stringify(reportResponse.body)).toBe(200);
    expect(reportResponse.body.data.financial).toBeTruthy();

    const [charges] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM folio_charges
       WHERE property_id = ? AND business_date = ?`,
      [propertyId, businessDate],
    );
    expect(reportResponse.body.data.financial.revenue.total).toBe(Number(charges[0].total));
    expect(reportResponse.body.data.occupancy.adr).toBe(
      reportResponse.body.data.occupancy.occupiedRoomNights
        ? Number((reportResponse.body.data.financial.revenue.room
          / reportResponse.body.data.occupancy.occupiedRoomNights).toFixed(2))
        : 0,
    );

    const [balances] = await pool.execute(
      `SELECT COALESCE(SUM(balance), 0) AS total FROM (
         SELECT COALESCE((SELECT SUM(amount) FROM folio_charges charge
                          WHERE charge.property_id = folio.property_id AND charge.folio_id = folio.id), 0)
              - COALESCE((SELECT SUM(amount) FROM folio_payments payment
                          WHERE payment.property_id = folio.property_id AND payment.folio_id = folio.id), 0)
              + COALESCE((SELECT SUM(CASE type WHEN 'discount' THEN -amount WHEN 'write_off' THEN -amount
                                 WHEN 'correction' THEN amount ELSE 0 END)
                          FROM adjustments adjustment
                          WHERE adjustment.property_id = folio.property_id AND adjustment.folio_id = folio.id
                            AND adjustment.status = 'approved'), 0) AS balance
         FROM folios folio WHERE folio.property_id = ? AND folio.status = 'open'
       ) open_balances WHERE balance > 0`,
      [propertyId],
    );
    expect(reportResponse.body.data.financial.outstanding.total).toBe(Number(balances[0].total));
  });

  it('does not expose financial metrics or exports to non-financial report roles', async () => {
    const reportResponse = await authorized(frontDeskToken, '/api/reports');
    expect(reportResponse.status, JSON.stringify(reportResponse.body)).toBe(200);
    expect(reportResponse.body.data.financial).toBeNull();
    expect(reportResponse.body.data.occupancy.adr).toBeNull();
    expect(reportResponse.body.data.occupancy.revpar).toBeNull();

    const dashboardResponse = await authorized(frontDeskToken, '/api/reports/dashboard');
    expect(dashboardResponse.status).toBe(200);
    expect(dashboardResponse.body.data.dashboardRole).toBe('front_desk');
    expect(dashboardResponse.body.data.financial).toBeNull();

    const exportResponse = await authorized(frontDeskToken, `/api/reports/export?format=csv&from=${businessDate}&to=${businessDate}`);
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers['content-type']).toContain('text/csv');
    expect(exportResponse.text).not.toContain('Folio charges');
  });

  it('validates date ranges, enforces assigned-property scope, and renders a PDF export', async () => {
    const invalidDate = await authorized(ownerToken, '/api/reports?from=2026-02-30');
    expect(invalidDate.status).toBe(400);

    const reversedRange = await authorized(ownerToken, '/api/reports?from=2026-10-02&to=2026-10-01');
    expect(reversedRange.status).toBe(400);

    const unassignedProperty = await authorized(ownerToken, '/api/reports?propertyId=2147483647');
    expect(unassignedProperty.status).toBe(403);

    const pdf = await authorized(ownerToken, `/api/reports/export?format=pdf&from=${businessDate}&to=${businessDate}`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
  });
});
