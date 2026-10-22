import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';

describe('check-in, stay management and checkout API', () => {
  const server = createApp();
  let propertyId;
  let userId;
  let token;
  let businessDate;

  beforeAll(async () => {
    const [users] = await pool.execute(
      `SELECT u.id, u.organization_id, up.property_id, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id
       JOIN user_properties up ON up.user_id = u.id
       WHERE u.email = 'owner@smarthotel.local' LIMIT 1`,
    );
    if (!users.length) throw new Error('Stay tests require the seeded owner account');
    const user = users[0];
    propertyId = Number(user.property_id);
    userId = Number(user.id);
    token = jwt.sign({
      orgId: Number(user.organization_id),
      role: user.role,
      propertyIds: [propertyId],
      activePropertyId: propertyId,
    }, env.JWT_ACCESS_SECRET, { subject: String(userId), expiresIn: '10m' });
    const [properties] = await pool.execute('SELECT business_date FROM properties WHERE id = ?', [propertyId]);
    businessDate = String(properties[0].business_date).slice(0, 10);
  });

  function authHeader() {
    return ['Bearer', token].join(' ');
  }

  async function restoreRoom(roomId, status, reason) {
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
           VALUES (?, ?, ?, ?, ?, ?, NOW())`,
          [propertyId, roomId, rows[0]?.status ?? null, status, reason, userId],
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

  async function findCleanRoom() {
    const [rooms] = await pool.execute(
      `SELECT room.id, room.room_number, room.status
       FROM rooms room
       WHERE room.property_id = ? AND room.is_active = 1 AND room.deleted_at IS NULL
         AND room.status IN ('CLEAN', 'AVAILABLE_CLEAN')
         AND NOT EXISTS (
           SELECT 1 FROM room_nights rn
           JOIN reservations reservation ON reservation.id = rn.reservation_id
             AND reservation.property_id = rn.property_id
           WHERE rn.property_id = room.property_id AND rn.room_id = room.id AND rn.night = ?
             AND reservation.status IN ('tentative', 'confirmed', 'checked_in')
         )
         AND NOT EXISTS (
           SELECT 1 FROM maintenance_tickets ticket
           WHERE ticket.property_id = room.property_id AND ticket.room_id = room.id
             AND ticket.blocks_room = 1 AND ticket.status <> 'closed'
         )
       ORDER BY room.room_number LIMIT 1`,
      [propertyId, businessDate],
    );
    return rooms[0];
  }

  it('completes a walk-in through a blocked unpaid checkout and approved invoice', async () => {
    const room = await findCleanRoom();
    expect(room).toBeTruthy();
    const oldStatus = room.status;
    let stayId;
    let housekeepingTaskId;
    const walkIn = await request(server)
      .post('/api/walk-ins')
      .set('Authorization', authHeader())
      .send({
        guest: {
          firstName: 'Phase',
          lastName: `Seven ${Date.now()}`,
          phone: '+251900000777',
          idType: 'passport',
          idNumber: `STAY-WALKIN-${Date.now()}`,
        },
        roomId: Number(room.id),
        adults: 1,
        children: 0,
      });
    expect(walkIn.status, JSON.stringify(walkIn.body)).toBe(201);
    expect(walkIn.body.data).toMatchObject({ roomNumber: room.room_number });
    stayId = walkIn.body.data.stayId;

    const [stayRows] = await pool.execute(
      `SELECT stay.status, room.status AS room_status, folio.status AS folio_status
       FROM stays stay JOIN rooms room ON room.id = stay.room_id AND room.property_id = stay.property_id
       JOIN folios folio ON folio.stay_id = stay.id AND folio.property_id = stay.property_id
       WHERE stay.property_id = ? AND stay.id = ?`,
      [propertyId, stayId],
    );
    expect(stayRows[0]).toMatchObject({ status: 'in_house', room_status: 'OCCUPIED', folio_status: 'open' });

    const [folios] = await pool.execute('SELECT id FROM folios WHERE property_id = ? AND stay_id = ?', [propertyId, stayId]);
    await pool.execute(
      `INSERT INTO folio_charges
        (property_id, folio_id, charge_type, description, quantity, unit_amount, amount, business_date, posted_by)
       VALUES (?, ?, 'other', 'Stay test balance', 1, '25.00', '25.00', ?, ?)`,
      [propertyId, folios[0].id, businessDate, userId],
    );
    const blocked = await request(server)
      .post(`/api/stays/${stayId}/check-out`)
      .set('Authorization', authHeader())
      .send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('FOLIO_BALANCE_DUE');

    const checkedOut = await request(server)
      .post(`/api/stays/${stayId}/check-out`)
      .set('Authorization', authHeader())
      .send({ approveCredit: true, creditReason: 'Approved city ledger for stay test' });
    expect(checkedOut.status).toBe(200);
    expect(checkedOut.body.data).toMatchObject({
      status: 'checked_out',
      roomStatus: 'AWAITING_CLEANING',
      invoice: { totals: { balance: '25.00', creditApproved: true } },
    });

    const [tasks] = await pool.execute(
      `SELECT id FROM housekeeping_tasks
       WHERE property_id = ? AND room_id = ? AND type = 'checkout_clean' AND source_rule = 'checkout'
       ORDER BY id DESC LIMIT 1`,
      [propertyId, room.id],
    );
    housekeepingTaskId = Number(tasks[0].id);
    const [history] = await pool.execute(
      `SELECT action FROM audit_log WHERE property_id = ? AND entity = 'stay' AND entity_id = ? ORDER BY id`,
      [propertyId, String(stayId)],
    );
    expect(history.some((entry) => entry.action === 'stay.check_out')).toBe(true);

    await pool.execute('DELETE FROM task_checklist_items WHERE property_id = ? AND task_id = ?', [propertyId, housekeepingTaskId]);
    await pool.execute('DELETE FROM housekeeping_tasks WHERE id = ?', [housekeepingTaskId]);
    await restoreRoom(room.id, oldStatus, 'Restore room after stay test');
  });

  it('rolls back a walk-in when the selected room is not clean', async () => {
    const [rooms] = await pool.execute(
      `SELECT id FROM rooms WHERE property_id = ? AND is_active = 1 AND status IN ('OCCUPIED', 'AWAITING_CLEANING', 'BLOCKED_MAINTENANCE')
       LIMIT 1`,
      [propertyId],
    );
    expect(rooms).not.toHaveLength(0);
    const invalidGuestName = `Invalid ${Date.now()}`;
    const [before] = await pool.execute(
      'SELECT COUNT(*) AS count FROM guests WHERE property_id = ? AND first_name = ?',
      [propertyId, invalidGuestName],
    );
    const response = await request(server)
      .post('/api/walk-ins')
      .set('Authorization', authHeader())
      .send({
        guest: {
          firstName: invalidGuestName,
          lastName: 'Room',
          idType: 'passport',
          idNumber: `INVALID-ROOM-${Date.now()}`,
        },
        roomId: Number(rooms[0].id),
      });
    expect(response.status).toBe(409);
    expect(['ROOM_NOT_READY', 'ROOM_BLOCKED']).toContain(response.body.error.code);
    const [after] = await pool.execute(
      'SELECT COUNT(*) AS count FROM guests WHERE property_id = ? AND first_name = ?',
      [propertyId, invalidGuestName],
    );
    expect(Number(after[0].count)).toBe(Number(before[0].count));
  });

  it('checks in a reservation, moves rooms, extends and shortens the stay', async () => {
    const checkOutDate = new Date(`${businessDate}T00:00:00Z`);
    checkOutDate.setUTCDate(checkOutDate.getUTCDate() + 1);
    const nextDate = checkOutDate.toISOString().slice(0, 10);
    const extendedDate = new Date(`${nextDate}T00:00:00Z`);
    extendedDate.setUTCDate(extendedDate.getUTCDate() + 1);
    const extendedCheckOutDate = extendedDate.toISOString().slice(0, 10);
    const [rooms] = await pool.execute(
      `SELECT room.id, room.room_type_id, room.room_number, room.status
       FROM rooms room
       WHERE room.property_id = ? AND room.is_active = 1 AND room.status IN ('CLEAN', 'AVAILABLE_CLEAN')
         AND NOT EXISTS (
           SELECT 1 FROM room_nights rn
           JOIN reservations reservation ON reservation.id = rn.reservation_id
             AND reservation.property_id = rn.property_id
           WHERE rn.property_id = room.property_id AND rn.room_id = room.id
             AND rn.night >= ? AND rn.night < ?
             AND reservation.status IN ('tentative', 'confirmed', 'checked_in')
         )
         AND NOT EXISTS (
           SELECT 1 FROM maintenance_tickets ticket
           WHERE ticket.property_id = room.property_id AND ticket.room_id = room.id
             AND ticket.blocks_room = 1 AND ticket.status <> 'closed'
         )
       ORDER BY room.room_number LIMIT 20`,
      [propertyId, businessDate, extendedCheckOutDate],
    );
    const roomPairIndex = rooms.findIndex((first, index) =>
      rooms.slice(index + 1).some((second) => Number(second.room_type_id) === Number(first.room_type_id)));
    expect(roomPairIndex).toBeGreaterThanOrEqual(0);
    const firstRoom = rooms[roomPairIndex];
    const secondRoom = rooms.slice(roomPairIndex + 1)
      .find((room) => Number(room.room_type_id) === Number(firstRoom.room_type_id));
    const typeRooms = [firstRoom, secondRoom];
    const oldStatuses = typeRooms.map((room) => room.status);
    const [guests] = await pool.execute(
      `SELECT id FROM guests
       WHERE property_id = ? AND deleted_at IS NULL AND anonymised_at IS NULL AND id_number_enc IS NULL
       LIMIT 1`,
      [propertyId],
    );
    expect(guests.length).toBeGreaterThan(0);
    const [propertySettings] = await pool.execute(
      'SELECT require_id_at_checkin FROM properties WHERE id = ?',
      [propertyId],
    );
    const [plans] = await pool.execute(
      `SELECT plan.id FROM rate_plans plan
       JOIN rates rate ON rate.rate_plan_id = plan.id AND rate.property_id = plan.property_id
       WHERE plan.property_id = ? AND plan.is_active = 1 AND rate.room_type_id = ? LIMIT 1`,
      [propertyId, typeRooms[0].room_type_id],
    );
    const created = await request(server)
      .post('/api/reservations')
      .set('Authorization', authHeader())
      .send({
        primaryGuestId: Number(guests[0].id),
        checkInDate: businessDate,
        checkOutDate: nextDate,
        rooms: [{
          roomTypeId: Number(typeRooms[0].room_type_id),
          ratePlanId: Number(plans[0].id),
          adults: 1,
          children: 0,
        }],
      });
    expect(created.status).toBe(201);
    const reservationId = Number(created.body.data.id);
    const capturedIdNumber = `STAY-${Date.now()}`;
    let stayId;
    const [priorTaskRows] = await pool.execute(
      'SELECT COALESCE(MAX(id), 0) AS id FROM housekeeping_tasks WHERE property_id = ?',
      [propertyId],
    );
    const previousTaskId = Number(priorTaskRows[0].id);

    try {
      await pool.execute('UPDATE properties SET require_id_at_checkin = 1 WHERE id = ?', [propertyId]);
      const missingId = await request(server)
        .post(`/api/reservations/${reservationId}/check-in`)
        .set('Authorization', authHeader())
        .send({ roomIds: [Number(typeRooms[0].id)] });
      expect(missingId.status).toBe(400);
      expect(missingId.body.error.code).toBe('GUEST_ID_REQUIRED');

      const checkedIn = await request(server)
        .post(`/api/reservations/${reservationId}/check-in`)
        .set('Authorization', authHeader())
        .send({
          roomIds: [Number(typeRooms[0].id)],
          idType: 'passport',
          idNumber: capturedIdNumber,
          depositAmount: '50.00',
          paymentTerms: 'Due on checkout',
        });
      expect(checkedIn.status, JSON.stringify(checkedIn.body)).toBe(201);
      stayId = checkedIn.body.data.stays[0].id;
      const stayDetail = await request(server)
        .get(`/api/stays/${stayId}`)
        .set('Authorization', authHeader());
      expect(stayDetail.status).toBe(200);
      expect(stayDetail.body.data.folio).toMatchObject({
        status: 'open',
        totalCharges: '0.00',
        totalPayments: '0.00',
        balance: '0.00',
      });
      expect(stayDetail.body.data.folio).not.toHaveProperty('balanceCents');
      const [savedIdentity] = await pool.execute(
        'SELECT id_number_enc, id_number_last4 FROM guests WHERE property_id = ? AND id = ?',
        [propertyId, guests[0].id],
      );
      expect(savedIdentity[0].id_number_enc).not.toContain('STAY-');
      expect(savedIdentity[0].id_number_last4).toBe(capturedIdNumber.slice(-4));
      const moved = await request(server)
        .post(`/api/stays/${stayId}/move`)
        .set('Authorization', authHeader())
        .send({ roomId: Number(typeRooms[1].id), reason: 'Test room move' });
      expect(moved.status).toBe(200);
      expect(moved.body.data).toMatchObject({ roomId: Number(typeRooms[1].id), rateChanged: false });

      const extended = await request(server)
        .post(`/api/stays/${stayId}/extend`)
        .set('Authorization', authHeader())
        .send({ checkOutDate: extendedCheckOutDate, reason: 'Test extension' });
      expect(extended.status).toBe(200);
      expect(extended.body.data.checkOutDate).toBe(extendedCheckOutDate);

      const shortened = await request(server)
        .post(`/api/stays/${stayId}/shorten`)
        .set('Authorization', authHeader())
        .send({ checkOutDate: nextDate, reason: 'Test shortening' });
      expect(shortened.status).toBe(200);

      const checkedOut = await request(server)
        .post(`/api/stays/${stayId}/check-out`)
        .set('Authorization', authHeader())
        .send({});
      expect(checkedOut.status).toBe(200);
      const [folio] = await pool.execute(
        'SELECT deposit_required, payment_terms, status FROM folios WHERE property_id = ? AND stay_id = ?',
        [propertyId, stayId],
      );
      expect(folio[0]).toMatchObject({ deposit_required: '50.00', payment_terms: 'Due on checkout', status: 'closed' });
      const [moves] = await pool.execute('SELECT id FROM room_moves WHERE property_id = ? AND stay_id = ?', [propertyId, stayId]);
      expect(moves).toHaveLength(1);
    } finally {
      await pool.execute(
        'UPDATE properties SET require_id_at_checkin = ? WHERE id = ?',
        [propertySettings[0].require_id_at_checkin, propertyId],
      );
      if (stayId) {
        const [stayRows] = await pool.execute(
          'SELECT status FROM stays WHERE property_id = ? AND id = ?',
          [propertyId, stayId],
        );
        if (stayRows[0]?.status === 'in_house') {
          await request(server)
            .post(`/api/stays/${stayId}/check-out`)
            .set('Authorization', authHeader())
            .send({});
        }
        const [pendingTasks] = await pool.execute(
          `SELECT id FROM housekeeping_tasks
           WHERE property_id = ? AND room_id IN (?, ?) AND type = 'checkout_clean'
             AND source_rule IN ('checkout', 'room_move')
             AND id > ?`,
          [propertyId, typeRooms[0].id, typeRooms[1].id, previousTaskId],
        );
        for (const task of pendingTasks) {
          await pool.execute('DELETE FROM task_checklist_items WHERE property_id = ? AND task_id = ?', [propertyId, task.id]);
          await pool.execute('DELETE FROM housekeeping_tasks WHERE id = ?', [task.id]);
        }
        for (let index = 0; index < typeRooms.length; index += 1) {
          const [currentRoomRows] = await pool.execute(
            'SELECT status FROM rooms WHERE property_id = ? AND id = ?',
            [propertyId, typeRooms[index].id],
          );
          const currentStatus = currentRoomRows[0]?.status;
          if (currentStatus === oldStatuses[index]) continue;
          await restoreRoom(typeRooms[index].id, oldStatuses[index], 'Restore room after stay test');
        }
      }
    }
  });
});
