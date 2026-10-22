import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';
import { clearPermissionCache } from '../src/auth/permissions.js';

describe('Phase 13 notifications and idempotent automation', () => {
  const app = createApp();
  let propertyId;
  let organizationId;
  let ownerId;
  let frontDeskId;
  let ownerToken;
  let frontDeskToken;
  let arrivalId;
  let noShowId;
  let departureReservationId;
  let departureStayId;
  let overdueTaskId;
  let ticketId;
  let adjustmentId;
  let inventoryItemId;
  let positiveFolioId;
  let businessDate;
  let roomId;
  let roomTypeId;

  function tokenFor(userId, role) {
    return jwt.sign({
      orgId: organizationId,
      role,
      propertyIds: [propertyId],
      activePropertyId: propertyId,
    }, env.JWT_ACCESS_SECRET, { subject: String(userId), expiresIn: '10m' });
  }

  function authorized(token, method, path) {
    return request(app)[method](path).set('Authorization', `Bearer ${token}`);
  }

  function dateOffset(date, days) {
    const value = new Date(`${String(date).slice(0, 10)}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  }

  async function insertReservation(confirmationNo, status, checkIn, checkOut) {
    const [result] = await pool.execute(
      `INSERT INTO reservations
        (property_id, confirmation_no, status, check_in_date, check_out_date,
         adults, children, room_type_id, total_estimate, created_by)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, '100.00', ?)`,
      [propertyId, confirmationNo, status, checkIn, checkOut, roomTypeId, ownerId],
    );
    return Number(result.insertId);
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
    if (!owners[0]) throw new Error('Automation tests require the seeded owner');
    propertyId = Number(owners[0].property_id);
    organizationId = Number(owners[0].organization_id);
    ownerId = Number(owners[0].id);
    businessDate = String(owners[0].business_date).slice(0, 10);
    ownerToken = tokenFor(ownerId, 'owner_gm');

    const [frontDeskUsers] = await pool.execute(
      `SELECT user.id FROM users user
       JOIN roles role ON role.id = user.role_id AND role.name = 'front_desk'
       JOIN user_properties membership ON membership.user_id = user.id
       WHERE membership.property_id = ? LIMIT 1`,
      [propertyId],
    );
    if (!frontDeskUsers[0]) throw new Error('Automation tests require a seeded front-desk user');
    frontDeskId = Number(frontDeskUsers[0].id);
    frontDeskToken = tokenFor(frontDeskId, 'front_desk');

    const [rooms] = await pool.execute(
      `SELECT id, room_type_id FROM rooms WHERE property_id = ? AND is_active = 1 ORDER BY id LIMIT 1`,
      [propertyId],
    );
    if (!rooms[0]) throw new Error('Automation tests require a seeded room');
    roomId = Number(rooms[0].id);
    roomTypeId = Number(rooms[0].room_type_id);
    const [folios] = await pool.execute(
      `SELECT folio.id, folio.guest_id FROM folios folio
       WHERE folio.property_id = ? AND folio.status = 'open'
         AND (SELECT COALESCE(SUM(amount), 0) FROM folio_charges charge
              WHERE charge.property_id = folio.property_id AND charge.folio_id = folio.id)
           - (SELECT COALESCE(SUM(amount), 0) FROM folio_payments payment
              WHERE payment.property_id = folio.property_id AND payment.folio_id = folio.id)
           + (SELECT COALESCE(SUM(CASE type WHEN 'discount' THEN -amount WHEN 'write_off' THEN -amount
                              WHEN 'correction' THEN amount ELSE 0 END), 0)
              FROM adjustments adjustment
              WHERE adjustment.property_id = folio.property_id AND adjustment.folio_id = folio.id
                AND adjustment.status = 'approved') > 0
       ORDER BY folio.id LIMIT 1`,
      [propertyId],
    );
    if (!folios[0]) throw new Error('Automation tests require an existing open folio with a positive balance');
    positiveFolioId = Number(folios[0].id);

    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    arrivalId = await insertReservation(
      `AUTO-ARR-${suffix}`, 'confirmed', dateOffset(businessDate, 1), dateOffset(businessDate, 2),
    );
    noShowId = await insertReservation(
      `AUTO-NS-${suffix}`, 'confirmed', dateOffset(businessDate, -1), dateOffset(businessDate, 1),
    );
    departureReservationId = await insertReservation(
      `AUTO-DEP-${suffix}`, 'checked_in', dateOffset(businessDate, -1), dateOffset(businessDate, 1),
    );
    const [stay] = await pool.execute(
      `INSERT INTO stays (property_id, reservation_id, room_id, checked_in_at, status, key_card_count)
       VALUES (?, ?, ?, UTC_TIMESTAMP(), 'in_house', 1)`,
      [propertyId, departureReservationId, roomId],
    );
    departureStayId = Number(stay.insertId);

    const [task] = await pool.execute(
      `INSERT INTO housekeeping_tasks (property_id, room_id, type, priority, status, due_at)
       VALUES (?, ?, 'daily_clean', 3, 'pending', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR))`,
      [propertyId, roomId],
    );
    overdueTaskId = Number(task.insertId);

    const [ticket] = await pool.execute(
      `INSERT INTO maintenance_tickets
        (property_id, room_id, category, priority, description, status, blocks_room, opened_at)
       VALUES (?, ?, 'automation test', 'high', 'Phase 13 automation fixture', 'open', 1, UTC_TIMESTAMP())`,
      [propertyId, roomId],
    );
    ticketId = Number(ticket.insertId);

    const [adjustment] = await pool.execute(
      `INSERT INTO adjustment_requests
        (property_id, folio_id, type, amount, reason, requested_by, status)
       VALUES (?, ?, 'discount', '1000.00', 'Phase 13 unusual adjustment fixture', ?, 'pending')`,
      [propertyId, positiveFolioId, ownerId],
    );
    adjustmentId = Number(adjustment.insertId);

    const [item] = await pool.execute(
      `INSERT INTO inventory_items (property_id, name, unit, quantity, reorder_level)
       VALUES (?, ?, 'piece', '0.000', '2.000')`,
      [propertyId, `Automation low stock ${suffix}`],
    );
    inventoryItemId = Number(item.insertId);
  });

  afterAll(async () => {
    if (!propertyId) return;
    if (inventoryItemId) await pool.execute('DELETE FROM inventory_items WHERE property_id = ? AND id = ?', [propertyId, inventoryItemId]);
    if (adjustmentId) await pool.execute('DELETE FROM adjustment_requests WHERE property_id = ? AND id = ?', [propertyId, adjustmentId]);
    if (ticketId) await pool.execute('DELETE FROM maintenance_tickets WHERE property_id = ? AND id = ?', [propertyId, ticketId]);
    if (overdueTaskId) await pool.execute('DELETE FROM housekeeping_tasks WHERE property_id = ? AND id = ?', [propertyId, overdueTaskId]);
    if (departureStayId) await pool.execute('DELETE FROM stays WHERE property_id = ? AND id = ?', [propertyId, departureStayId]);
    for (const id of [arrivalId, noShowId, departureReservationId]) {
      if (id) await pool.execute('DELETE FROM reservations WHERE property_id = ? AND id = ?', [propertyId, id]);
    }
  });

  it('runs the eight scheduled rules once per match, explains results, and scopes notifications', async () => {
    const forbidden = await authorized(frontDeskToken, 'get', '/api/automation/rules');
    expect(forbidden.status).toBe(403);
    const definitions = await authorized(ownerToken, 'get', '/api/automation/rules');
    expect(definitions.status).toBe(200);
    expect(definitions.body.data.filter((rule) => rule.mode === 'scheduled')).toHaveLength(8);
    expect(definitions.body.data.find((rule) => rule.key === 'arrival_reminder').config.daysAhead).toBe(1);

    const firstRun = await authorized(ownerToken, 'post', '/api/automation/run').send({});
    expect(firstRun.status).toBe(200);
    expect(firstRun.body.data.results.filter((rule) => rule.mode === 'scheduled')).toHaveLength(8);
    expect(firstRun.body.data.results.find((rule) => rule.ruleKey === 'arrival_reminder').notificationsCreated).toBeGreaterThanOrEqual(1);
    const secondRun = await authorized(ownerToken, 'post', '/api/automation/run').send({});
    expect(secondRun.status).toBe(200);

    const expectedMatches = [
      ['arrival_reminder', 'reservation', arrivalId],
      ['departure_reminder', 'stay', departureStayId],
      ['overdue_tasks', 'housekeeping_task', overdueTaskId],
      ['blocking_ticket', 'maintenance_ticket', ticketId],
      ['outstanding_balance', 'folio', positiveFolioId],
      ['unusual_adjustment', 'adjustment_request', adjustmentId],
      ['no_show_candidates', 'reservation', noShowId],
      ['low_stock', 'inventory_item', inventoryItemId],
    ];
    for (const [ruleKey, entity, entityId] of expectedMatches) {
      const [logs] = await pool.execute(
        `SELECT id, result, dedupe_key FROM automation_log
         WHERE property_id = ? AND rule_key = ? AND entity = ? AND entity_id = ?`,
        [propertyId, ruleKey, entity, String(entityId)],
      );
      expect(logs, `${ruleKey} log`).toHaveLength(1);
      const [notifications] = await pool.execute(
        'SELECT id, payload, dedupe_key FROM notifications WHERE property_id = ? AND dedupe_key = ?',
        [propertyId, logs[0].dedupe_key],
      );
      expect(notifications, `${ruleKey} notification`).toHaveLength(1);
      const payload = typeof notifications[0].payload === 'string'
        ? JSON.parse(notifications[0].payload)
        : notifications[0].payload;
      expect(payload.reason).toEqual(expect.any(String));
      expect(payload.criteria).toBeTruthy();
      expect(payload.observed).toBeTruthy();
    }

    const inbox = await authorized(frontDeskToken, 'get', '/api/notifications?unreadOnly=true');
    expect(inbox.status).toBe(200);
    expect(inbox.body.data.notifications.some((notification) => notification.type === 'arrival_reminder')).toBe(true);
    expect(inbox.body.data.notifications.some((notification) => notification.type === 'low_stock')).toBe(false);

    const arrivalNotice = inbox.body.data.notifications.find((notification) => notification.type === 'arrival_reminder');
    const read = await authorized(frontDeskToken, 'patch', `/api/notifications/${arrivalNotice.id}/read`).send({});
    expect(read.status).toBe(204);
    const readAgain = await authorized(frontDeskToken, 'patch', `/api/notifications/${arrivalNotice.id}/read`).send({});
    expect(readAgain.status).toBe(204);
    const inboxAfterRead = await authorized(frontDeskToken, 'get', '/api/notifications?unreadOnly=true');
    expect(inboxAfterRead.body.data.notifications.some((notification) => notification.id === arrivalNotice.id)).toBe(false);
  });

  it('validates rule updates and exposes append-only run history', async () => {
    const invalidConfig = await authorized(ownerToken, 'patch', '/api/automation/rules/arrival_reminder')
      .send({ config: { daysAhead: 31 } });
    expect(invalidConfig.status).toBe(400);
    const zeroThreshold = await authorized(ownerToken, 'patch', '/api/automation/rules/outstanding_balance')
      .send({ config: { minimumBalance: '0.00' } });
    expect(zeroThreshold.status).toBe(400);
    const eventRuleUpdate = await authorized(ownerToken, 'patch', '/api/automation/rules/checkout_housekeeping')
      .send({ enabled: false });
    expect(eventRuleUpdate.status).toBe(409);
    const logs = await authorized(ownerToken, 'get', '/api/automation/logs?limit=100');
    expect(logs.status).toBe(200);
    expect(logs.body.data.some((entry) => entry.ruleKey === 'low_stock' && entry.result.criteria)).toBe(true);
    if (overdueTaskId) {
      await expect(pool.execute(
        'UPDATE automation_log SET result = ? WHERE property_id = ? AND rule_key = ? AND entity_id = ?',
        ['{}', propertyId, 'overdue_tasks', String(overdueTaskId)],
      )).rejects.toThrow();
    }
  });
});
