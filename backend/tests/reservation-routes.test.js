import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';

describe('reservation availability and booking API', () => {
  const server = createServer(createApp());
  let propertyId;
  let userId;
  let guestId;
  let roomTypeId;
  let roomId;
  let ratePlanId;
  let legacyReservationId;
  let token;

  beforeAll(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const [users] = await pool.execute(
      `SELECT u.id, u.organization_id, up.property_id
       FROM users u JOIN user_properties up ON up.user_id = u.id
       WHERE u.email = 'owner@smarthotel.local' LIMIT 1`,
    );
    if (!users.length) throw new Error('Reservation tests require the seeded owner account');
    const user = users[0];
    propertyId = Number(user.property_id);
    userId = Number(user.id);
    const [[guests], [rooms], [plans]] = await Promise.all([
      pool.execute('SELECT id FROM guests WHERE property_id = ? AND deleted_at IS NULL AND anonymised_at IS NULL LIMIT 1', [propertyId]),
      pool.execute(`SELECT id, room_type_id FROM rooms WHERE property_id = ? AND is_active = 1 AND deleted_at IS NULL AND status <> 'BLOCKED_MAINTENANCE' ORDER BY id LIMIT 1`, [propertyId]),
      pool.execute('SELECT id FROM rate_plans WHERE property_id = ? AND is_active = 1 AND deleted_at IS NULL LIMIT 1', [propertyId]),
    ]);
    guestId = Number(guests[0].id);
    roomId = Number(rooms[0].id);
    roomTypeId = Number(rooms[0].room_type_id);
    ratePlanId = Number(plans[0].id);
    const [legacyReservations] = await pool.execute(
      `SELECT reservation.id
       FROM reservations reservation
       LEFT JOIN reservation_rooms line
         ON line.property_id = reservation.property_id AND line.reservation_id = reservation.id
       WHERE reservation.property_id = ? AND reservation.assigned_room_id IS NOT NULL
         AND line.id IS NULL LIMIT 1`,
      [propertyId],
    );
    legacyReservationId = legacyReservations[0] ? Number(legacyReservations[0].id) : null;
    token = jwt.sign({
      orgId: Number(user.organization_id),
      role: 'owner_gm',
      propertyIds: [propertyId],
      activePropertyId: propertyId,
    }, env.JWT_ACCESS_SECRET, { subject: String(userId), expiresIn: '10m' });
  });

  afterAll(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  function createBody({ checkInDate = '2098-04-10', checkOutDate = '2098-04-11', assignedRoomId = null, roomCount = 1 } = {}) {
    return {
      primaryGuestId: guestId,
      source: 'manual',
      status: 'confirmed',
      checkInDate,
      checkOutDate,
      rooms: Array.from({ length: roomCount }, () => ({
        roomTypeId,
        roomId: roomCount === 1 ? assignedRoomId : null,
        ratePlanId,
        adults: 1,
        children: 0,
      })),
    };
  }

  async function cancelReservation(id) {
    const response = await request(server)
      .post(`/api/reservations/${id}/cancel`)
      .set('Authorization', ['Bearer', token].join(' '))
      .send({ reason: 'Reservation API test cleanup', cancellationFee: '0.00' });
    expect(response.status).toBe(200);
  }

  it('returns availability and creates/cancels an unassigned type-level booking', async () => {
    const before = await request(server)
      .get('/api/reservations/availability?from=2098-04-10&to=2098-04-12')
      .set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);
    expect(before.body.data).toHaveLength(2);
    const initial = before.body.data[0].roomTypes.find((item) => item.id === roomTypeId);
    expect(initial.availableRooms).toBeGreaterThan(0);

    const created = await request(server)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${token}`)
      .send(createBody({ roomCount: 2 }));
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      status: 'confirmed',
      assignedRoomId: null,
      rooms: [{ roomId: null }, { roomId: null }],
    });

    const after = await request(server)
      .get('/api/reservations/availability?from=2098-04-10&to=2098-04-12')
      .set('Authorization', `Bearer ${token}`);
    expect(after.body.data[0].roomTypes.find((item) => item.id === roomTypeId).availableRooms)
      .toBe(initial.availableRooms - 2);

    const detail = await request(server)
      .get(`/api/reservations/${created.body.data.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.history[0].action).toBe('created');

    await cancelReservation(created.body.data.id);
    const freed = await request(server)
      .get('/api/reservations/availability?from=2098-04-10&to=2098-04-12')
      .set('Authorization', `Bearer ${token}`);
    expect(freed.body.data[0].roomTypes.find((item) => item.id === roomTypeId).availableRooms)
      .toBe(initial.availableRooms);
  });

  it('returns details for legacy assigned reservations without reservation-room rows', async () => {
    expect(legacyReservationId).not.toBeNull();
    const response = await request(server)
      .get(`/api/reservations/${legacyReservationId}`)
      .set('Authorization', ['Bearer', token].join(' '));
    expect(response.status).toBe(200);
    expect(response.body.data.rooms).toHaveLength(1);
    expect(response.body.data.rooms[0].roomId).not.toBeNull();
  });

  it('links active group members to the reservation inside the transaction', async () => {
    const [otherGuests] = await pool.execute(
      'SELECT id FROM guests WHERE property_id = ? AND id <> ? AND deleted_at IS NULL AND anonymised_at IS NULL LIMIT 1',
      [propertyId, guestId],
    );
    expect(otherGuests).not.toHaveLength(0);
    const otherGuestId = Number(otherGuests[0].id);
    const [groups] = await pool.execute(
      'INSERT INTO `groups` (property_id, name, leader_guest_id, notes) VALUES (?, ?, ?, ?)',
      [propertyId, `Reservation test ${Date.now()}`, guestId, null],
    );
    const groupId = Number(groups.insertId);
    await pool.execute(
      'INSERT INTO group_guests (property_id, group_id, guest_id) VALUES (?, ?, ?)',
      [propertyId, groupId, otherGuestId],
    );

    let reservationId = null;
    try {
      const created = await request(server)
        .post('/api/reservations')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...createBody({ checkInDate: '2098-05-10', checkOutDate: '2098-05-11' }), groupId });
      expect(created.status).toBe(201);
      reservationId = Number(created.body.data.id);
      const [guestLinks] = await pool.execute(
        'SELECT guest_id FROM reservation_guests WHERE property_id = ? AND reservation_id = ? ORDER BY guest_id',
        [propertyId, reservationId],
      );
      expect(guestLinks.map((row) => Number(row.guest_id)).sort((a, b) => a - b))
        .toEqual([guestId, otherGuestId].sort((a, b) => a - b));
    } finally {
      if (reservationId !== null) await cancelReservation(reservationId);
      await pool.execute('DELETE FROM group_guests WHERE property_id = ? AND group_id = ?', [propertyId, groupId]);
      await pool.execute('UPDATE `groups` SET deleted_at = NOW() WHERE id = ? AND property_id = ?', [groupId, propertyId]);
    }
  });

  it('allows exactly one of 50 concurrent reservations for the same final room', async () => {
    const attempts = await Promise.all(Array.from({ length: 50 }, () => request(server)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${token}`)
      .send(createBody({ assignedRoomId: roomId }))));
    const successes = attempts.filter((response) => response.status === 201);
    const conflicts = attempts.filter((response) => response.status === 409 && response.body.error.code === 'ROOM_UNAVAILABLE');
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(49);
    const [duplicates] = await pool.execute(
      `SELECT room_id, night, COUNT(*) AS bookings FROM room_nights
       WHERE property_id = ? AND night = '2098-04-10' AND room_id = ?
       GROUP BY room_id, night HAVING COUNT(*) > 1`,
      [propertyId, roomId],
    );
    expect(duplicates).toHaveLength(0);
    await cancelReservation(successes[0].body.data.id);
  }, 60_000);

  it('rejects conflicting extensions and records dates and moves in reservation history', async () => {
    const first = await request(server)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${token}`)
      .send(createBody({ checkInDate: '2098-04-20', checkOutDate: '2098-04-21', assignedRoomId: roomId }));
    expect(first.status).toBe(201);

    const second = await request(server)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${token}`)
      .send(createBody({ checkInDate: '2098-04-21', checkOutDate: '2098-04-22', assignedRoomId: roomId }));
    expect(second.status).toBe(201);

    const extension = await request(server)
      .post(`/api/reservations/${first.body.data.id}/extend`)
      .set('Authorization', `Bearer ${token}`)
      .send({ checkOutDate: '2098-04-22', reason: 'Test overlapping extension' });
    expect(extension.status).toBe(409);
    expect(extension.body.error.code).toBe('ROOM_UNAVAILABLE');

    const shifted = await request(server)
      .post(`/api/reservations/${second.body.data.id}/move`)
      .set('Authorization', `Bearer ${token}`)
      .send({ roomId, checkInDate: '2098-04-23', checkOutDate: '2098-04-24', reason: 'Test move to a new date' });
    expect(shifted.status).toBe(200);
    expect(shifted.body.data.checkInDate).toBe('2098-04-23');
    expect(shifted.body.data.history.at(-1).action).toBe('moved');
    await cancelReservation(first.body.data.id);
    await cancelReservation(second.body.data.id);
  }, 60_000);
});
