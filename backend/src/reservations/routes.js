import { Router } from 'express';
import { z } from 'zod';
import { auditable, inAuditedTransaction } from '../auth/audit.js';
import { authenticate, propertyScope, requirePermission } from '../auth/middleware.js';
import { logger } from '../config/logger.js';
import { quote } from '../property/rate-calculator.js';
import { getAvailability, stayNights } from './availability.js';

const roomLineSchema = z.object({
  roomTypeId: z.coerce.number().int().positive(),
  roomId: z.coerce.number().int().positive().nullable().optional(),
  ratePlanId: z.coerce.number().int().positive().optional(),
  adults: z.coerce.number().int().min(1).max(20),
  children: z.coerce.number().int().min(0).max(20),
});
const reservationSchema = z.object({
  primaryGuestId: z.coerce.number().int().positive(),
  guestIds: z.array(z.coerce.number().int().positive()).max(50).default([]),
  companyId: z.coerce.number().int().positive().nullable().optional(),
  groupId: z.coerce.number().int().positive().nullable().optional(),
  source: z.enum(['walk_in', 'phone', 'manual']).default('manual'),
  status: z.enum(['tentative', 'confirmed']).default('confirmed'),
  checkInDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rooms: z.array(roomLineSchema).min(1).max(20),
  specialRequests: z.string().trim().max(5000).nullable().optional(),
});
const updateSchema = reservationSchema.partial().extend({
  reason: z.string().trim().min(3).max(500),
});
const cancellationSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  cancellationFee: z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/).default('0.00'),
});
const statusReasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const moveSchema = z.object({
  roomId: z.coerce.number().int().positive().nullable(),
  checkInDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  checkOutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reason: z.string().trim().min(3).max(500),
});
const searchSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(['tentative', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show']).optional(),
  search: z.string().trim().max(100).optional(),
});
const ACTIVE_STATUSES = ['tentative', 'confirmed', 'checked_in'];

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw Object.assign(new Error('Request validation failed'), {
      status: 400,
      code: 'VALIDATION_ERROR',
      details: result.error.issues,
    });
  }
  return result.data;
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : null;
}

async function lockRoomTypes(connection, propertyId, roomTypeIds) {
  for (const roomTypeId of [...new Set(roomTypeIds)].sort((a, b) => a - b)) {
    const [rows] = await connection.execute(
      `SELECT id FROM room_types
       WHERE id = ? AND property_id = ? AND is_active = 1 AND deleted_at IS NULL
       FOR UPDATE`,
      [roomTypeId, propertyId],
    );
    if (!rows.length) throw httpError(400, 'INVALID_ROOM_TYPE', 'A selected room type is unavailable');
  }
}

async function ensureGuests(connection, propertyId, primaryGuestId, guestIds) {
  const ids = [...new Set([primaryGuestId, ...guestIds])];
  const [rows] = await connection.execute(
    `SELECT id FROM guests WHERE property_id = ? AND deleted_at IS NULL AND anonymised_at IS NULL
       AND id IN (${ids.map(() => '?').join(',')})`,
    [propertyId, ...ids],
  );
  if (rows.length !== ids.length) throw httpError(400, 'INVALID_GUEST', 'A selected guest is unavailable in this property');
  return ids;
}

async function verifyAssociation(connection, table, propertyId, id, code, name) {
  if (!id) return;
  if (!['companies', 'groups'].includes(table)) throw new Error('Unsupported reservation association');
  const [rows] = await connection.execute(
    `SELECT id FROM ${table} WHERE id = ? AND property_id = ? AND deleted_at IS NULL LIMIT 1`,
    [id, propertyId],
  );
  if (!rows.length) throw httpError(400, code, `${name} is unavailable in this property`);
}

async function loadRoomAndRate(connection, propertyId, roomLine, checkInDate, checkOutDate) {
  const [types] = await connection.execute(
    `SELECT id, property_id, name, max_adults, max_children, base_rate, is_active
     FROM room_types WHERE id = ? AND property_id = ? AND is_active = 1 AND deleted_at IS NULL`,
    [roomLine.roomTypeId, propertyId],
  );
  const roomType = types[0];
  if (!roomType) throw httpError(400, 'INVALID_ROOM_TYPE', 'A selected room type is unavailable');
  const [plans] = await connection.execute(
    `SELECT id, property_id, name, is_active FROM rate_plans
     WHERE id = ? AND property_id = ? AND is_active = 1 AND deleted_at IS NULL`,
    [roomLine.ratePlanId, propertyId],
  );
  const ratePlan = plans[0];
  if (!ratePlan) throw httpError(400, 'INVALID_RATE_PLAN', 'A selected rate plan is unavailable');
  const [rates] = await connection.execute(
    `SELECT id, room_type_id, rate_plan_id, date_from, date_to, weekday_mask, amount,
            min_stay, created_at
     FROM rates
     WHERE property_id = ? AND room_type_id = ? AND rate_plan_id = ?
       AND date_from <= ? AND date_to >= ?
     ORDER BY date_from DESC, created_at DESC, id DESC`,
    [propertyId, roomLine.roomTypeId, roomLine.ratePlanId, checkOutDate, checkInDate],
  );
  const [properties] = await connection.execute(
    'SELECT tax_settings, currency FROM properties WHERE id = ? LIMIT 1',
    [propertyId],
  );
  const taxSettings = typeof properties[0].tax_settings === 'string'
    ? JSON.parse(properties[0].tax_settings)
    : properties[0].tax_settings ?? {};
  const result = quote(
    {
      roomTypeId: roomLine.roomTypeId,
      ratePlanId: roomLine.ratePlanId,
      checkIn: checkInDate,
      checkOut: checkOutDate,
      adults: roomLine.adults,
      children: roomLine.children,
    },
    { roomTypes: [roomType], ratePlans: [ratePlan], rates, taxSettings },
  );
  result.currency = properties[0].currency;
  return result;
}

function quoteTotal(quoteResult) {
  const [whole, fractional] = quoteResult.totals.total.split('.');
  return Number(whole) * 100 + Number(fractional);
}

function formatCents(value) {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}

async function getRoomLineInventory(connection, propertyId, roomLine, checkInDate, checkOutDate) {
  if (!roomLine.roomId) return null;
  const [rows] = await connection.execute(
    `SELECT room.id, room.room_type_id, room.status, room.is_active,
            EXISTS (
              SELECT 1 FROM maintenance_tickets ticket
              WHERE ticket.property_id = room.property_id AND ticket.room_id = room.id
                AND ticket.blocks_room = 1 AND ticket.status <> 'closed'
            ) AS has_blocking_ticket
     FROM rooms room
     WHERE room.id = ? AND room.property_id = ? AND room.deleted_at IS NULL
     FOR UPDATE`,
    [roomLine.roomId, propertyId],
  );
  const room = rows[0];
  if (!room || Number(room.room_type_id) !== Number(roomLine.roomTypeId)
    || !room.is_active || room.status === 'BLOCKED_MAINTENANCE' || room.has_blocking_ticket) {
    throw httpError(409, 'ROOM_UNAVAILABLE', 'Selected room is unavailable for reservation');
  }
  const [conflicts] = await connection.execute(
    `SELECT room_night.night FROM room_nights room_night
     JOIN reservations reservation ON reservation.id = room_night.reservation_id
     WHERE room_night.property_id = ? AND room_night.room_id = ?
       AND room_night.night >= ? AND room_night.night < ?
       AND reservation.status IN ('tentative', 'confirmed', 'checked_in')
     LIMIT 1`,
    [propertyId, roomLine.roomId, checkInDate, checkOutDate],
  );
  if (conflicts.length) throw httpError(409, 'ROOM_UNAVAILABLE', 'Selected room is already reserved for part of this stay');
  return room;
}

async function reservationRow(connection, propertyId, reservationId, lock = false) {
  const [rows] = await connection.execute(
    `SELECT reservation.*, guest.first_name, guest.last_name, guest.phone, guest.email,
            room.room_number AS assigned_room_number, room_type.name AS room_type_name,
            company.name AS company_name, guest_group.name AS group_name
     FROM reservations reservation
     LEFT JOIN guests guest ON guest.id = reservation.primary_guest_id AND guest.property_id = reservation.property_id
     LEFT JOIN rooms room ON room.id = reservation.assigned_room_id AND room.property_id = reservation.property_id
     LEFT JOIN room_types room_type ON room_type.id = reservation.room_type_id AND room_type.property_id = reservation.property_id
     LEFT JOIN companies company ON company.id = reservation.company_id AND company.property_id = reservation.property_id
     LEFT JOIN groups guest_group ON guest_group.id = reservation.group_id AND guest_group.property_id = reservation.property_id
     WHERE reservation.id = ? AND reservation.property_id = ?${lock ? ' FOR UPDATE' : ''}`,
    [reservationId, propertyId],
  );
  return rows[0] ?? null;
}

function mapReservation(row) {
  return {
    id: Number(row.id),
    confirmationNo: row.confirmation_no,
    primaryGuestId: row.primary_guest_id === null ? null : Number(row.primary_guest_id),
    guestName: row.first_name ? `${row.first_name} ${row.last_name}` : null,
    guestPhone: row.phone,
    guestEmail: row.email,
    companyId: row.company_id === null ? null : Number(row.company_id),
    companyName: row.company_name,
    groupId: row.group_id === null ? null : Number(row.group_id),
    groupName: row.group_name,
    source: row.source,
    status: row.status,
    checkInDate: dateOnly(row.check_in_date),
    checkOutDate: dateOnly(row.check_out_date),
    adults: Number(row.adults),
    children: Number(row.children),
    roomTypeId: Number(row.room_type_id),
    roomType: row.room_type_name,
    assignedRoomId: row.assigned_room_id === null ? null : Number(row.assigned_room_id),
    assignedRoom: row.assigned_room_number,
    ratePlanId: row.rate_plan_id === null ? null : Number(row.rate_plan_id),
    totalEstimate: String(row.total_estimate),
    specialRequests: row.special_requests,
    createdAt: row.created_at,
  };
}

async function writeHistory(connection, req, reservationId, {
  action,
  fromStatus = null,
  toStatus = null,
  before = null,
  after = null,
  reason = null,
}) {
  await connection.execute(
    `INSERT INTO reservation_history
      (property_id, reservation_id, actor_id, action, from_status, to_status, before_state, after_state, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.propertyId,
      reservationId,
      req.auth.sub,
      action,
      fromStatus,
      toStatus,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      reason,
    ],
  );
}

async function nextConfirmationNo(connection, propertyId) {
  await connection.execute(
    `INSERT INTO number_counters (property_id, kind, next_value)
     VALUES (?, 'reservation', 1)
     ON DUPLICATE KEY UPDATE next_value = next_value`,
    [propertyId],
  );
  const [rows] = await connection.execute(
    `SELECT next_value FROM number_counters WHERE property_id = ? AND kind = 'reservation' FOR UPDATE`,
    [propertyId],
  );
  const number = Number(rows[0].next_value);
  await connection.execute(
    `UPDATE number_counters SET next_value = ? WHERE property_id = ? AND kind = 'reservation'`,
    [number + 1, propertyId],
  );
  return `R${String(propertyId).padStart(3, '0')}-${String(number).padStart(8, '0')}`;
}

function formatAvailability(connection, propertyId, checkInDate, checkOutDate, options) {
  return getAvailability(connection, propertyId, checkInDate, checkOutDate, options);
}

async function verifyAndReserveRoomLines(connection, propertyId, lines, checkInDate, checkOutDate, excludeReservationId = null) {
  await lockRoomTypes(connection, propertyId, lines.map((line) => line.roomTypeId));
  const availability = await getAvailability(connection, propertyId, checkInDate, checkOutDate, {
    excludeReservationId,
  });
  const left = new Map();
  for (const night of availability) {
    for (const roomType of night.roomTypes) {
      left.set(`${night.date}:${roomType.id}`, roomType.availableRooms);
    }
  }
  const assignedRooms = new Set();
  const selectedRooms = [];
  for (const line of lines) {
    const room = await getRoomLineInventory(connection, propertyId, line, checkInDate, checkOutDate);
    if (room && assignedRooms.has(Number(room.id))) {
      throw httpError(409, 'ROOM_UNAVAILABLE', 'A room cannot be assigned more than once to the same reservation');
    }
    if (room) assignedRooms.add(Number(room.id));
    for (const night of stayNights(checkInDate, checkOutDate)) {
      const key = `${night}:${line.roomTypeId}`;
      const remaining = left.get(key) ?? 0;
      if (remaining < 1) throw httpError(409, 'ROOM_UNAVAILABLE', `No ${line.roomTypeId} room is available on ${night}`);
      left.set(key, remaining - 1);
    }
    selectedRooms.push(room);
  }
  return selectedRooms;
}

async function insertRoomNights(connection, propertyId, reservationId, roomId, nights) {
  if (!roomId) return;
  for (const night of nights) {
    await connection.execute(
      'INSERT INTO room_nights (property_id, room_id, night, reservation_id) VALUES (?, ?, ?, ?)',
      [propertyId, roomId, night, reservationId],
    );
  }
}

async function insertGuestLinks(connection, propertyId, reservationId, primaryGuestId, guestIds) {
  const ids = [...new Set([primaryGuestId, ...guestIds])];
  for (const guestId of ids) {
    await connection.execute(
      `INSERT INTO reservation_guests (property_id, reservation_id, guest_id, is_primary)
       VALUES (?, ?, ?, ?)`,
      [propertyId, reservationId, guestId, guestId === primaryGuestId],
    );
  }
}

async function quoteRoomLines(connection, propertyId, roomLines, checkInDate, checkOutDate) {
  const quoted = [];
  let total = 0;
  for (const line of roomLines) {
    const result = await loadRoomAndRate(connection, propertyId, line, checkInDate, checkOutDate);
    const cents = quoteTotal(result);
    total += cents;
    quoted.push({ ...line, quote: result, totalCents: cents });
  }
  return { lines: quoted, totalCents: total };
}

async function storeReservationRooms(connection, propertyId, reservationId, lines, rooms, quotes) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    await connection.execute(
      `INSERT INTO reservation_rooms
        (property_id, reservation_id, room_type_id, room_id, adults, children, nightly_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [propertyId, reservationId, line.roomTypeId, rooms[index]?.id ?? null, line.adults, line.children, quotes.lines[index].quote.nightlyRates[0].rate],
    );
  }
}

async function getDefaultRatePlan(connection, propertyId, roomTypeId) {
  const [rows] = await connection.execute(
    `SELECT plan.id FROM rate_plans plan
     JOIN rates rate ON rate.rate_plan_id = plan.id AND rate.property_id = plan.property_id
     WHERE plan.property_id = ? AND plan.is_active = 1 AND plan.deleted_at IS NULL
       AND rate.room_type_id = ? ORDER BY plan.id LIMIT 1`,
    [propertyId, roomTypeId],
  );
  if (!rows.length) throw httpError(400, 'RATE_PLAN_REQUIRED', 'No active rate plan is available for this room type');
  return Number(rows[0].id);
}

async function validateFutureDate(connection, propertyId, checkInDate) {
  const [rows] = await connection.execute('SELECT business_date FROM properties WHERE id = ? LIMIT 1', [propertyId]);
  const today = dateOnly(rows[0]?.business_date) ?? new Date().toISOString().slice(0, 10);
  if (checkInDate < today) {
    throw httpError(400, 'PAST_CHECK_IN_DATE', 'New reservations must start on or after the property business date');
  }
}

async function fetchReservationDetails(connection, propertyId, reservationId) {
  const row = await reservationRow(connection, propertyId, reservationId);
  if (!row) return null;
  const [roomLines] = await connection.execute(
    `SELECT rr.id, rr.room_type_id, type.name AS room_type, rr.room_id,
            room.room_number, rr.adults, rr.children, rr.nightly_rate
     FROM reservation_rooms rr
     JOIN room_types type ON type.id = rr.room_type_id AND type.property_id = rr.property_id
     LEFT JOIN rooms room ON room.id = rr.room_id AND room.property_id = rr.property_id
     WHERE rr.property_id = ? AND rr.reservation_id = ? ORDER BY rr.id`,
    [propertyId, reservationId],
  );
  if (!roomLines.length && row.assigned_room_id !== null) {
    const [legacyRoom] = await connection.execute(
      `SELECT room.id AS room_id, room.room_number, type.name AS room_type,
              room.room_type_id
       FROM rooms room JOIN room_types type
         ON type.id = room.room_type_id AND type.property_id = room.property_id
       WHERE room.id = ? AND room.property_id = ?`,
      [row.assigned_room_id, propertyId],
    );
    if (legacyRoom[0]) {
      roomLines.push({
        id: null,
        room_type_id: legacyRoom[0].room_type_id,
        room_type: legacyRoom[0].room_type,
        room_id: legacyRoom[0].room_id,
        room_number: legacyRoom[0].room_number,
        adults: row.adults,
        children: row.children,
        nightly_rate: null,
      });
    }
  }
  const [guests] = await connection.execute(
    `SELECT guest.id, guest.first_name, guest.last_name, guest.phone, guest.email, link.is_primary
     FROM reservation_guests link JOIN guests guest
       ON guest.id = link.guest_id AND guest.property_id = link.property_id
     WHERE link.property_id = ? AND link.reservation_id = ?
     ORDER BY link.is_primary DESC, guest.last_name, guest.first_name`,
    [propertyId, reservationId],
  );
  const [history] = await connection.execute(
    `SELECT id, action, from_status, to_status, before_state, after_state, reason, created_at
     FROM reservation_history WHERE property_id = ? AND reservation_id = ?
     ORDER BY created_at, id`,
    [propertyId, reservationId],
  );
  return {
    ...mapReservation(row),
    rooms: roomLines.map((line) => ({
      id: line.id === null ? null : Number(line.id),
      roomTypeId: Number(line.room_type_id),
      roomType: line.room_type,
      roomId: line.room_id === null ? null : Number(line.room_id),
      roomNumber: line.room_number,
      adults: Number(line.adults),
      children: Number(line.children),
      nightlyRate: line.nightly_rate === null ? null : String(line.nightly_rate),
    })),
    guests: guests.map((guest) => ({
      id: Number(guest.id),
      name: `${guest.first_name} ${guest.last_name}`,
      phone: guest.phone,
      email: guest.email,
      isPrimary: Boolean(guest.is_primary),
    })),
    history: history.map((event) => ({
      id: Number(event.id),
      action: event.action,
      fromStatus: event.from_status,
      toStatus: event.to_status,
      before: event.before_state ? (typeof event.before_state === 'string' ? JSON.parse(event.before_state) : event.before_state) : null,
      after: event.after_state ? (typeof event.after_state === 'string' ? JSON.parse(event.after_state) : event.after_state) : null,
      reason: event.reason,
      createdAt: event.created_at,
    })),
  };
}

export function createReservationRouter(db) {
  const router = Router();
  router.use(authenticate(db), propertyScope(db));

  router.get('/reservations/availability', requirePermission(db, 'reservations.view'), async (req, res, next) => {
    try {
      const data = parse(z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        roomTypeId: z.coerce.number().int().positive().optional(),
      }), req.query);
      const availability = await formatAvailability(db, req.propertyId, data.from, data.to, { roomTypeId: data.roomTypeId });
      return res.json({ data: availability });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/reservations/arrivals', requirePermission(db, 'reservations.view'), async (req, res, next) => {
    try {
      const date = req.query.date
        ? parse(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), req.query.date)
        : null;
      const [properties] = await db.execute('SELECT business_date FROM properties WHERE id = ?', [req.propertyId]);
      const targetDate = date ?? dateOnly(properties[0]?.business_date) ?? new Date().toISOString().slice(0, 10);
      const [rows] = await db.execute(
        `SELECT reservation.id FROM reservations reservation
         WHERE reservation.property_id = ? AND reservation.check_in_date = ?
           AND reservation.status IN ('confirmed', 'tentative')
         ORDER BY reservation.created_at, reservation.id`,
        [req.propertyId, targetDate],
      );
      const data = [];
      for (const row of rows) data.push(mapReservation(await reservationRow(db, req.propertyId, Number(row.id))));
      return res.json({ data: { date: targetDate, reservations: data } });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/reservations/departures', requirePermission(db, 'reservations.view'), async (req, res, next) => {
    try {
      const date = req.query.date
        ? parse(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), req.query.date)
        : null;
      const [properties] = await db.execute('SELECT business_date FROM properties WHERE id = ?', [req.propertyId]);
      const targetDate = date ?? dateOnly(properties[0]?.business_date) ?? new Date().toISOString().slice(0, 10);
      const [rows] = await db.execute(
        `SELECT reservation.id FROM reservations reservation
         WHERE reservation.property_id = ? AND reservation.check_out_date = ?
           AND reservation.status IN ('confirmed', 'checked_in')
         ORDER BY reservation.created_at, reservation.id`,
        [req.propertyId, targetDate],
      );
      const data = [];
      for (const row of rows) data.push(mapReservation(await reservationRow(db, req.propertyId, Number(row.id))));
      return res.json({ data: { date: targetDate, reservations: data } });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/reservations/calendar', requirePermission(db, 'reservations.view'), async (req, res, next) => {
    try {
      const data = parse(z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }), req.query);
      stayNights(data.from, data.to, 31);
      const [rows] = await db.execute(
        `SELECT reservation.id FROM reservations reservation
         WHERE reservation.property_id = ? AND reservation.status IN ('tentative', 'confirmed', 'checked_in')
           AND reservation.check_in_date < ? AND reservation.check_out_date > ?
         ORDER BY reservation.check_in_date, reservation.id LIMIT 500`,
        [req.propertyId, data.to, data.from],
      );
      const reservations = [];
      for (const row of rows) {
        const reservation = await fetchReservationDetails(db, req.propertyId, Number(row.id));
        if (reservation) reservations.push(reservation);
      }
      const [rooms] = await db.execute(
        `SELECT room.id, room.room_number, room.room_type_id, type.name AS room_type,
                floor.name AS floor_name
         FROM rooms room
         JOIN room_types type ON type.id = room.room_type_id AND type.property_id = room.property_id
         LEFT JOIN floors floor ON floor.id = room.floor_id AND floor.property_id = room.property_id
         WHERE room.property_id = ? AND room.is_active = 1 AND room.deleted_at IS NULL
         ORDER BY floor.floor_number, room.room_number`,
        [req.propertyId],
      );
      return res.json({
        data: {
          from: data.from,
          to: data.to,
          rooms: rooms.map((room) => ({
            id: Number(room.id),
            roomNumber: room.room_number,
            roomTypeId: Number(room.room_type_id),
            roomType: room.room_type,
            floor: room.floor_name,
          })),
          reservations,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/reservations', requirePermission(db, 'reservations.view'), async (req, res, next) => {
    try {
      const filters = parse(searchSchema, req.query);
      const where = ['reservation.property_id = ?'];
      const params = [req.propertyId];
      if (filters.from) {
        where.push('reservation.check_out_date > ?');
        params.push(filters.from);
      }
      if (filters.to) {
        where.push('reservation.check_in_date < ?');
        params.push(filters.to);
      }
      if (filters.status) {
        where.push('reservation.status = ?');
        params.push(filters.status);
      }
      if (filters.search) {
        where.push('(reservation.confirmation_no LIKE ? OR guest.first_name LIKE ? OR guest.last_name LIKE ? OR guest.phone LIKE ?)');
        const match = `%${filters.search}%`;
        params.push(match, match, match, match);
      }
      const [rows] = await db.execute(
        `SELECT reservation.id FROM reservations reservation
         LEFT JOIN guests guest ON guest.id = reservation.primary_guest_id AND guest.property_id = reservation.property_id
         WHERE ${where.join(' AND ')}
         ORDER BY reservation.check_in_date DESC, reservation.id DESC LIMIT 200`,
        params,
      );
      const reservations = [];
      for (const row of rows) reservations.push(mapReservation(await reservationRow(db, req.propertyId, Number(row.id))));
      return res.json({ data: reservations });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/reservations', requirePermission(db, 'reservations.create'), async (req, res, next) => {
    try {
      const data = parse(reservationSchema, req.body);
      const nights = stayNights(data.checkInDate, data.checkOutDate);
      await validateFutureDate(db, req.propertyId, data.checkInDate);
      const result = await inAuditedTransaction(db, req, (created) => ({
        action: 'reservation.create',
        entity: 'reservation',
        entityId: created.id,
        after: created.audit,
      }), async (connection) => {
        await lockRoomTypes(connection, req.propertyId, data.rooms.map((line) => line.roomTypeId));
        await verifyAssociation(connection, 'companies', req.propertyId, data.companyId, 'INVALID_COMPANY', 'Company');
        await verifyAssociation(connection, 'groups', req.propertyId, data.groupId, 'INVALID_GROUP', 'Group');
        const groupGuestIds = [];
        if (data.groupId) {
          const [members] = await connection.execute(
            `SELECT group_guest.guest_id
             FROM group_guests group_guest
             JOIN guests guest ON guest.id = group_guest.guest_id
               AND guest.property_id = group_guest.property_id
             WHERE group_guest.property_id = ? AND group_guest.group_id = ?
               AND guest.deleted_at IS NULL AND guest.anonymised_at IS NULL`,
            [req.propertyId, data.groupId],
          );
          groupGuestIds.push(...members.map((member) => Number(member.guest_id)));
        }
        const linkedGuestIds = await ensureGuests(
          connection,
          req.propertyId,
          data.primaryGuestId,
          [...data.guestIds, ...groupGuestIds],
        );
        const lines = [];
        for (const line of data.rooms) {
          lines.push({
            ...line,
            ratePlanId: line.ratePlanId ?? await getDefaultRatePlan(connection, req.propertyId, line.roomTypeId),
          });
        }
        const quotes = await quoteRoomLines(connection, req.propertyId, lines, data.checkInDate, data.checkOutDate);
        const rooms = await verifyAndReserveRoomLines(
          connection, req.propertyId, lines, data.checkInDate, data.checkOutDate,
        );
        const confirmationNo = await nextConfirmationNo(connection, req.propertyId);
        const totalEstimate = formatCents(quotes.totalCents);
        const [inserted] = await connection.execute(
          `INSERT INTO reservations
            (property_id, confirmation_no, primary_guest_id, company_id, group_id, source, status,
             check_in_date, check_out_date, adults, children, room_type_id, assigned_room_id,
             rate_plan_id, total_estimate, special_requests, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            req.propertyId,
            confirmationNo,
            data.primaryGuestId,
            data.companyId ?? null,
            data.groupId ?? null,
            data.source,
            data.status,
            data.checkInDate,
            data.checkOutDate,
            lines.reduce((total, line) => total + line.adults, 0),
            lines.reduce((total, line) => total + line.children, 0),
            lines[0].roomTypeId,
            rooms[0]?.id ?? null,
            lines[0].ratePlanId,
            totalEstimate,
            data.specialRequests || null,
            req.auth.sub,
          ],
        );
        const id = Number(inserted.insertId);
        await storeReservationRooms(connection, req.propertyId, id, lines, rooms, quotes);
        await insertGuestLinks(connection, req.propertyId, id, data.primaryGuestId, linkedGuestIds);
        for (let index = 0; index < rooms.length; index += 1) {
          if (rooms[index]) await insertRoomNights(connection, req.propertyId, id, rooms[index].id, nights);
        }
        await writeHistory(connection, req, id, {
          action: 'created',
          toStatus: data.status,
          after: {
            checkInDate: data.checkInDate,
            checkOutDate: data.checkOutDate,
            roomCount: lines.length,
            totalEstimate,
          },
        });
        return {
          id,
          confirmationNo,
          audit: {
            confirmationNo,
            status: data.status,
            checkInDate: data.checkInDate,
            checkOutDate: data.checkOutDate,
            roomCount: lines.length,
            totalEstimate,
          },
        };
      });
      const reservation = await fetchReservationDetails(db, req.propertyId, result.id);
      return res.status(201).json({ data: reservation });
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: { code: 'ROOM_UNAVAILABLE', message: 'Selected room is no longer available' } });
      }
      return next(error);
    }
  });

  router.get('/reservations/:id', requirePermission(db, 'reservations.view'), async (req, res, next) => {
    try {
      const id = parse(z.coerce.number().int().positive(), req.params.id);
      const reservation = await fetchReservationDetails(db, req.propertyId, id);
      if (!reservation) return res.status(404).json({ error: { code: 'RESERVATION_NOT_FOUND', message: 'Reservation not found' } });
      return res.json({ data: reservation });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/reservations/:id', requirePermission(db, 'reservations.edit'), async (req, res, next) => {
    let id;
    let connection;
    try {
      id = parse(z.coerce.number().int().positive(), req.params.id);
      const data = parse(updateSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const existing = await reservationRow(connection, req.propertyId, id, true);
      if (!existing) throw httpError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found');
      if (!['tentative', 'confirmed'].includes(existing.status)) {
        throw httpError(409, 'RESERVATION_LOCKED', 'Only tentative or confirmed reservations can be modified');
      }
      const currentLines = await fetchReservationDetails(connection, req.propertyId, id);
      const checkInDate = data.checkInDate ?? dateOnly(existing.check_in_date);
      const checkOutDate = data.checkOutDate ?? dateOnly(existing.check_out_date);
      const nights = stayNights(checkInDate, checkOutDate);
      await validateFutureDate(connection, req.propertyId, checkInDate);
      const lines = data.rooms ?? currentLines.rooms.map((line) => ({
        roomTypeId: line.roomTypeId,
        roomId: line.roomId,
        ratePlanId: existing.rate_plan_id,
        adults: line.adults,
        children: line.children,
      }));
      await lockRoomTypes(connection, req.propertyId, lines.map((line) => line.roomTypeId));
      const guestIds = await ensureGuests(
        connection,
        req.propertyId,
        data.primaryGuestId ?? Number(existing.primary_guest_id),
        data.guestIds ?? currentLines.guests.map((guest) => guest.id),
      );
      const primaryGuestId = data.primaryGuestId ?? Number(existing.primary_guest_id);
      await verifyAssociation(connection, 'companies', req.propertyId, data.companyId ?? existing.company_id, 'INVALID_COMPANY', 'Company');
      await verifyAssociation(connection, 'groups', req.propertyId, data.groupId ?? existing.group_id, 'INVALID_GROUP', 'Group');
      for (const line of lines) {
        if (!line.ratePlanId) line.ratePlanId = await getDefaultRatePlan(connection, req.propertyId, line.roomTypeId);
      }
      const quotes = await quoteRoomLines(connection, req.propertyId, lines, checkInDate, checkOutDate);
      await connection.execute(
        'DELETE FROM room_nights WHERE property_id = ? AND reservation_id = ?',
        [req.propertyId, id],
      );
      const rooms = await verifyAndReserveRoomLines(
        connection, req.propertyId, lines, checkInDate, checkOutDate, id,
      );
      const before = {
        status: existing.status,
        checkInDate: dateOnly(existing.check_in_date),
        checkOutDate: dateOnly(existing.check_out_date),
        totalEstimate: String(existing.total_estimate),
      };
      const status = data.status ?? existing.status;
      const totalEstimate = formatCents(quotes.totalCents);
      await connection.execute('DELETE FROM reservation_rooms WHERE property_id = ? AND reservation_id = ?', [req.propertyId, id]);
      await connection.execute('DELETE FROM reservation_guests WHERE property_id = ? AND reservation_id = ?', [req.propertyId, id]);
      await connection.execute(
        `UPDATE reservations SET primary_guest_id = ?, company_id = ?, group_id = ?, source = ?,
          status = ?, check_in_date = ?, check_out_date = ?, adults = ?, children = ?,
          room_type_id = ?, assigned_room_id = ?, rate_plan_id = ?, total_estimate = ?, special_requests = ?
         WHERE id = ? AND property_id = ?`,
        [
          primaryGuestId,
          data.companyId === undefined ? existing.company_id : data.companyId,
          data.groupId === undefined ? existing.group_id : data.groupId,
          data.source ?? existing.source,
          status,
          checkInDate,
          checkOutDate,
          lines.reduce((total, line) => total + line.adults, 0),
          lines.reduce((total, line) => total + line.children, 0),
          lines[0].roomTypeId,
          rooms[0]?.id ?? null,
          lines[0].ratePlanId,
          totalEstimate,
          data.specialRequests === undefined ? existing.special_requests : data.specialRequests,
          id,
          req.propertyId,
        ],
      );
      await storeReservationRooms(connection, req.propertyId, id, lines, rooms, quotes);
      await insertGuestLinks(connection, req.propertyId, id, primaryGuestId, guestIds);
      for (const room of rooms) if (room) await insertRoomNights(connection, req.propertyId, id, room.id, nights);
      await writeHistory(connection, req, id, {
        action: 'modified',
        fromStatus: existing.status,
        toStatus: status,
        before,
        after: {
          checkInDate,
          checkOutDate,
          roomCount: lines.length,
          totalEstimate,
          changedFields: Object.keys(data).filter((key) => key !== 'reason'),
        },
        reason: data.reason,
      });
      const after = {
        confirmationNo: existing.confirmation_no,
        status,
        checkInDate,
        checkOutDate,
        roomCount: lines.length,
        totalEstimate,
      };
      const [property] = await connection.execute('SELECT organization_id FROM properties WHERE id = ?', [req.propertyId]);
      await auditable(connection, {
        organizationId: req.auth.orgId ?? property[0].organization_id,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'reservation.modify',
        entity: 'reservation',
        entityId: id,
        before,
        after: { ...after, reason: data.reason },
      });
      await connection.commit();
      const reservation = await fetchReservationDetails(db, req.propertyId, id);
      return res.json({ data: reservation });
    } catch (error) {
      if (connection) await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: { code: 'ROOM_UNAVAILABLE', message: 'Selected room is no longer available' } });
      }
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/reservations/:id/extend', requirePermission(db, 'reservations.edit'), async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const data = parse(z.object({
        checkOutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        reason: z.string().trim().min(3).max(500),
      }), req.body);
      const existing = await reservationRow(db, req.propertyId, id);
      if (!existing) throw httpError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found');
      if (data.checkOutDate <= dateOnly(existing.check_out_date)) throw httpError(400, 'INVALID_EXTENSION', 'New checkout date must be later than the current checkout date');
      const details = await fetchReservationDetails(db, req.propertyId, id);
      const updated = await modifyDatesAndRooms(db, req, existing, details, dateOnly(existing.check_in_date), data.checkOutDate, data.reason, 'extended');
      return res.json({ data: updated });
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: { code: 'ROOM_UNAVAILABLE', message: 'The extension overlaps an existing reservation' } });
      return next(error);
    }
  });

  router.post('/reservations/:id/move', requirePermission(db, 'reservations.edit'), async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const data = parse(moveSchema, req.body);
      const existing = await reservationRow(db, req.propertyId, id);
      if (!existing) throw httpError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found');
      if (!['tentative', 'confirmed'].includes(existing.status)) throw httpError(409, 'RESERVATION_LOCKED', 'Only unarrived reservations can be moved');
      const details = await fetchReservationDetails(db, req.propertyId, id);
      const checkInDate = data.checkInDate ?? dateOnly(existing.check_in_date);
      const checkOutDate = data.checkOutDate ?? dateOnly(existing.check_out_date);
      const lines = details.rooms.map((line, index) => ({
        roomTypeId: line.roomTypeId,
        roomId: index === 0 ? data.roomId : line.roomId,
        ratePlanId: Number(existing.rate_plan_id),
        adults: line.adults,
        children: line.children,
      }));
      const updated = await modifyDatesAndRooms(
        db, req, existing, details, checkInDate, checkOutDate, data.reason, 'moved', lines,
      );
      return res.json({ data: updated });
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: { code: 'ROOM_UNAVAILABLE', message: 'The requested room or dates are no longer available' } });
      return next(error);
    }
  });

  router.post('/reservations/:id/cancel', requirePermission(db, 'reservations.cancel'), async (req, res, next) => {
    let connection;
    try {
      const id = parse(z.coerce.number().int().positive(), req.params.id);
      const data = parse(cancellationSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const existing = await reservationRow(connection, req.propertyId, id, true);
      if (!existing) throw httpError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found');
      if (!['tentative', 'confirmed'].includes(existing.status)) throw httpError(409, 'RESERVATION_LOCKED', 'Only tentative or confirmed reservations can be cancelled');
      await lockRoomTypes(connection, req.propertyId, [Number(existing.room_type_id)]);
      await connection.execute('DELETE FROM room_nights WHERE property_id = ? AND reservation_id = ?', [req.propertyId, id]);
      await connection.execute('UPDATE reservations SET status = ? WHERE id = ? AND property_id = ?', ['cancelled', id, req.propertyId]);
      const before = { status: existing.status, checkInDate: dateOnly(existing.check_in_date), checkOutDate: dateOnly(existing.check_out_date) };
      const after = { status: 'cancelled', cancellationFee: data.cancellationFee };
      await writeHistory(connection, req, id, {
        action: 'cancelled',
        fromStatus: existing.status,
        toStatus: 'cancelled',
        before,
        after,
        reason: data.reason,
      });
      const [property] = await connection.execute('SELECT organization_id FROM properties WHERE id = ?', [req.propertyId]);
      await auditable(connection, {
        organizationId: req.auth.orgId ?? property[0].organization_id,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'reservation.cancel',
        entity: 'reservation',
        entityId: id,
        before,
        after: { ...after, reason: data.reason },
      });
      await connection.commit();
      return res.json({ data: { id, status: 'cancelled', cancellationFee: data.cancellationFee } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/reservations/:id/no-show', requirePermission(db, 'reservations.cancel'), async (req, res, next) => {
    let connection;
    try {
      const id = parse(z.coerce.number().int().positive(), req.params.id);
      const { reason } = parse(statusReasonSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const existing = await reservationRow(connection, req.propertyId, id, true);
      if (!existing) throw httpError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found');
      if (existing.status !== 'confirmed') throw httpError(409, 'INVALID_STATUS_TRANSITION', 'Only confirmed reservations can be marked no-show');
      const [propertyRows] = await connection.execute('SELECT business_date FROM properties WHERE id = ?', [req.propertyId]);
      const businessDate = dateOnly(propertyRows[0]?.business_date) ?? new Date().toISOString().slice(0, 10);
      if (dateOnly(existing.check_in_date) > businessDate) throw httpError(409, 'ARRIVAL_NOT_DUE', 'Reservation arrival date has not been reached');
      await lockRoomTypes(connection, req.propertyId, [Number(existing.room_type_id)]);
      await connection.execute('DELETE FROM room_nights WHERE property_id = ? AND reservation_id = ?', [req.propertyId, id]);
      await connection.execute('UPDATE reservations SET status = ? WHERE id = ? AND property_id = ?', ['no_show', id, req.propertyId]);
      await writeHistory(connection, req, id, {
        action: 'no_show',
        fromStatus: existing.status,
        toStatus: 'no_show',
        reason,
      });
      await auditable(connection, {
        organizationId: req.auth.orgId,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'reservation.no_show',
        entity: 'reservation',
        entityId: id,
        before: { status: existing.status },
        after: { status: 'no_show', reason },
      });
      await connection.commit();
      return res.json({ data: { id, status: 'no_show' } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.use((error, _req, res, next) => {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    if (status >= 500) logger.error({ code: error?.code }, 'Reservation API request failed');
    if (res.headersSent) return next(error);
    const payload = {
      code: error?.code ?? 'INTERNAL_ERROR',
      message: status === 500 ? 'The reservation request could not be completed' : error.message,
    };
    if (error?.details) payload.details = error.details;
    return res.status(status).json({ error: payload });
  });
  return router;
}

async function modifyDatesAndRooms(db, req, existing, details, checkInDate, checkOutDate, reason, action, requestedLines = null) {
  const lines = requestedLines ?? details.rooms.map((line) => ({
    roomTypeId: line.roomTypeId,
    roomId: line.roomId,
    ratePlanId: Number(existing.rate_plan_id),
    adults: line.adults,
    children: line.children,
  }));
  const nights = stayNights(checkInDate, checkOutDate);
  await validateFutureDate(db, req.propertyId, checkInDate);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const locked = await reservationRow(connection, req.propertyId, Number(existing.id), true);
    if (!locked || !['tentative', 'confirmed'].includes(locked.status)) {
      throw httpError(409, 'RESERVATION_LOCKED', 'Only tentative or confirmed reservations can be changed');
    }
    await lockRoomTypes(connection, req.propertyId, lines.map((line) => line.roomTypeId));
    for (const line of lines) {
      if (!line.ratePlanId) line.ratePlanId = await getDefaultRatePlan(connection, req.propertyId, line.roomTypeId);
    }
    const quotes = await quoteRoomLines(connection, req.propertyId, lines, checkInDate, checkOutDate);
    await connection.execute('DELETE FROM room_nights WHERE property_id = ? AND reservation_id = ?', [req.propertyId, existing.id]);
    const rooms = await verifyAndReserveRoomLines(
      connection, req.propertyId, lines, checkInDate, checkOutDate, Number(existing.id),
    );
    const totalEstimate = formatCents(quotes.totalCents);
    await connection.execute(
      `UPDATE reservations SET check_in_date = ?, check_out_date = ?, room_type_id = ?,
         assigned_room_id = ?, rate_plan_id = ?, adults = ?, children = ?, total_estimate = ?
       WHERE id = ? AND property_id = ?`,
      [
        checkInDate,
        checkOutDate,
        lines[0].roomTypeId,
        rooms[0]?.id ?? null,
        lines[0].ratePlanId,
        lines.reduce((total, line) => total + line.adults, 0),
        lines.reduce((total, line) => total + line.children, 0),
        totalEstimate,
        existing.id,
        req.propertyId,
      ],
    );
    await connection.execute('DELETE FROM reservation_rooms WHERE property_id = ? AND reservation_id = ?', [req.propertyId, existing.id]);
    await storeReservationRooms(connection, req.propertyId, Number(existing.id), lines, rooms, quotes);
    for (const room of rooms) if (room) await insertRoomNights(connection, req.propertyId, Number(existing.id), room.id, nights);
    const before = {
      checkInDate: dateOnly(locked.check_in_date),
      checkOutDate: dateOnly(locked.check_out_date),
      assignedRoomId: locked.assigned_room_id === null ? null : Number(locked.assigned_room_id),
      totalEstimate: String(locked.total_estimate),
    };
    await writeHistory(connection, req, Number(existing.id), {
      action,
      fromStatus: locked.status,
      toStatus: locked.status,
      before,
      after: {
        checkInDate,
        checkOutDate,
        assignedRoomId: rooms[0]?.id ?? null,
        totalEstimate,
      },
      reason,
    });
    const { auditable } = await import('../auth/audit.js');
    await auditable(connection, {
      organizationId: req.auth.orgId,
      propertyId: req.propertyId,
      actorId: req.auth.sub,
      ip: req.ip,
      action: `reservation.${action}`,
      entity: 'reservation',
      entityId: existing.id,
      before,
      after: { checkInDate, checkOutDate, assignedRoomId: rooms[0]?.id ?? null, totalEstimate, reason },
    });
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return fetchReservationDetails(db, req.propertyId, Number(existing.id));
}
