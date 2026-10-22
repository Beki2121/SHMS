import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';

describe('property configuration API', () => {
  const app = createApp();
  let token;
  let roomTypeId;
  let ratePlanId;

  beforeAll(async () => {
    const [users] = await pool.execute(
      `SELECT u.id, u.organization_id, up.property_id, r.name AS role
       FROM users u
       JOIN roles r ON r.id = u.role_id
       JOIN user_properties up ON up.user_id = u.id
       WHERE u.email = 'owner@smarthotel.local' LIMIT 1`,
    );
    if (!users.length) throw new Error('Property tests require the seeded owner account');
    const user = users[0];
    token = jwt.sign(
      {
        orgId: Number(user.organization_id),
        role: user.role,
        propertyIds: [Number(user.property_id)],
        activePropertyId: Number(user.property_id),
      },
      env.JWT_ACCESS_SECRET,
      { subject: String(user.id), expiresIn: '5m' },
    );
    const [[roomTypes], [ratePlans]] = await Promise.all([
      pool.execute('SELECT id FROM room_types WHERE property_id = ? AND is_active = 1 LIMIT 1', [user.property_id]),
      pool.execute('SELECT id FROM rate_plans WHERE property_id = ? AND is_active = 1 LIMIT 1', [user.property_id]),
    ]);
    roomTypeId = Number(roomTypes[0].id);
    ratePlanId = Number(ratePlans[0].id);
  });

  it('returns the assigned property profile, configured rooms and rate plans', async () => {
    const profile = await request(app).get('/api/property').set('Authorization', `Bearer ${token}`);
    expect(profile.status).toBe(200);
    expect(profile.body.data.currency).toBe('ETB');
    expect(profile.body.data.taxSettings).toMatchObject({ vatPercent: 15, pricesTaxInclusive: false });

    const rack = await request(app).get('/api/property/rooms').set('Authorization', `Bearer ${token}`);
    expect(rack.status).toBe(200);
    expect(rack.body.data.length).toBeGreaterThanOrEqual(20);
    expect(rack.body.data.every((room) => room.roomNumber && room.roomType)).toBe(true);

    const plans = await request(app).get('/api/property/rate-plans').set('Authorization', `Bearer ${token}`);
    expect(plans.status).toBe(200);
    expect(plans.body.data.length).toBeGreaterThan(0);
  });

  it('rejects invalid time and tax precision instead of persisting invalid configuration', async () => {
    const profile = await request(app).get('/api/property').set('Authorization', `Bearer ${token}`);
    const invalidTax = await request(app)
      .put('/api/property')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...profile.body.data, taxSettings: { ...profile.body.data.taxSettings, vatPercent: 15.123 } });
    expect(invalidTax.status).toBe(400);

    const invalidTime = await request(app)
      .put('/api/property')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...profile.body.data, checkInTime: '25:00' });
    expect(invalidTime.status).toBe(400);
  });

  it('quotes the configured nightly price and taxes through the scoped API', async () => {
    const response = await request(app)
      .post('/api/property/rates/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        roomTypeId,
        ratePlanId,
        checkIn: '2099-01-01',
        checkOut: '2099-01-02',
        adults: 1,
        children: 0,
      });
    expect(response.status).toBe(200);
    expect(response.body.data.currency).toBe('ETB');
    expect(response.body.data.nightlyRates).toHaveLength(1);
    expect(response.body.data.nightlyRates[0]).toMatchObject({
      rateRuleId: expect.any(Number),
      vat: expect.any(String),
      total: expect.any(String),
    });
  });
});
