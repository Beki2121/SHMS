import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

describe('authentication lifecycle', () => {
  const app = createApp();
  const email = `auth-test-${randomUUID()}@smarthotel.local`;
  const password = 'TestPassword123!';
  let userId;
  let organizationId;
  let roleId;
  let propertyId;

  beforeAll(async () => {
    const [rows] = await pool.execute(
      `SELECT u.organization_id, u.role_id, up.property_id
       FROM users u
       JOIN user_properties up ON up.user_id = u.id
       WHERE u.organization_id IS NOT NULL LIMIT 1`,
    );
    if (!rows.length) throw new Error('Authentication tests require the seeded database fixture');
    organizationId = Number(rows[0].organization_id);
    roleId = Number(rows[0].role_id);
    propertyId = Number(rows[0].property_id);
    const passwordHash = await bcrypt.hash(password, 12);
    const [result] = await pool.execute(
      `INSERT INTO users
        (organization_id, name, email, password_hash, role_id, is_active)
       VALUES (?, 'Authentication Test User', ?, ?, ?, 1)`,
      [organizationId, email, passwordHash, roleId],
    );
    userId = result.insertId;
    await pool.execute(
      'INSERT INTO user_properties (user_id, property_id) VALUES (?, ?)',
      [userId, propertyId],
    );
  });

  afterAll(async () => {
    if (userId) {
      await pool.execute('DELETE FROM refresh_tokens WHERE user_id = ?', [userId]);
      await pool.execute('DELETE FROM user_properties WHERE user_id = ?', [userId]);
      await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
    }
  });

  it('issues short-lived access tokens and detects refresh-token reuse', async () => {
    const login = await request(app).post('/api/auth/login').send({ email, password });
    expect(login.status).toBe(200);
    expect(login.body.data.accessToken).toBeTruthy();
    expect(login.body.data.user.email).toBe(email);
    const initialCookie = login.headers['set-cookie'][0].split(';')[0];
    const initialToken = decodeURIComponent(initialCookie.slice('smarthotel_refresh='.length));

    const refresh = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', initialCookie)
      .send({});
    expect(refresh.status).toBe(200);
    const rotatedCookie = refresh.headers['set-cookie'][0].split(';')[0];

    const reuse = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: initialToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('REFRESH_REUSE_DETECTED');

    const revokedDescendant = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', rotatedCookie)
      .send({});
    expect(revokedDescendant.status).toBe(401);
  });

  it('locks an account after five failed login attempts for the lockout interval', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(app).post('/api/auth/login').send({ email, password: 'incorrect-password' });
      expect(response.status).toBe(401);
    }
    const locked = await request(app).post('/api/auth/login').send({ email, password });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
  });
});
