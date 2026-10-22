import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';

describe('Phase 8 folios, payments, receipts and cashier shifts', () => {
  const app = createApp();
  let propertyId;
  let userId;
  let token;
  let businessDate;

  beforeAll(async () => {
    const [users] = await pool.execute(
      `SELECT u.id, u.organization_id, u.role_id, up.property_id, r.name
       FROM users u
       JOIN roles r ON r.id = u.role_id
       JOIN user_properties up ON up.user_id = u.id
       WHERE u.email = 'owner@smarthotel.local' LIMIT 1`,
    );
    if (!users.length) throw new Error('Finance tests require the seeded owner account');
    const owner = users[0];
    userId = Number(owner.id);
    propertyId = Number(owner.property_id);
    token = jwt.sign({
      orgId: Number(owner.organization_id),
      role: owner.name,
      propertyIds: [propertyId],
      activePropertyId: propertyId,
    }, env.JWT_ACCESS_SECRET, { subject: String(userId), expiresIn: '10m' });
    const [properties] = await pool.execute(
      'SELECT business_date FROM properties WHERE id = ?',
      [propertyId],
    );
    businessDate = String(properties[0].business_date).slice(0, 10);
  });

  function authorized(path) {
    return request(app)[path[0]](path[1]).set('Authorization', ['Bearer', token].join(' '));
  }

  function authorizedWithToken(customToken, path) {
    return request(app)[path[0]](path[1]).set('Authorization', ['Bearer', customToken].join(' '));
  }

  async function restoreRoom(roomId, status) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT status FROM rooms WHERE property_id = ? AND id = ? FOR UPDATE',
        [propertyId, roomId],
      );
      if (rows[0]?.status !== status) {
        await connection.execute(
          `INSERT INTO room_status_history
            (property_id, room_id, from_status, to_status, reason, changed_by, changed_at)
           VALUES (?, ?, ?, ?, 'Restore room after finance test', ?, NOW())`,
          [propertyId, roomId, rows[0]?.status ?? null, status, userId],
        );
        await connection.execute('SET @shms_housekeeping_transition = 1');
        await connection.execute(
          'UPDATE rooms SET status = ? WHERE property_id = ? AND id = ?',
          [status, propertyId, roomId],
        );
        await connection.execute('SET @shms_housekeeping_transition = 0');
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      await connection.execute('SET @shms_housekeeping_transition = 0');
      throw error;
    } finally {
      connection.release();
    }
  }

  function parseBinary(response, callback) {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => callback(null, Buffer.concat(chunks)));
  }

  it('posts split/idempotent payments, a refund and discount, then reconciles and closes the shift', async () => {
    const [rooms] = await pool.execute(
      `SELECT room.id, room.room_number, room.status, room.room_type_id
       FROM rooms room
       WHERE room.property_id = ? AND room.is_active = 1 AND room.deleted_at IS NULL
         AND room.status IN ('CLEAN', 'AVAILABLE_CLEAN')
         AND NOT EXISTS (
           SELECT 1 FROM room_nights nights
           JOIN reservations reservation ON reservation.id = nights.reservation_id
             AND reservation.property_id = nights.property_id
           WHERE nights.property_id = room.property_id AND nights.room_id = room.id
             AND nights.night = ? AND reservation.status IN ('tentative', 'confirmed', 'checked_in')
         )
         AND NOT EXISTS (
           SELECT 1 FROM maintenance_tickets ticket
           WHERE ticket.property_id = room.property_id AND ticket.room_id = room.id
             AND ticket.blocks_room = 1 AND ticket.status <> 'closed'
         )
       ORDER BY room.room_number LIMIT 1`,
      [propertyId, businessDate],
    );
    expect(rooms.length).toBeGreaterThan(0);
    const room = rooms[0];
    const [taskBaselineRows] = await pool.execute(
      'SELECT COALESCE(MAX(id), 0) AS id FROM housekeeping_tasks WHERE property_id = ?',
      [propertyId],
    );
    const taskBaseline = Number(taskBaselineRows[0].id);
    const walkIn = await authorized(['post', '/api/walk-ins'])
      .send({
        guest: {
          firstName: 'Finance',
          lastName: `Test ${Date.now()}`,
          idType: 'passport',
          idNumber: `FINANCE-${Date.now()}`,
        },
        roomId: Number(room.id),
      });
    expect(walkIn.status, JSON.stringify(walkIn.body)).toBe(201);
    const stayId = walkIn.body.data.stayId;
    const [folioRows] = await pool.execute(
      'SELECT id FROM folios WHERE property_id = ? AND stay_id = ?',
      [propertyId, stayId],
    );
    const folioId = Number(folioRows[0].id);
    let shiftId;
    try {
      const noShiftPayment = await authorized(['post', `/api/folios/${folioId}/payments`])
        .send({
          method: 'cash',
          amount: '1.00',
          idempotencyKey: `phase8-no-shift-${Date.now()}`,
        });
      expect(noShiftPayment.status).toBe(409);
      expect(noShiftPayment.body.error.code).toBe('CASHIER_SHIFT_REQUIRED');

      const openShift = await authorized(['post', '/api/cashier-shifts/open'])
        .send({ openingFloat: '10.00', notes: 'Phase 8 integration test' });
      expect(openShift.status).toBe(201);
      shiftId = Number(openShift.body.data.id);

      const charge = await authorized(['post', `/api/folios/${folioId}/charges`])
        .send({ type: 'service', description: 'Phase 8 test service', amount: '50.00' });
      expect(charge.status).toBe(201);

      const cashKey = `phase8-cash-${Date.now()}`;
      const cash = await authorized(['post', `/api/folios/${folioId}/payments`])
        .send({ method: 'cash', amount: '10.00', idempotencyKey: cashKey });
      expect(cash.status).toBe(201);
      const replay = await authorized(['post', `/api/folios/${folioId}/payments`])
        .send({ method: 'cash', amount: '10.00', idempotencyKey: cashKey });
      expect(replay.status).toBe(200);
      expect(replay.body.data).toMatchObject({
        paymentId: cash.body.data.paymentId,
        receiptId: cash.body.data.receiptId,
        receiptNumber: cash.body.data.receiptNumber,
        idempotentReplay: true,
      });
      expect(replay.body.data.receiptNumber).toMatch(/^RCP-\d{3}-\d{8}$/);

      const bank = await authorized(['post', `/api/folios/${folioId}/payments`])
        .send({
          method: 'bank_transfer',
          amount: '35.00',
          reference: `BANK-${Date.now()}`,
          idempotencyKey: `phase8-bank-${Date.now()}`,
        });
      expect(bank.status).toBe(201);

      const refund = await authorized(['post', `/api/folios/${folioId}/adjustment-requests`])
        .send({
          type: 'refund',
          amount: '5.00',
          reason: 'Partial refund test',
          paymentId: cash.body.data.paymentId,
        });
      expect(refund.status).toBe(201);
      expect(refund.body.data.status).toBe('approved');

      const cashRemainder = await authorized(['post', `/api/folios/${folioId}/payments`])
        .send({ method: 'cash', amount: '5.00', idempotencyKey: `phase8-cash-final-${Date.now()}` });
      expect(cashRemainder.status).toBe(201);
      const discount = await authorized(['post', `/api/folios/${folioId}/adjustment-requests`])
        .send({ type: 'discount', amount: '5.00', reason: 'Approved test discount' });
      expect(discount.status).toBe(201);

      const detail = await authorized(['get', `/api/folios/${folioId}`]);
      expect(detail.status).toBe(200);
      expect(detail.body.data).toMatchObject({
        totalCharges: '50.00',
        totalPayments: '45.00',
        totalAdjustments: '-5.00',
        balance: '0.00',
      });
      expect(detail.body.data.payments).toHaveLength(4);
      expect(detail.body.data.adjustments).toHaveLength(2);

      const closed = await authorized(['post', `/api/cashier-shifts/${shiftId}/close`])
        .send({ countedCash: '20.00', notes: 'Balanced test shift' });
      expect(closed.status).toBe(200);
      expect(closed.body.data).toMatchObject({
        status: 'closed',
        expectedCash: '20.00',
        countedCash: '20.00',
        variance: '0.00',
      });
      await expect(
        pool.execute('UPDATE cashier_shifts SET notes = ? WHERE property_id = ? AND id = ?', ['mutated', propertyId, shiftId]),
      ).rejects.toThrow(/immutable/i);
      const replayAfterClose = await authorized(['post', `/api/folios/${folioId}/payments`])
        .send({ method: 'cash', amount: '10.00', idempotencyKey: cashKey });
      expect(replayAfterClose.status).toBe(200);

      const checkout = await authorized(['post', `/api/stays/${stayId}/check-out`]).send({});
      expect(checkout.status).toBe(200);
      expect(checkout.body.data.invoice.number).toMatch(/^INV-\d{3}-\d{8}$/);
      const [invoiceRows] = await pool.execute(
        'SELECT id FROM invoices WHERE property_id = ? AND number = ?',
        [propertyId, checkout.body.data.invoice.number],
      );
      const invoiceId = Number(invoiceRows[0].id);
      const invoice = await authorized(['get', `/api/documents/invoices/${invoiceId}`]);
      expect(invoice.status).toBe(200);
      expect(invoice.body.data).toMatchObject({
        number: checkout.body.data.invoice.number,
        totals: { balance: '0.00' },
        duplicate: false,
      });
      const invoiceCopy = await authorized(['get', `/api/documents/invoices/${invoiceId}?reprint=1`]);
      expect(invoiceCopy.body.data.duplicate).toBe(true);
      const invoicePdf = await authorized(['get', `/api/documents/invoices/${invoiceId}/pdf`])
        .buffer(true)
        .parse(parseBinary);
      expect(invoicePdf.status).toBe(200);
      expect(invoicePdf.headers['content-type']).toContain('application/pdf');
      expect(invoicePdf.body.subarray(0, 5).toString()).toBe('%PDF-');
      const invoicePdfCopy = await authorized(['get', `/api/documents/invoices/${invoiceId}/pdf?reprint=1`])
        .buffer(true)
        .parse(parseBinary);
      expect(invoicePdfCopy.body.subarray(0, 5).toString()).toBe('%PDF-');

      const receiptCopy = await authorized(['get', `/api/documents/receipts/${cash.body.data.receiptId}?reprint=1`]);
      expect(receiptCopy.status).toBe(200);
      expect(receiptCopy.body.data).toMatchObject({
        number: cash.body.data.receiptNumber,
        duplicate: true,
      });
      const receiptPdf = await authorized(['get', `/api/documents/receipts/${cash.body.data.receiptId}/pdf`])
        .buffer(true)
        .parse(parseBinary);
      expect(receiptPdf.status).toBe(200);
      expect(receiptPdf.headers['content-type']).toContain('application/pdf');
      expect(receiptPdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    } finally {
      const [stayRows] = await pool.execute(
        'SELECT status, room_id FROM stays WHERE property_id = ? AND id = ?',
        [propertyId, stayId],
      );
      if (stayRows[0]?.status === 'in_house') {
        await authorized(['post', `/api/stays/${stayId}/check-out`])
          .send({ approveCredit: true, creditReason: 'Authorized finance test cleanup' });
      }
      const currentShift = await authorized(['get', '/api/cashier-shifts/current']);
      if (currentShift.body.data) {
        await authorized(['post', `/api/cashier-shifts/${currentShift.body.data.id}/close`])
          .send({ countedCash: currentShift.body.data.expectedCash, notes: 'Finance test cleanup' });
      }
      const [tasks] = await pool.execute(
        `SELECT id FROM housekeeping_tasks
         WHERE property_id = ? AND room_id = ? AND type = 'checkout_clean' AND source_rule = 'checkout'
           AND id > ?`,
        [propertyId, room.id, taskBaseline],
      );
      if (tasks[0]) {
        await pool.execute('DELETE FROM task_checklist_items WHERE property_id = ? AND task_id = ?', [propertyId, tasks[0].id]);
        await pool.execute('DELETE FROM housekeeping_tasks WHERE id = ?', [tasks[0].id]);
      }
      await restoreRoom(room.id, room.status);
    }
  }, 30000);

  it('posts each night-audit date once, includes configured tax, and advances the business date', async () => {
    const [ownerRows] = await pool.execute(
      `SELECT u.id, u.organization_id FROM users u
       WHERE u.email = 'owner@smarthotel.local' LIMIT 1`,
    );
    const owner = ownerRows[0];
    const [basePropertyRows] = await pool.execute(
      'SELECT timezone, currency, business_date FROM properties WHERE id = ?',
      [propertyId],
    );
    const auditDate = String(basePropertyRows[0].business_date).slice(0, 10);
    const checkout = new Date(`${auditDate}T00:00:00Z`);
    checkout.setUTCDate(checkout.getUTCDate() + 2);
    const checkoutDate = checkout.toISOString().slice(0, 10);
    const nextAuditDate = new Date(`${auditDate}T00:00:00Z`);
    nextAuditDate.setUTCDate(nextAuditDate.getUTCDate() + 1);
    const nextAuditDateText = nextAuditDate.toISOString().slice(0, 10);
    const [propertyResult] = await pool.execute(
      `INSERT INTO properties
        (organization_id, name, timezone, currency, business_date, tax_settings, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [
        owner.organization_id,
        `SHMS Phase 8 night audit test ${Date.now()}`,
        basePropertyRows[0].timezone,
        basePropertyRows[0].currency,
        auditDate,
        JSON.stringify({ vatPercent: 15, serviceChargePercent: 10, tourismLevyPercent: 2 }),
      ],
    );
    const auditPropertyId = Number(propertyResult.insertId);
    try {
      await pool.execute(
        'INSERT INTO user_properties (user_id, property_id) VALUES (?, ?)',
        [owner.id, auditPropertyId],
      );
      const [roomTypeResult] = await pool.execute(
        `INSERT INTO room_types
          (property_id, name, max_adults, max_children, base_rate, is_active)
         VALUES (?, 'Night Audit Test Room', 2, 1, '100.00', 1)`,
        [auditPropertyId],
      );
      const roomTypeId = Number(roomTypeResult.insertId);
      const [ratePlanResult] = await pool.execute(
        `INSERT INTO rate_plans (property_id, name, is_active)
         VALUES (?, 'Night Audit Test Plan', 1)`,
        [auditPropertyId],
      );
      const ratePlanId = Number(ratePlanResult.insertId);
      await pool.execute(
        `INSERT INTO rates
          (property_id, room_type_id, rate_plan_id, date_from, date_to, amount, min_stay)
         VALUES (?, ?, ?, ?, ?, '100.00', 1)`,
        [auditPropertyId, roomTypeId, ratePlanId, auditDate, checkoutDate],
      );
      const [roomResult] = await pool.execute(
        `INSERT INTO rooms
          (property_id, room_type_id, room_number, status, housekeeping_priority, is_active)
         VALUES (?, ?, 'NA-1', 'OCCUPIED', 0, 1)`,
        [auditPropertyId, roomTypeId],
      );
      const roomId = Number(roomResult.insertId);
      const [guestResult] = await pool.execute(
        `INSERT INTO guests (organization_id, property_id, first_name, last_name, is_vip)
         VALUES (?, ?, 'Night', 'Audit', 0)`,
        [owner.organization_id, auditPropertyId],
      );
      const guestId = Number(guestResult.insertId);
      const [reservationResult] = await pool.execute(
        `INSERT INTO reservations
          (property_id, confirmation_no, primary_guest_id, source, status, check_in_date, check_out_date,
           adults, children, room_type_id, assigned_room_id, rate_plan_id, total_estimate, created_by)
         VALUES (?, ?, ?, 'manual', 'checked_in', ?, ?, 1, 0, ?, ?, ?, '294.00', ?)`,
        [
          auditPropertyId, `NA-${Date.now()}`, guestId, auditDate, checkoutDate,
          roomTypeId, roomId, ratePlanId, owner.id,
        ],
      );
      const reservationId = Number(reservationResult.insertId);
      await pool.execute(
        `INSERT INTO reservation_rooms
          (property_id, reservation_id, room_type_id, room_id, adults, children, nightly_rate)
         VALUES (?, ?, ?, ?, 1, 0, '100.00')`,
        [auditPropertyId, reservationId, roomTypeId, roomId],
      );
      const [stayResult] = await pool.execute(
        `INSERT INTO stays (property_id, reservation_id, room_id, checked_in_at, status, key_card_count)
         VALUES (?, ?, ?, NOW(), 'in_house', 0)`,
        [auditPropertyId, reservationId, roomId],
      );
      const stayId = Number(stayResult.insertId);
      const [folioResult] = await pool.execute(
        `INSERT INTO folios (property_id, stay_id, guest_id, status, opened_at)
         VALUES (?, ?, ?, 'open', NOW())`,
        [auditPropertyId, stayId, guestId],
      );
      const folioId = Number(folioResult.insertId);
      const auditToken = jwt.sign({
        orgId: Number(owner.organization_id),
        role: 'owner_gm',
        propertyIds: [auditPropertyId],
        activePropertyId: auditPropertyId,
      }, env.JWT_ACCESS_SECRET, { subject: String(owner.id), expiresIn: '10m' });

      const run = await authorizedWithToken(auditToken, ['post', '/api/night-audit/run'])
        .send({ businessDate: auditDate });
      expect(run.status).toBe(200);
      expect(run.body.data).toMatchObject({
        businessDate: auditDate,
        nextBusinessDate: nextAuditDateText,
        postedStays: 1,
        totalAmount: '127.00',
      });
      const [charges] = await pool.execute(
        `SELECT charge_type, amount FROM folio_charges
         WHERE property_id = ? AND folio_id = ? ORDER BY id`,
        [auditPropertyId, folioId],
      );
      expect(charges).toEqual([
        { charge_type: 'room', amount: '100.00' },
        { charge_type: 'tax', amount: '15.00' },
        { charge_type: 'service_charge', amount: '10.00' },
        { charge_type: 'levy', amount: '2.00' },
      ]);
      const replay = await authorizedWithToken(auditToken, ['post', '/api/night-audit/run'])
        .send({ businessDate: auditDate });
      expect(replay.status).toBe(200);
      expect(replay.body.data.idempotentReplay).toBe(true);
      const [auditRuns] = await pool.execute(
        'SELECT id FROM night_audit_runs WHERE property_id = ? AND business_date = ?',
        [auditPropertyId, auditDate],
      );
      await expect(
        pool.execute(
          'UPDATE night_audit_runs SET posted_stays = 0 WHERE property_id = ? AND id = ?',
          [auditPropertyId, auditRuns[0].id],
        ),
      ).rejects.toThrow(/append-only/i);
      const [afterReplay] = await pool.execute(
        'SELECT COUNT(*) AS count FROM folio_charges WHERE property_id = ? AND folio_id = ?',
        [auditPropertyId, folioId],
      );
      expect(Number(afterReplay[0].count)).toBe(4);
      const [businessDateRows] = await pool.execute(
        'SELECT business_date FROM properties WHERE id = ?',
        [auditPropertyId],
      );
      expect(String(businessDateRows[0].business_date).slice(0, 10)).toBe(nextAuditDateText);
    } finally {
      await pool.execute('DELETE FROM user_properties WHERE property_id = ?', [auditPropertyId]);
      await pool.execute('UPDATE properties SET is_active = 0 WHERE id = ?', [auditPropertyId]);
    }
  }, 30000);
});
