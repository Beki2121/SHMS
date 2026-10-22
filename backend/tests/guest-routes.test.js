import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';

describe('guest management and privacy API', () => {
  const app = createApp();
  const guestIds = [];
  const companyIds = [];
  const groupIds = [];
  const requestIds = [];
  const folioIds = [];
  let propertyId;
  let token;

  beforeAll(async () => {
    const [users] = await pool.execute(
      `SELECT u.id, u.organization_id, up.property_id, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id
       JOIN user_properties up ON up.user_id = u.id
       WHERE u.email = 'owner@smarthotel.local' LIMIT 1`,
    );
    if (!users.length) throw new Error('Guest tests require the seeded owner account');
    const user = users[0];
    propertyId = Number(user.property_id);
    token = jwt.sign(
      {
        orgId: Number(user.organization_id),
        role: user.role,
        propertyIds: [propertyId],
        activePropertyId: propertyId,
      },
      env.JWT_ACCESS_SECRET,
      { subject: String(user.id), expiresIn: '5m' },
    );
  });

  afterAll(async () => {
    if (requestIds.length) {
      await pool.execute(`DELETE FROM guest_requests WHERE id IN (${requestIds.map(() => '?').join(',')})`, requestIds);
    }
    if (groupIds.length) {
      await pool.execute(`DELETE FROM group_guests WHERE group_id IN (${groupIds.map(() => '?').join(',')})`, groupIds);
      await pool.execute(`DELETE FROM groups WHERE id IN (${groupIds.map(() => '?').join(',')})`, groupIds);
    }
    if (companyIds.length) {
      await pool.execute(`DELETE FROM companies WHERE id IN (${companyIds.map(() => '?').join(',')})`, companyIds);
    }
    if (folioIds.length) {
      await pool.execute(`DELETE FROM folios WHERE id IN (${folioIds.map(() => '?').join(',')})`, folioIds);
    }
    if (guestIds.length) {
      await pool.execute(`DELETE FROM guests WHERE id IN (${guestIds.map(() => '?').join(',')})`, guestIds);
    }
  });

  async function createGuest(firstName, overrides = {}) {
    const response = await request(app)
      .post('/api/guests')
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName, lastName: 'Phase Five', ...overrides });
    expect(response.status).toBe(201);
    guestIds.push(response.body.data.id);
    return response.body.data;
  }

  it('encrypts IDs, masks default responses, detects duplicates, and audits reveal/export', async () => {
    const idNumber = `P5-ID-${Date.now()}`;
    const created = await createGuest('Privacy', { idType: 'passport', idNumber, email: `privacy-${Date.now()}@example.test` });
    expect(created.idNumber).toMatch(/^\*{4}/);
    const [[stored]] = await pool.execute(
      'SELECT id_number_enc, id_number_hash, id_number_last4 FROM guests WHERE id = ?',
      [created.id],
    );
    expect(stored.id_number_enc).not.toContain(idNumber);
    expect(stored.id_number_enc).not.toBe(idNumber);
    expect(stored.id_number_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.id_number_last4).toBe(idNumber.replace(/[^A-Z0-9]/gi, '').slice(-4));

    const duplicate = await request(app)
      .post('/api/guests')
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName: 'Possible', lastName: 'Duplicate', idType: 'passport', idNumber });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('POSSIBLE_DUPLICATE');
    expect(duplicate.body.error.duplicateGuestId).toBe(created.id);

    const reveal = await request(app)
      .post(`/api/guests/${created.id}/reveal-id`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(reveal.status).toBe(200);
    expect(reveal.body.data.idNumber).toBe(idNumber);

    const profile = await request(app).get(`/api/guests/${created.id}`).set('Authorization', `Bearer ${token}`);
    expect(profile.status).toBe(200);
    expect(profile.body.data.idNumber).not.toBe(idNumber);
    const exported = await request(app)
      .post(`/api/guests/${created.id}/export`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(exported.status).toBe(200);
    expect(exported.body.data.idNumber).toBe(idNumber);

    const [auditRows] = await pool.execute(
      `SELECT action, \`after\` AS audit_after FROM audit_log
       WHERE entity = 'guest' AND entity_id = ? AND action IN ('guest.id.reveal', 'guest.data.export')`,
      [String(created.id)],
    );
    expect(auditRows.map((row) => row.action).sort()).toEqual(['guest.data.export', 'guest.id.reveal']);
    expect(JSON.stringify(auditRows)).not.toContain(idNumber);
  });

  it('manages companies, group membership, assigned guest requests and retention settings', async () => {
    const guest = await createGuest('GroupMember');
    const company = await request(app)
      .post('/api/companies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: `Phase Five Company ${Date.now()}`,
        tin: 'TIN-TEST',
        contact: { name: 'Test Contact', email: 'contact@example.test', phone: '+251900000001' },
        creditTerms: 'Net 30',
      });
    expect(company.status).toBe(201);
    companyIds.push(company.body.data.id);
    const companies = await request(app).get('/api/companies').set('Authorization', `Bearer ${token}`);
    expect(companies.body.data.some((item) => item.id === company.body.data.id)).toBe(true);

    const group = await request(app)
      .post('/api/guest-groups')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `Phase Five Group ${Date.now()}`, leaderGuestId: guest.id, guestIds: [guest.id] });
    expect(group.status).toBe(201);
    groupIds.push(group.body.data.id);
    const groups = await request(app).get('/api/guest-groups').set('Authorization', `Bearer ${token}`);
    expect(groups.body.data.find((item) => item.id === group.body.data.id).members).toEqual([
      { id: guest.id, name: 'GroupMember Phase Five' },
    ]);

    const guestRequest = await request(app)
      .post('/api/guest-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ guestId: guest.id, type: 'Pillow request', description: 'Additional pillow' });
    expect(guestRequest.status).toBe(201);
    requestIds.push(guestRequest.body.data.id);
    const invalidTransition = await request(app)
      .patch(`/api/guest-requests/${guestRequest.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'resolved' });
    expect(invalidTransition.status).toBe(409);
    const update = await request(app)
      .patch(`/api/guest-requests/${guestRequest.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'in_progress' });
    expect(update.status).toBe(200);
    const resolve = await request(app)
      .patch(`/api/guest-requests/${guestRequest.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'resolved' });
    expect(resolve.status).toBe(200);
    const requests = await request(app).get('/api/guest-requests?status=resolved').set('Authorization', `Bearer ${token}`);
    expect(requests.body.data.find((item) => item.id === guestRequest.body.data.id).status).toBe('resolved');

    const policy = await request(app)
      .put('/api/guests/privacy-settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ retentionDays: 730 });
    expect(policy.status).toBe(200);
    expect(policy.body.data.retentionDays).toBe(730);
    const privacy = await request(app).get('/api/guests/privacy-settings').set('Authorization', `Bearer ${token}`);
    expect(privacy.body.data.retentionDays).toBe(730);
  });

  it('anonymises personal data without changing folio ownership or financial totals, and merges references', async () => {
    const anonymizeMe = await createGuest('AnonymizeMe', { phone: '+251 911 000 111', email: 'anonymize@example.test' });
    const [folioResult] = await pool.execute(
      `INSERT INTO folios (property_id, guest_id, status, opened_at)
       VALUES (?, ?, 'open', CURRENT_TIMESTAMP)`,
      [propertyId, anonymizeMe.id],
    );
    folioIds.push(Number(folioResult.insertId));
    const [beforeTotals] = await pool.execute(
      `SELECT COUNT(*) AS charges, COALESCE(SUM(amount), 0) AS amount
       FROM folio_charges WHERE folio_id = ?`,
      [folioResult.insertId],
    );
    const anonymized = await request(app)
      .post(`/api/guests/${anonymizeMe.id}/anonymize`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Retention request completed' });
    expect(anonymized.status).toBe(200);
    const [[guestRow]] = await pool.execute(
      `SELECT first_name, last_name, phone, email, id_number_enc, id_number_hash, anonymised_at
       FROM guests WHERE id = ?`,
      [anonymizeMe.id],
    );
    expect(guestRow).toMatchObject({ first_name: 'Anonymous', last_name: 'Guest', phone: null, email: null, id_number_enc: null, id_number_hash: null });
    expect(guestRow.anonymised_at).toBeTruthy();
    const [[folioRow]] = await pool.execute('SELECT guest_id FROM folios WHERE id = ?', [folioResult.insertId]);
    const [afterTotals] = await pool.execute(
      `SELECT COUNT(*) AS charges, COALESCE(SUM(amount), 0) AS amount
       FROM folio_charges WHERE folio_id = ?`,
      [folioResult.insertId],
    );
    expect(Number(folioRow.guest_id)).toBe(anonymizeMe.id);
    expect(afterTotals[0]).toEqual(beforeTotals[0]);

    const source = await createGuest('MergeSource');
    const target = await createGuest('MergeTarget');
    const merge = await request(app)
      .post(`/api/guests/${source.id}/merge`)
      .set('Authorization', `Bearer ${token}`)
      .send({ targetGuestId: target.id, reason: 'Confirmed duplicate records' });
    expect(merge.status).toBe(200);
    const [[sourceRow]] = await pool.execute('SELECT deleted_at, anonymised_at FROM guests WHERE id = ?', [source.id]);
    expect(sourceRow.deleted_at).toBeTruthy();
    expect(sourceRow.anonymised_at).toBeTruthy();
  });
});
