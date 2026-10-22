import { Router } from 'express';
import { z } from 'zod';
import { auditable } from '../auth/audit.js';
import { authenticate, propertyScope, requirePermission } from '../auth/middleware.js';
import { logger } from '../config/logger.js';
import { hashIdNumber, encryptIdNumber, idNumberLast4 } from '../guests/pii.js';
import { getAvailability, stayNights } from '../reservations/availability.js';
import { quote } from '../property/rate-calculator.js';
import { createHousekeepingTask } from '../housekeeping/tasks.js';
import { publishRoomStatus } from '../realtime.js';

const positiveId = z.coerce.number().int().positive();
const moneyValue = z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/).default('0.00');
const checkInSchema = z.object({
  roomIds: z.array(positiveId).min(1).max(20),
  earlyCheckIn: z.boolean().default(false),
  depositAmount: moneyValue,
  idType: z.string().trim().min(1).max(40).optional(),
  idNumber: z.string().trim().min(1).max(120).optional(),
  paymentTerms: z.string().trim().max(500).nullable().optional(),
});
const walkInSchema = z.object({
  guest: z.object({
    firstName: z.string().trim().min(1).max(120),
    lastName: z.string().trim().min(1).max(120),
    phone: z.string().trim().max(40).nullable().optional(),
    email: z.string().trim().email().max(190).nullable().optional(),
    nationality: z.string().trim().max(80).nullable().optional(),
    idType: z.string().trim().min(1).max(40).optional(),
    idNumber: z.string().trim().min(1).max(120).optional(),
  }),
  roomId: positiveId,
  ratePlanId: positiveId.optional(),
  adults: z.coerce.number().int().min(1).max(20).default(1),
  children: z.coerce.number().int().min(0).max(20).default(0),
  specialRequests: z.string().trim().max(5000).nullable().optional(),
  earlyCheckIn: z.boolean().default(false),
  depositAmount: moneyValue,
  paymentTerms: z.string().trim().max(500).nullable().optional(),
});
const roomMoveSchema = z.object({
  roomId: positiveId,
  reason: z.string().trim().min(3).max(500),
  approveRateChange: z.boolean().default(false),
});
const stayDateSchema = z.object({
  checkOutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().trim().min(3).max(500),
});
const addGuestSchema = z.object({ guestId: positiveId });
const stayRequestSchema = z.object({
  guestId: positiveId.optional(),
  type: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(5000),
  assignedDepartmentId: positiveId.optional(),
});
const checkoutSchema = z.object({
  lateCheckout: z.boolean().default(false),
  approveCredit: z.boolean().default(false),
  creditReason: z.string().trim().min(3).max(500).optional(),
});

function httpError(status, code, message, details = undefined) {
  return Object.assign(new Error(message), { status, code, details });
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

function cents(value) {
  const [whole, fraction = ''] = String(value ?? '0').split('.');
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
}

function money(value) {
  const amount = BigInt(value);
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function sqlDateAfter(date, nights = 1) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + nights);
  return value.toISOString().slice(0, 10);
}

async function propertyRow(connection, propertyId) {
  const [rows] = await connection.execute(
    `SELECT organization_id, business_date, currency, tax_settings,
            require_id_at_checkin, early_checkin_fee, late_checkout_fee
     FROM properties WHERE id = ? LIMIT 1`,
    [propertyId],
  );
  if (!rows[0]) throw httpError(404, 'PROPERTY_NOT_FOUND', 'Property not found');
  return rows[0];
}

async function reservationForUpdate(connection, propertyId, reservationId) {
  const [rows] = await connection.execute(
    `SELECT * FROM reservations WHERE property_id = ? AND id = ? FOR UPDATE`,
    [propertyId, reservationId],
  );
  if (!rows[0]) throw httpError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found');
  return rows[0];
}

async function reservationLines(connection, reservation) {
  const [rows] = await connection.execute(
    `SELECT line.id, line.room_type_id, line.room_id, line.adults, line.children,
            line.nightly_rate, type.name AS room_type, room.room_number
     FROM reservation_rooms line
     JOIN room_types type ON type.id = line.room_type_id AND type.property_id = line.property_id
     LEFT JOIN rooms room ON room.id = line.room_id AND room.property_id = line.property_id
     WHERE line.property_id = ? AND line.reservation_id = ? ORDER BY line.id`,
    [reservation.property_id, reservation.id],
  );
  if (rows.length) return rows;
  if (reservation.assigned_room_id === null) {
    return [{
      id: null,
      room_type_id: reservation.room_type_id,
      room_id: null,
      adults: reservation.adults,
      children: reservation.children,
      nightly_rate: null,
    }];
  }
  const [legacyRooms] = await connection.execute(
    `SELECT room.room_type_id, room.id AS room_id, room.room_number,
            type.name AS room_type
     FROM rooms room
     JOIN room_types type ON type.id = room.room_type_id AND type.property_id = room.property_id
     WHERE room.property_id = ? AND room.id = ?`,
    [reservation.property_id, reservation.assigned_room_id],
  );
  return [{
    id: null,
    room_type_id: legacyRooms[0]?.room_type_id ?? reservation.room_type_id,
    room_id: legacyRooms[0]?.room_id ?? reservation.assigned_room_id,
    room_number: legacyRooms[0]?.room_number ?? null,
    room_type: legacyRooms[0]?.room_type ?? null,
    adults: reservation.adults,
    children: reservation.children,
    nightly_rate: null,
  }];
}

async function cleanRoomAlternatives(connection, propertyId, roomTypeId, checkInDate, checkOutDate) {
  const [rows] = await connection.execute(
    `SELECT room.id, room.room_number, room.room_type_id, type.name AS room_type
     FROM rooms room
     JOIN room_types type ON type.id = room.room_type_id AND type.property_id = room.property_id
     WHERE room.property_id = ? AND room.room_type_id = ? AND room.is_active = 1
       AND room.deleted_at IS NULL AND room.status = 'CLEAN'
       AND NOT EXISTS (
         SELECT 1 FROM maintenance_tickets ticket
         WHERE ticket.property_id = room.property_id AND ticket.room_id = room.id
           AND ticket.blocks_room = 1 AND ticket.status <> 'closed'
       )
       AND NOT EXISTS (
         SELECT 1 FROM room_nights rn
         JOIN reservations reservation ON reservation.id = rn.reservation_id
           AND reservation.property_id = rn.property_id
         WHERE rn.property_id = room.property_id AND rn.room_id = room.id
           AND rn.night >= ? AND rn.night < ?
           AND reservation.status IN ('tentative', 'confirmed', 'checked_in')
       )
     ORDER BY room.room_number LIMIT 20`,
    [propertyId, roomTypeId, checkInDate, checkOutDate],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    roomNumber: row.room_number,
    roomTypeId: Number(row.room_type_id),
    roomType: row.room_type,
  }));
}

async function requireCleanRoom(connection, propertyId, roomId, roomTypeId, checkInDate, checkOutDate, reservationId = null) {
  const [rows] = await connection.execute(
    `SELECT room.id, room.room_number, room.room_type_id, room.status
     FROM rooms room
     WHERE room.property_id = ? AND room.id = ? AND room.is_active = 1 AND room.deleted_at IS NULL
     FOR UPDATE`,
    [propertyId, roomId],
  );
  const room = rows[0];
  const [maintenance] = room ? await connection.execute(
    `SELECT id FROM maintenance_tickets
     WHERE property_id = ? AND room_id = ? AND blocks_room = 1 AND status <> 'closed'
     LIMIT 1`,
    [propertyId, roomId],
  ) : [[]];
  const [conflicts] = room ? await connection.execute(
    `SELECT rn.id FROM room_nights rn
     JOIN reservations reservation ON reservation.id = rn.reservation_id
       AND reservation.property_id = rn.property_id
     WHERE rn.property_id = ? AND rn.room_id = ?
       AND rn.night >= ? AND rn.night < ?
       AND reservation.status IN ('tentative', 'confirmed', 'checked_in')
       AND (? IS NULL OR reservation.id <> ?) LIMIT 1`,
    [propertyId, roomId, checkInDate, checkOutDate, reservationId, reservationId],
  ) : [[]];
  if (!room || Number(room.room_type_id) !== Number(roomTypeId)
    || room.status !== 'CLEAN'
    || maintenance.length || conflicts.length) {
    const assignableRooms = await cleanRoomAlternatives(connection, propertyId, roomTypeId, checkInDate, checkOutDate);
    throw httpError(
      409,
      room?.status === 'BLOCKED_MAINTENANCE' || maintenance.length ? 'ROOM_BLOCKED' : 'ROOM_NOT_READY',
      'Choose a clean, unblocked room with no active reservation conflict',
      { assignableRooms },
    );
  }
  return room;
}

async function appendRoomStatus(connection, propertyId, roomId, fromStatus, toStatus, actorId, reason) {
  await connection.execute(
    `INSERT INTO room_status_history
      (property_id, room_id, from_status, to_status, reason, changed_by, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
    [propertyId, roomId, fromStatus, toStatus, reason, actorId],
  );
  await connection.execute(
    `UPDATE rooms SET status = ? WHERE property_id = ? AND id = ?`,
    [toStatus, propertyId, roomId],
  );
}

async function reservationHistory(connection, propertyId, reservationId, actorId, action, fromStatus, toStatus, before, after, reason = null) {
  await connection.execute(
    `INSERT INTO reservation_history
      (property_id, reservation_id, actor_id, action, from_status, to_status, before_state, after_state, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      propertyId,
      reservationId,
      actorId,
      action,
      fromStatus,
      toStatus,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      reason,
    ],
  );
}

async function getGuestForCheckIn(connection, propertyId, guestId, requireId) {
  const [rows] = await connection.execute(
    `SELECT id, first_name, last_name, id_number_enc, anonymised_at, deleted_at
     FROM guests WHERE property_id = ? AND id = ? FOR UPDATE`,
    [propertyId, guestId],
  );
  const guest = rows[0];
  if (!guest || guest.deleted_at || guest.anonymised_at) throw httpError(409, 'GUEST_UNAVAILABLE', 'The reservation guest is unavailable');
  if (requireId && !guest.id_number_enc) throw httpError(400, 'GUEST_ID_REQUIRED', 'Capture and save the guest identity number before check-in');
  return guest;
}

async function saveGuestIdentity(connection, propertyId, guestId, idType, idNumber) {
  if (!idNumber) return;
  const digest = hashIdNumber(idNumber);
  const [duplicates] = await connection.execute(
    `SELECT id FROM guests WHERE property_id = ? AND id_number_hash = ? AND id <> ?
     AND deleted_at IS NULL AND anonymised_at IS NULL LIMIT 1`,
    [propertyId, digest, guestId],
  );
  if (duplicates.length) throw httpError(409, 'DUPLICATE_IDENTITY', 'This identity number belongs to another guest in the property');
  await connection.execute(
    `UPDATE guests SET id_type = ?, id_number_enc = ?, id_number_hash = ?, id_number_last4 = ?
     WHERE property_id = ? AND id = ? AND deleted_at IS NULL AND anonymised_at IS NULL`,
    [idType ?? null, encryptIdNumber(idNumber), digest, idNumberLast4(idNumber), propertyId, guestId],
  );
}

async function ensureNightsAvailable(connection, propertyId, reservationId, lines, checkInDate, checkOutDate) {
  const nights = stayNights(checkInDate, checkOutDate);
  const availability = await getAvailability(connection, propertyId, checkInDate, checkOutDate, {
    excludeReservationId: reservationId,
  });
  const byNightType = new Map();
  for (const night of availability) {
    for (const type of night.roomTypes) byNightType.set(`${night.date}:${type.id}`, type.availableRooms);
  }
  const needed = new Map();
  for (const line of lines) {
    if (line.room_id !== null) continue;
    for (const night of nights) {
      const key = `${night}:${line.room_type_id}`;
      needed.set(key, (needed.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of needed) {
    if ((byNightType.get(key) ?? 0) < count) {
      throw httpError(409, 'ROOM_UNAVAILABLE', 'There is not enough room-type inventory for the stay dates');
    }
  }
  return nights;
}

async function replaceRoomNights(connection, propertyId, reservationId, lines, nights) {
  await connection.execute(
    'DELETE FROM room_nights WHERE property_id = ? AND reservation_id = ?',
    [propertyId, reservationId],
  );
  for (const line of lines) {
    if (line.room_id === null) continue;
    for (const night of nights) {
      await connection.execute(
        'INSERT INTO room_nights (property_id, room_id, night, reservation_id) VALUES (?, ?, ?, ?)',
        [propertyId, line.room_id, night, reservationId],
      );
    }
  }
}

async function addFolioCharge(connection, propertyId, folioId, description, amount, businessDate, actorId) {
  if (cents(amount) === 0n) return;
  await connection.execute(
    `INSERT INTO folio_charges
      (property_id, folio_id, charge_type, description, quantity, unit_amount, amount, business_date, posted_by)
     VALUES (?, ?, 'other', ?, 1, ?, ?, ?, ?)`,
    [propertyId, folioId, description, amount, amount, businessDate, actorId],
  );
}

async function folioTotals(connection, propertyId, folioId) {
  const [rows] = await connection.execute(
    `SELECT
       COALESCE((SELECT SUM(amount) FROM folio_charges WHERE property_id = ? AND folio_id = ?), 0) AS charges,
       COALESCE((SELECT SUM(amount) FROM folio_payments WHERE property_id = ? AND folio_id = ?), 0) AS payments,
       COALESCE((SELECT SUM(CASE type
         WHEN 'discount' THEN -amount WHEN 'write_off' THEN -amount
         WHEN 'correction' THEN amount ELSE 0 END)
         FROM adjustments WHERE property_id = ? AND folio_id = ? AND status = 'approved'), 0) AS adjustments`,
    [propertyId, folioId, propertyId, folioId, propertyId, folioId],
  );
  const totalCharges = cents(rows[0].charges);
  const totalPayments = cents(rows[0].payments);
  const totalAdjustments = cents(rows[0].adjustments);
  return {
    totalCharges: money(totalCharges),
    totalPayments: money(totalPayments),
    totalAdjustments: money(totalAdjustments),
    balance: money(totalCharges - totalPayments + totalAdjustments),
    balanceCents: totalCharges - totalPayments + totalAdjustments,
  };
}

async function allocateInvoiceNumber(connection, propertyId) {
  await connection.execute(
    `INSERT INTO number_counters (property_id, kind, next_value)
     VALUES (?, 'invoice', 1)
     ON DUPLICATE KEY UPDATE next_value = next_value`,
    [propertyId],
  );
  const [rows] = await connection.execute(
    `SELECT next_value FROM number_counters WHERE property_id = ? AND kind = 'invoice' FOR UPDATE`,
    [propertyId],
  );
  const number = Number(rows[0].next_value);
  await connection.execute(
    `UPDATE number_counters SET next_value = ? WHERE property_id = ? AND kind = 'invoice'`,
    [number + 1, propertyId],
  );
  return `INV-${String(propertyId).padStart(3, '0')}-${String(number).padStart(8, '0')}`;
}

async function checkInReservation(
  connection,
  req,
  reservationId,
  roomIds,
  earlyCheckIn,
  depositAmount,
  paymentTerms,
  idType,
  idNumber,
) {
  const property = await propertyRow(connection, req.propertyId);
  const reservation = await reservationForUpdate(connection, req.propertyId, reservationId);
  if (!['tentative', 'confirmed'].includes(reservation.status)) {
    throw httpError(409, 'INVALID_RESERVATION_STATE', 'Only tentative or confirmed reservations can be checked in');
  }
  const businessDate = dateOnly(property.business_date) ?? new Date().toISOString().slice(0, 10);
  let checkInDate = dateOnly(reservation.check_in_date);
  if (checkInDate > businessDate) {
    if (!earlyCheckIn) throw httpError(409, 'ARRIVAL_NOT_DUE', 'Reservation arrival date has not been reached');
    checkInDate = businessDate;
  }
  await saveGuestIdentity(
    connection, req.propertyId, Number(reservation.primary_guest_id), idType, idNumber,
  );
  const guest = await getGuestForCheckIn(
    connection,
    req.propertyId,
    Number(reservation.primary_guest_id),
    Boolean(property.require_id_at_checkin),
  );
  const lines = await reservationLines(connection, reservation);
  if (roomIds.length !== lines.length) throw httpError(400, 'ROOM_ASSIGNMENT_REQUIRED', 'Choose one room for each reservation room');
  const nights = await ensureNightsAvailable(
    connection, req.propertyId, reservationId, lines, checkInDate, dateOnly(reservation.check_out_date),
  );
  const assigned = [];
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const roomId = Number(roomIds[index]);
    if (seen.has(roomId)) throw httpError(400, 'DUPLICATE_ROOM_ASSIGNMENT', 'Each reservation room must use a different room');
    seen.add(roomId);
    const room = await requireCleanRoom(
      connection,
      req.propertyId,
      roomId,
      Number(lines[index].room_type_id),
      checkInDate,
      dateOnly(reservation.check_out_date),
      reservationId,
    );
    assigned.push({ ...lines[index], room_id: roomId, room_number: room.room_number, old_room_status: room.status });
  }
  await replaceRoomNights(connection, req.propertyId, reservationId, assigned, nights);

  const stayIds = [];
  for (const line of assigned) {
    if (line.id !== null) {
      await connection.execute(
        'UPDATE reservation_rooms SET room_id = ? WHERE property_id = ? AND reservation_id = ? AND id = ?',
        [line.room_id, req.propertyId, reservationId, line.id],
      );
    } else {
      const [insertedLine] = await connection.execute(
        `INSERT INTO reservation_rooms
          (property_id, reservation_id, room_type_id, room_id, adults, children, nightly_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          req.propertyId, reservationId, line.room_type_id, line.room_id,
          line.adults, line.children, line.nightly_rate ?? null,
        ],
      );
      line.id = Number(insertedLine.insertId);
    }
    const [stay] = await connection.execute(
      `INSERT INTO stays (property_id, reservation_id, room_id, checked_in_at, status, key_card_count)
       VALUES (?, ?, ?, NOW(), 'in_house', 0)`,
      [req.propertyId, reservationId, line.room_id],
    );
    const stayId = Number(stay.insertId);
    stayIds.push(stayId);
    const [folio] = await connection.execute(
      `INSERT INTO folios
        (property_id, stay_id, guest_id, company_id, status, opened_at, deposit_required, payment_terms)
       VALUES (?, ?, ?, ?, 'open', NOW(), ?, ?)`,
      [
        req.propertyId, stayId, reservation.primary_guest_id, reservation.company_id,
        depositAmount, paymentTerms ?? null,
      ],
    );
    await appendRoomStatus(
      connection, req.propertyId, line.room_id, line.old_room_status, 'OCCUPIED', req.auth.sub, 'Guest check-in',
    );
    if (earlyCheckIn && cents(property.early_checkin_fee) > 0n) {
      await addFolioCharge(
        connection, req.propertyId, Number(folio.insertId), 'Early check-in fee',
        String(property.early_checkin_fee), businessDate, req.auth.sub,
      );
    }
  }
  const firstRoomId = assigned[0].room_id;
  await connection.execute(
    `UPDATE reservations SET status = 'checked_in', check_in_date = ?, assigned_room_id = ?
     WHERE property_id = ? AND id = ?`,
    [checkInDate, firstRoomId, req.propertyId, reservationId],
  );
  const after = {
    stayIds,
    roomIds: assigned.map((line) => line.room_id),
    checkedInAt: new Date().toISOString(),
    earlyCheckIn,
    idNumberCaptured: Boolean(idNumber || guest.id_number_enc),
    paymentTerms: paymentTerms ?? null,
  };
  await reservationHistory(
    connection, req.propertyId, reservationId, req.auth.sub, 'checked_in',
    reservation.status, 'checked_in',
    { checkInDate: dateOnly(reservation.check_in_date), roomIds: lines.map((line) => line.room_id) },
    after,
  );
  await auditable(connection, {
    organizationId: property.organization_id,
    propertyId: req.propertyId,
    actorId: req.auth.sub,
    ip: req.ip,
    action: 'stay.check_in',
    entity: 'reservation',
    entityId: reservationId,
    before: { status: reservation.status },
    after,
  });
  return { stayIds, reservationId, guestName: `${guest.first_name} ${guest.last_name}`, roomIds: assigned.map((line) => line.room_id) };
}

async function quotedTotal(connection, propertyId, roomTypeId, ratePlanId, adults, children, checkInDate, checkOutDate) {
  const [types] = await connection.execute(
    `SELECT id, property_id, name, max_adults, max_children, base_rate FROM room_types
     WHERE property_id = ? AND id = ? AND is_active = 1 AND deleted_at IS NULL`,
    [propertyId, roomTypeId],
  );
  const [plans] = await connection.execute(
    `SELECT id, name FROM rate_plans
     WHERE property_id = ? AND id = ? AND is_active = 1 AND deleted_at IS NULL`,
    [propertyId, ratePlanId],
  );
  if (!types[0] || !plans[0]) throw httpError(400, 'INVALID_RATE_CONFIGURATION', 'The room type or rate plan is unavailable');
  const [rates] = await connection.execute(
    `SELECT id, room_type_id, rate_plan_id, date_from, date_to, weekday_mask, amount, min_stay, created_at
     FROM rates WHERE property_id = ? AND room_type_id = ? AND rate_plan_id = ?
       AND date_from <= ? AND date_to >= ? ORDER BY date_from DESC, created_at DESC, id DESC`,
    [propertyId, roomTypeId, ratePlanId, checkOutDate, checkInDate],
  );
  const property = await propertyRow(connection, propertyId);
  const taxSettings = typeof property.tax_settings === 'string'
    ? JSON.parse(property.tax_settings)
    : property.tax_settings ?? {};
  return quote(
    { roomTypeId, ratePlanId, checkIn: checkInDate, checkOut: checkOutDate, adults, children },
    {
      roomTypes: [{ ...types[0], base_rate: String(types[0].base_rate), is_active: 1 }],
      ratePlans: [{ ...plans[0], property_id: propertyId, is_active: 1 }],
      rates,
      taxSettings,
    },
  );
}

export function createStayRouter(db) {
  const router = Router();
  router.use(authenticate(db), propertyScope(db));

  router.get('/stays/in-house', requirePermission(db, 'checkin.perform'), async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT stay.id, stay.reservation_id, stay.room_id, stay.checked_in_at, stay.key_card_count,
                room.room_number, reservation.confirmation_no, reservation.check_in_date,
                reservation.check_out_date, reservation.status AS reservation_status,
                guest.id AS guest_id, guest.first_name, guest.last_name, guest.phone,
                folio.id AS folio_id, folio.status AS folio_status,
                folio.deposit_required, folio.payment_terms,
                COALESCE(charges.amount, 0) AS total_charges,
                COALESCE(payments.amount, 0) AS total_payments,
                COALESCE(adjustments.amount, 0) AS total_adjustments
         FROM stays stay
         JOIN reservations reservation ON reservation.id = stay.reservation_id AND reservation.property_id = stay.property_id
         JOIN rooms room ON room.id = stay.room_id AND room.property_id = stay.property_id
         LEFT JOIN guests guest ON guest.id = reservation.primary_guest_id AND guest.property_id = reservation.property_id
         LEFT JOIN folios folio ON folio.stay_id = stay.id AND folio.property_id = stay.property_id
         LEFT JOIN (
           SELECT folio_id, SUM(amount) AS amount FROM folio_charges WHERE property_id = ? GROUP BY folio_id
         ) charges ON charges.folio_id = folio.id
         LEFT JOIN (
           SELECT folio_id, SUM(amount) AS amount FROM folio_payments WHERE property_id = ? GROUP BY folio_id
         ) payments ON payments.folio_id = folio.id
         LEFT JOIN (
           SELECT folio_id, SUM(CASE type WHEN 'discount' THEN -amount
             WHEN 'write_off' THEN -amount WHEN 'correction' THEN amount ELSE 0 END) AS amount
           FROM adjustments WHERE property_id = ? AND status = 'approved' GROUP BY folio_id
         ) adjustments ON adjustments.folio_id = folio.id
         WHERE stay.property_id = ? AND stay.status = 'in_house'
         ORDER BY reservation.check_out_date, guest.last_name, room.room_number`,
        [req.propertyId, req.propertyId, req.propertyId, req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id),
        reservationId: Number(row.reservation_id),
        confirmationNo: row.confirmation_no,
        roomId: Number(row.room_id),
        roomNumber: row.room_number,
        guestId: Number(row.guest_id),
        guestName: `${row.first_name} ${row.last_name}`,
        phone: row.phone,
        checkInDate: dateOnly(row.check_in_date),
        checkOutDate: dateOnly(row.check_out_date),
        checkedInAt: row.checked_in_at,
        keyCardCount: Number(row.key_card_count),
        folioId: Number(row.folio_id),
        folioStatus: row.folio_status,
        depositRequired: String(row.deposit_required ?? '0.00'),
        paymentTerms: row.payment_terms,
        balance: money(cents(row.total_charges) - cents(row.total_payments) + cents(row.total_adjustments)),
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/stays/:id', requirePermission(db, 'checkin.perform'), async (req, res, next) => {
    try {
      const id = parse(positiveId, req.params.id);
      const [rows] = await db.execute(
        `SELECT stay.id, stay.reservation_id, stay.room_id, stay.checked_in_at, stay.checked_out_at,
                stay.status, stay.key_card_count, room.room_number,
                reservation.confirmation_no, reservation.check_in_date, reservation.check_out_date,
                reservation.total_estimate, reservation.primary_guest_id, guest.first_name, guest.last_name,
                folio.id AS folio_id, folio.status AS folio_status,
                folio.deposit_required, folio.payment_terms
         FROM stays stay
         JOIN reservations reservation ON reservation.id = stay.reservation_id AND reservation.property_id = stay.property_id
         JOIN rooms room ON room.id = stay.room_id AND room.property_id = stay.property_id
         LEFT JOIN guests guest ON guest.id = reservation.primary_guest_id AND guest.property_id = reservation.property_id
         LEFT JOIN folios folio ON folio.stay_id = stay.id AND folio.property_id = stay.property_id
         WHERE stay.property_id = ? AND stay.id = ? LIMIT 1`,
        [req.propertyId, id],
      );
      if (!rows[0]) throw httpError(404, 'STAY_NOT_FOUND', 'Stay not found');
      const stay = rows[0];
      const [moves] = await db.execute(
        `SELECT move.from_room_id, old_room.room_number AS from_room,
                move.to_room_id, new_room.room_number AS to_room,
                move.reason, move.approved_by, move.moved_at
         FROM room_moves move
         JOIN rooms old_room ON old_room.id = move.from_room_id AND old_room.property_id = move.property_id
         JOIN rooms new_room ON new_room.id = move.to_room_id AND new_room.property_id = move.property_id
         WHERE move.property_id = ? AND move.stay_id = ? ORDER BY move.moved_at, move.id`,
        [req.propertyId, id],
      );
      const [folioRows] = stay.folio_id ? await db.execute(
        `SELECT id, charge_type, description, amount, business_date, created_at
         FROM folio_charges WHERE property_id = ? AND folio_id = ? ORDER BY created_at, id`,
        [req.propertyId, stay.folio_id],
      ) : [[]];
      const totals = stay.folio_id
        ? await folioTotals(db, req.propertyId, Number(stay.folio_id))
        : { totalCharges: '0.00', totalPayments: '0.00', balance: '0.00' };
      return res.json({ data: {
        id: Number(stay.id),
        reservationId: Number(stay.reservation_id),
        confirmationNo: stay.confirmation_no,
        roomId: Number(stay.room_id),
        roomNumber: stay.room_number,
        guestId: Number(stay.primary_guest_id),
        guestName: `${stay.first_name} ${stay.last_name}`,
        checkInDate: dateOnly(stay.check_in_date),
        checkOutDate: dateOnly(stay.check_out_date),
        checkedInAt: stay.checked_in_at,
        checkedOutAt: stay.checked_out_at,
        status: stay.status,
        keyCardCount: Number(stay.key_card_count),
        folio: {
          id: Number(stay.folio_id),
          status: stay.folio_status,
          depositRequired: String(stay.deposit_required ?? '0.00'),
          paymentTerms: stay.payment_terms,
          totalCharges: totals.totalCharges,
          totalPayments: totals.totalPayments,
          totalAdjustments: totals.totalAdjustments,
          balance: totals.balance,
          charges: folioRows,
        },
        roomMoves: moves.map((move) => ({
          fromRoomId: Number(move.from_room_id),
          fromRoom: move.from_room,
          toRoomId: Number(move.to_room_id),
          toRoom: move.to_room,
          reason: move.reason,
          approvedBy: move.approved_by === null ? null : Number(move.approved_by),
          movedAt: move.moved_at,
        })),
      } });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/reservations/:id/check-in', requirePermission(db, 'checkin.perform'), async (req, res, next) => {
    let connection;
    try {
      const reservationId = parse(positiveId, req.params.id);
      const data = parse(checkInSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const result = await checkInReservation(
        connection,
        req,
        reservationId,
        data.roomIds,
        data.earlyCheckIn,
        data.depositAmount,
        data.paymentTerms,
        data.idType,
        data.idNumber,
      );
      await connection.commit();
      for (const roomId of result.roomIds) publishRoomStatus(req.propertyId, { roomId, status: 'OCCUPIED' });
      const [stays] = await db.execute(
        `SELECT stay.id, stay.room_id, room.room_number, folio.id AS folio_id
         FROM stays stay JOIN rooms room ON room.id = stay.room_id AND room.property_id = stay.property_id
         LEFT JOIN folios folio ON folio.stay_id = stay.id AND folio.property_id = stay.property_id
         WHERE stay.property_id = ? AND stay.id IN (${result.stayIds.map(() => '?').join(',')})`,
        [req.propertyId, ...result.stayIds],
      );
      return res.status(201).json({ data: {
        reservationId,
        guestName: result.guestName,
        stays: stays.map((stay) => ({
          id: Number(stay.id),
          roomId: Number(stay.room_id),
          roomNumber: stay.room_number,
          folioId: Number(stay.folio_id),
        })),
      } });
    } catch (error) {
      if (connection) await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: { code: 'ROOM_UNAVAILABLE', message: 'The selected room is no longer available' } });
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/walk-ins', requirePermission(db, 'checkin.perform'), async (req, res, next) => {
    let connection;
    try {
      const data = parse(walkInSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const property = await propertyRow(connection, req.propertyId);
      if (property.require_id_at_checkin && !data.guest.idNumber) {
        throw httpError(400, 'GUEST_ID_REQUIRED', 'An identity number is required for walk-in check-in');
      }
      if (data.guest.idNumber) {
        const [duplicates] = await connection.execute(
          `SELECT id FROM guests WHERE property_id = ? AND id_number_hash = ?
           AND deleted_at IS NULL AND anonymised_at IS NULL LIMIT 1`,
          [req.propertyId, hashIdNumber(data.guest.idNumber)],
        );
        if (duplicates.length) throw httpError(409, 'POSSIBLE_DUPLICATE', 'A guest with this identity number already exists');
      }
      const phone = data.guest.phone?.trim() || null;
      const [guestResult] = await connection.execute(
        `INSERT INTO guests
          (organization_id, property_id, first_name, last_name, phone, email, nationality,
           id_type, id_number_enc, id_number_hash, id_number_last4, is_vip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          property.organization_id,
          req.propertyId,
          data.guest.firstName,
          data.guest.lastName,
          phone,
          data.guest.email?.toLowerCase() ?? null,
          data.guest.nationality ?? null,
          data.guest.idType ?? null,
          data.guest.idNumber ? encryptIdNumber(data.guest.idNumber) : null,
          data.guest.idNumber ? hashIdNumber(data.guest.idNumber) : null,
          data.guest.idNumber ? idNumberLast4(data.guest.idNumber) : null,
        ],
      );
      const guestId = Number(guestResult.insertId);
      const businessDate = dateOnly(property.business_date) ?? new Date().toISOString().slice(0, 10);
      const checkOutDate = sqlDateAfter(businessDate);
      const [roomRows] = await connection.execute(
        `SELECT room.id, room.room_type_id, room.status, type.base_rate
         FROM rooms room JOIN room_types type ON type.id = room.room_type_id AND type.property_id = room.property_id
         WHERE room.property_id = ? AND room.id = ?`,
        [req.propertyId, data.roomId],
      );
      if (!roomRows[0]) throw httpError(400, 'INVALID_ROOM', 'Selected room is not available in this property');
      const room = await requireCleanRoom(
        connection, req.propertyId, data.roomId, Number(roomRows[0].room_type_id),
        businessDate, checkOutDate,
      );
      const ratePlanId = data.ratePlanId ?? await getDefaultRatePlan(connection, req.propertyId, Number(room.room_type_id));
      const stayQuote = await quotedTotal(
        connection, req.propertyId, Number(room.room_type_id), ratePlanId,
        data.adults, data.children, businessDate, checkOutDate,
      );
      await connection.execute(
        `INSERT INTO number_counters (property_id, kind, next_value)
         VALUES (?, 'reservation', 1)
         ON DUPLICATE KEY UPDATE next_value = next_value`,
        [req.propertyId],
      );
      const [counterRows] = await connection.execute(
        `SELECT next_value FROM number_counters WHERE property_id = ? AND kind = 'reservation' FOR UPDATE`,
        [req.propertyId],
      );
      const confirmationNo = `R${String(req.propertyId).padStart(3, '0')}-${String(counterRows[0].next_value).padStart(8, '0')}`;
      await connection.execute(
        `UPDATE number_counters SET next_value = ? WHERE property_id = ? AND kind = 'reservation'`,
        [Number(counterRows[0].next_value) + 1, req.propertyId],
      );
      const totalEstimate = money(cents(stayQuote.totals.total));
      const [reservationResult] = await connection.execute(
        `INSERT INTO reservations
          (property_id, confirmation_no, primary_guest_id, source, status, check_in_date, check_out_date,
           adults, children, room_type_id, assigned_room_id, rate_plan_id, total_estimate, special_requests, created_by)
         VALUES (?, ?, ?, 'walk_in', 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.propertyId, confirmationNo, guestId, businessDate, checkOutDate,
          data.adults, data.children, room.room_type_id, room.id, ratePlanId,
          totalEstimate, data.specialRequests ?? null, req.auth.sub,
        ],
      );
      const reservationId = Number(reservationResult.insertId);
      await connection.execute(
        `INSERT INTO reservation_rooms
          (property_id, reservation_id, room_type_id, room_id, adults, children, nightly_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [req.propertyId, reservationId, room.room_type_id, room.id, data.adults, data.children, stayQuote.nightlyRates[0].rate],
      );
      await connection.execute(
        `INSERT INTO reservation_guests (property_id, reservation_id, guest_id, is_primary)
         VALUES (?, ?, ?, 1)`,
        [req.propertyId, reservationId, guestId],
      );
      await connection.execute(
        `INSERT INTO reservation_history
          (property_id, reservation_id, actor_id, action, to_status, after_state, reason)
         VALUES (?, ?, ?, 'created', 'confirmed', ?, 'Walk-in check-in')`,
        [req.propertyId, reservationId, req.auth.sub, JSON.stringify({ checkInDate: businessDate, checkOutDate, roomId: room.id })],
      );
      await connection.execute(
        `INSERT INTO room_nights (property_id, room_id, night, reservation_id)
         VALUES (?, ?, ?, ?)`,
        [req.propertyId, room.id, businessDate, reservationId],
      );
      const stay = await checkInReservation(
        connection, req, reservationId, [Number(room.id)], data.earlyCheckIn,
        data.depositAmount, data.paymentTerms, data.guest.idType, data.guest.idNumber,
      );
      await auditable(connection, {
        organizationId: property.organization_id,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'walk_in.create_and_check_in',
        entity: 'reservation',
        entityId: reservationId,
        after: { confirmationNo, guestId, roomId: Number(room.id), stayIds: stay.stayIds },
      });
      await connection.commit();
      publishRoomStatus(req.propertyId, { roomId: Number(room.id), status: 'OCCUPIED' });
      return res.status(201).json({ data: {
        reservationId,
        confirmationNo,
        guestId,
        stayId: stay.stayIds[0],
        roomId: Number(room.id),
        roomNumber: room.room_number,
        guestName: `${data.guest.firstName} ${data.guest.lastName}`,
        totalEstimate,
      } });
    } catch (error) {
      if (connection) await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: { code: 'ROOM_UNAVAILABLE', message: 'The selected room is no longer available' } });
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/stays/:id/extend', requirePermission(db, 'checkin.perform'), async (req, res, next) => {
    try {
      const data = await updateStayDates(db, req, parse(positiveId, req.params.id), parse(stayDateSchema, req.body), false);
      return res.json({ data });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/stays/:id/shorten', requirePermission(db, 'stays.shorten'), async (req, res, next) => {
    try {
      const data = await updateStayDates(db, req, parse(positiveId, req.params.id), parse(stayDateSchema, req.body), true);
      return res.json({ data });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/stays/:id/move', requirePermission(db, 'checkin.perform'), async (req, res, next) => {
    let connection;
    try {
      const id = parse(positiveId, req.params.id);
      const data = parse(roomMoveSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [stayRows] = await connection.execute(
        `SELECT stay.*, reservation.check_in_date, reservation.check_out_date,
                reservation.status AS reservation_status, reservation.primary_guest_id,
                reservation.rate_plan_id, reservation.total_estimate, reservation.confirmation_no
         FROM stays stay JOIN reservations reservation ON reservation.id = stay.reservation_id
           AND reservation.property_id = stay.property_id
         WHERE stay.property_id = ? AND stay.id = ? FOR UPDATE`,
        [req.propertyId, id],
      );
      const stay = stayRows[0];
      if (!stay) throw httpError(404, 'STAY_NOT_FOUND', 'Stay not found');
      if (stay.status !== 'in_house') throw httpError(409, 'STAY_NOT_ACTIVE', 'Only an in-house stay can be moved');
      if (Number(stay.room_id) === data.roomId) throw httpError(400, 'SAME_ROOM', 'Choose a different room');
      const [currentRooms] = await connection.execute(
        `SELECT room.room_type_id, room.room_number AS old_room_number,
                type.name AS room_type, line.id AS line_id, line.adults, line.children,
                line.nightly_rate
         FROM rooms room
         JOIN room_types type ON type.id = room.room_type_id AND type.property_id = room.property_id
         LEFT JOIN reservation_rooms line ON line.property_id = room.property_id
           AND line.reservation_id = ? AND line.room_id = room.id
         WHERE room.property_id = ? AND room.id = ?`,
        [stay.reservation_id, req.propertyId, stay.room_id],
      );
      const current = currentRooms[0];
      const [targetRooms] = await connection.execute(
        `SELECT room.id, room.room_type_id, room.status, room.room_number,
                type.max_adults, type.max_children
         FROM rooms room JOIN room_types type ON type.id = room.room_type_id AND type.property_id = room.property_id
         WHERE room.property_id = ? AND room.id = ?`,
        [req.propertyId, data.roomId],
      );
      if (!current || !targetRooms[0]) throw httpError(404, 'ROOM_NOT_FOUND', 'Room not found in this property');
      const [lineRows] = await connection.execute(
        `SELECT adults, children FROM reservation_rooms
         WHERE property_id = ? AND reservation_id = ? AND room_id = ? LIMIT 1`,
        [req.propertyId, stay.reservation_id, stay.room_id],
      );
      const adults = Number(lineRows[0]?.adults ?? 1);
      const children = Number(lineRows[0]?.children ?? 0);
      if (adults > Number(targetRooms[0].max_adults) || children > Number(targetRooms[0].max_children)) {
        throw httpError(409, 'ROOM_CAPACITY_EXCEEDED', 'The target room cannot accommodate the registered guests');
      }
      const target = await requireCleanRoom(
        connection,
        req.propertyId,
        data.roomId,
        Number(targetRooms[0].room_type_id),
        dateOnly(stay.check_in_date),
        dateOnly(stay.check_out_date),
        Number(stay.reservation_id),
      );
      const oldQuote = await quotedTotal(
        connection, req.propertyId, Number(current.room_type_id), Number(stay.rate_plan_id),
        adults, children, dateOnly(stay.check_in_date), dateOnly(stay.check_out_date),
      );
      const nextQuote = await quotedTotal(
        connection, req.propertyId, Number(target.room_type_id), Number(stay.rate_plan_id),
        adults, children, dateOnly(stay.check_in_date), dateOnly(stay.check_out_date),
      );
      const rateChanged = cents(oldQuote.totals.total) !== cents(nextQuote.totals.total);
      const permissionRows = rateChanged
        ? await db.execute(
          `SELECT role_permissions.permission_key FROM role_permissions
           WHERE role_permissions.role_id = ? AND role_permissions.permission_key = 'stays.rate_change_approve'`,
          [req.auth.roleId],
        )
        : [[]];
      if (rateChanged && (!data.approveRateChange || !permissionRows[0].length)) {
        throw httpError(403, 'RATE_CHANGE_APPROVAL_REQUIRED', 'A rate change requires explicit approval by an authorized manager');
      }
      const property = await propertyRow(connection, req.propertyId);
      const nights = stayNights(dateOnly(stay.check_in_date), dateOnly(stay.check_out_date));
      await connection.execute(
        'DELETE FROM room_nights WHERE property_id = ? AND reservation_id = ? AND room_id = ?',
        [req.propertyId, stay.reservation_id, stay.room_id],
      );
      for (const night of nights) {
        await connection.execute(
          'INSERT INTO room_nights (property_id, room_id, night, reservation_id) VALUES (?, ?, ?, ?)',
          [req.propertyId, data.roomId, night, stay.reservation_id],
        );
      }
      await connection.execute('UPDATE stays SET room_id = ? WHERE property_id = ? AND id = ?', [data.roomId, req.propertyId, id]);
      await connection.execute(
        `UPDATE reservation_rooms SET room_id = ?, room_type_id = ?, nightly_rate = ?
         WHERE property_id = ? AND reservation_id = ? AND room_id = ?`,
        [
          data.roomId, target.room_type_id, nextQuote.nightlyRates[0].rate,
          req.propertyId, stay.reservation_id, stay.room_id,
        ],
      );
      const newTotal = cents(stay.total_estimate) - cents(oldQuote.totals.total) + cents(nextQuote.totals.total);
      await connection.execute(
        `UPDATE reservations SET total_estimate = ?,
           room_type_id = IF(assigned_room_id = ?, ?, room_type_id),
           assigned_room_id = IF(assigned_room_id = ?, ?, assigned_room_id)
         WHERE property_id = ? AND id = ?`,
        [
          money(newTotal), stay.room_id, target.room_type_id, stay.room_id, data.roomId,
          req.propertyId, stay.reservation_id,
        ],
      );
      const [folios] = await connection.execute(
        `SELECT id FROM folios WHERE property_id = ? AND stay_id = ? AND status = 'open' LIMIT 1`,
        [req.propertyId, id],
      );
      if (folios[0] && rateChanged) {
        const difference = cents(nextQuote.totals.total) - cents(oldQuote.totals.total);
        if (difference !== 0n) await addFolioCharge(
          connection,
          req.propertyId,
          Number(folios[0].id),
          'Room move rate adjustment',
          money(difference),
          dateOnly(property.business_date),
          req.auth.sub,
        );
      }
      await appendRoomStatus(
        connection, req.propertyId, Number(stay.room_id), 'OCCUPIED', 'AWAITING_CLEANING', req.auth.sub, data.reason,
      );
      await createHousekeepingTask(connection, {
        propertyId: req.propertyId,
        roomId: Number(stay.room_id),
        type: 'checkout_clean',
        priority: 2,
        sourceRule: 'room_move',
        priorityReason: 'Room move: vacated room requires cleaning before assignment',
      });
      await appendRoomStatus(connection, req.propertyId, data.roomId, target.status, 'OCCUPIED', req.auth.sub, data.reason);
      await connection.execute(
        `INSERT INTO room_moves (property_id, stay_id, from_room_id, to_room_id, reason, approved_by, moved_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [req.propertyId, id, stay.room_id, data.roomId, data.reason, rateChanged ? req.auth.sub : null],
      );
      await reservationHistory(
        connection,
        req.propertyId,
        Number(stay.reservation_id),
        req.auth.sub,
        'room_moved',
        'checked_in',
        'checked_in',
        { roomId: Number(stay.room_id), room: current.old_room_number },
        { roomId: data.roomId, room: target.room_number, rateChanged, totalEstimate: money(newTotal) },
        data.reason,
      );
      await auditable(connection, {
        organizationId: property.organization_id,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'stay.room_moved',
        entity: 'stay',
        entityId: id,
        before: { roomId: Number(stay.room_id), room: current.old_room_number },
        after: { roomId: data.roomId, room: target.room_number, rateChanged, reason: data.reason },
      });
      await connection.commit();
      publishRoomStatus(req.propertyId, { roomId: Number(stay.room_id), status: 'AWAITING_CLEANING' });
      publishRoomStatus(req.propertyId, { roomId: data.roomId, status: 'OCCUPIED' });
      return res.json({ data: { stayId: id, roomId: data.roomId, roomNumber: target.room_number, rateChanged, totalEstimate: money(newTotal) } });
    } catch (error) {
      if (connection) await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: { code: 'ROOM_UNAVAILABLE', message: 'The target room is no longer available' } });
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/stays/:id/guests', requirePermission(db, 'checkin.perform'), async (req, res, next) => {
    let connection;
    try {
      const stayId = parse(positiveId, req.params.id);
      const { guestId } = parse(addGuestSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [stays] = await connection.execute(
        `SELECT reservation_id FROM stays
         WHERE property_id = ? AND id = ? AND status = 'in_house' FOR UPDATE`,
        [req.propertyId, stayId],
      );
      if (!stays[0]) throw httpError(404, 'STAY_NOT_ACTIVE', 'In-house stay not found');
      const [guests] = await connection.execute(
        `SELECT id, first_name, last_name FROM guests
         WHERE property_id = ? AND id = ? AND deleted_at IS NULL AND anonymised_at IS NULL`,
        [req.propertyId, guestId],
      );
      if (!guests[0]) throw httpError(400, 'INVALID_GUEST', 'Guest is unavailable in this property');
      await connection.execute(
        `INSERT INTO reservation_guests (property_id, reservation_id, guest_id, is_primary)
         VALUES (?, ?, ?, 0)`,
        [req.propertyId, stays[0].reservation_id, guestId],
      );
      const property = await propertyRow(connection, req.propertyId);
      await auditable(connection, {
        organizationId: property.organization_id,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'stay.guest_added',
        entity: 'stay',
        entityId: stayId,
        after: { guestId },
      });
      await connection.commit();
      return res.status(201).json({ data: { guestId, name: `${guests[0].first_name} ${guests[0].last_name}` } });
    } catch (error) {
      if (connection) await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: { code: 'GUEST_ALREADY_LINKED', message: 'Guest is already attached to this reservation' } });
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/stays/:id/requests', requirePermission(db, 'checkin.perform'), async (req, res, next) => {
    let connection;
    try {
      const stayId = parse(positiveId, req.params.id);
      const data = parse(stayRequestSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [stays] = await connection.execute(
        `SELECT reservation.primary_guest_id FROM stays stay
         JOIN reservations reservation ON reservation.id = stay.reservation_id
           AND reservation.property_id = stay.property_id
         WHERE stay.property_id = ? AND stay.id = ? AND stay.status = 'in_house' FOR UPDATE`,
        [req.propertyId, stayId],
      );
      if (!stays[0]) throw httpError(404, 'STAY_NOT_ACTIVE', 'In-house stay not found');
      const guestId = data.guestId ?? Number(stays[0].primary_guest_id);
      const [guest] = await connection.execute(
        `SELECT id FROM reservation_guests
         WHERE property_id = ? AND reservation_id = (SELECT reservation_id FROM stays WHERE id = ? AND property_id = ?)
           AND guest_id = ? LIMIT 1`,
        [req.propertyId, stayId, req.propertyId, guestId],
      );
      if (!guest.length) throw httpError(400, 'INVALID_STAY_GUEST', 'Guest is not linked to this reservation');
      const [inserted] = await connection.execute(
        `INSERT INTO guest_requests (property_id, stay_id, guest_id, type, description, status, assigned_department_id, created_by)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
        [
          req.propertyId, stayId, guestId, data.type, data.description,
          data.assignedDepartmentId ?? null, req.auth.sub,
        ],
      );
      const property = await propertyRow(connection, req.propertyId);
      await auditable(connection, {
        organizationId: property.organization_id,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'stay.guest_request_created',
        entity: 'guest_request',
        entityId: Number(inserted.insertId),
        after: { stayId, guestId, type: data.type },
      });
      await connection.commit();
      return res.status(201).json({ data: { id: Number(inserted.insertId), stayId, guestId, status: 'open' } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/stays/:id/check-out', requirePermission(db, 'checkout.perform'), async (req, res, next) => {
    let connection;
    try {
      const id = parse(positiveId, req.params.id);
      const data = parse(checkoutSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [stayRows] = await connection.execute(
        `SELECT stay.*, reservation.confirmation_no, reservation.status AS reservation_status,
                reservation.check_out_date, reservation.primary_guest_id,
                room.room_number, folio.id AS folio_id, folio.status AS folio_status
         FROM stays stay
         JOIN reservations reservation ON reservation.id = stay.reservation_id AND reservation.property_id = stay.property_id
         JOIN rooms room ON room.id = stay.room_id AND room.property_id = stay.property_id
         LEFT JOIN folios folio ON folio.stay_id = stay.id AND folio.property_id = stay.property_id
         WHERE stay.property_id = ? AND stay.id = ? FOR UPDATE`,
        [req.propertyId, id],
      );
      const stay = stayRows[0];
      if (!stay) throw httpError(404, 'STAY_NOT_FOUND', 'Stay not found');
      if (stay.status !== 'in_house' || !stay.folio_id || stay.folio_status !== 'open') {
        throw httpError(409, 'STAY_NOT_ACTIVE', 'Only an in-house stay with an open folio can be checked out');
      }
      const property = await propertyRow(connection, req.propertyId);
      if (data.lateCheckout) {
        await addFolioCharge(
          connection, req.propertyId, Number(stay.folio_id), 'Late checkout fee',
          String(property.late_checkout_fee), dateOnly(property.business_date), req.auth.sub,
        );
      }
      const totals = await folioTotals(connection, req.propertyId, Number(stay.folio_id));
      const permissions = await db.execute(
        `SELECT permission_key FROM role_permissions
         WHERE role_id = ? AND permission_key = 'folio.approve_credit'`,
        [req.auth.roleId],
      );
      const canApproveCredit = permissions[0].length > 0;
      if (totals.balanceCents > 0n && (!data.approveCredit || !canApproveCredit || !data.creditReason)) {
        throw httpError(409, 'FOLIO_BALANCE_DUE', 'Settle the folio balance before checkout or provide an authorized credit approval and reason', {
          balance: totals.balance,
          canApproveCredit,
        });
      }
      if (totals.balanceCents < 0n) {
        throw httpError(409, 'FOLIO_CREDIT_BALANCE', 'Resolve the guest credit balance before checkout');
      }
      const invoiceNumber = await allocateInvoiceNumber(connection, req.propertyId);
      const invoiceTotals = {
        charges: totals.totalCharges,
        payments: totals.totalPayments,
        balance: totals.balance,
        creditApproved: totals.balanceCents > 0n,
        creditReason: totals.balanceCents > 0n ? data.creditReason : null,
      };
      await connection.execute(
        `INSERT INTO invoices (property_id, folio_id, number, issued_at, totals)
         VALUES (?, ?, ?, NOW(), ?)`,
        [req.propertyId, stay.folio_id, invoiceNumber, JSON.stringify(invoiceTotals)],
      );
      await connection.execute(`UPDATE folios SET status = 'closed', closed_at = NOW() WHERE property_id = ? AND id = ?`, [req.propertyId, stay.folio_id]);
      await connection.execute(`UPDATE stays SET status = 'checked_out', checked_out_at = NOW() WHERE property_id = ? AND id = ?`, [req.propertyId, id]);
      await appendRoomStatus(
        connection, req.propertyId, Number(stay.room_id), 'OCCUPIED', 'AWAITING_CLEANING', req.auth.sub, 'Guest checkout',
      );
      const [existingCleaningTask] = await connection.execute(
        `SELECT id FROM housekeeping_tasks
         WHERE property_id = ? AND room_id = ? AND type = 'checkout_clean'
           AND status NOT IN ('approved', 'rejected') LIMIT 1`,
        [req.propertyId, stay.room_id],
      );
      if (!existingCleaningTask.length) {
        await createHousekeepingTask(connection, {
          propertyId: req.propertyId,
          roomId: Number(stay.room_id),
          type: 'checkout_clean',
          priority: 1,
          dueAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
          sourceRule: 'checkout',
          priorityReason: 'Guest checkout: room must pass supervisor inspection before assignment',
        });
      }
      const [otherStays] = await connection.execute(
        `SELECT id FROM stays WHERE property_id = ? AND reservation_id = ?
         AND status = 'in_house' AND id <> ? LIMIT 1`,
        [req.propertyId, stay.reservation_id, id],
      );
      await connection.execute(
        'DELETE FROM room_nights WHERE property_id = ? AND reservation_id = ? AND room_id = ?',
        [req.propertyId, stay.reservation_id, stay.room_id],
      );
      if (!otherStays.length) {
        await connection.execute(
          `UPDATE reservations SET status = 'checked_out' WHERE property_id = ? AND id = ?`,
          [req.propertyId, stay.reservation_id],
        );
        await connection.execute('DELETE FROM room_nights WHERE property_id = ? AND reservation_id = ?', [req.propertyId, stay.reservation_id]);
        await reservationHistory(
          connection, req.propertyId, Number(stay.reservation_id), req.auth.sub, 'checked_out',
          'checked_in', 'checked_out',
          { status: 'checked_in' },
          { status: 'checked_out', invoiceNumber, balance: totals.balance },
          totals.balanceCents > 0n ? data.creditReason : null,
        );
      }
      await auditable(connection, {
        organizationId: property.organization_id,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'stay.check_out',
        entity: 'stay',
        entityId: id,
        before: { status: 'in_house', roomId: Number(stay.room_id), folioStatus: 'open' },
        after: { status: 'checked_out', invoiceNumber, ...invoiceTotals, roomStatus: 'AWAITING_CLEANING' },
      });
      await connection.commit();
      publishRoomStatus(req.propertyId, { roomId: Number(stay.room_id), status: 'AWAITING_CLEANING' });
      return res.json({ data: {
        stayId: id,
        status: 'checked_out',
        roomStatus: 'AWAITING_CLEANING',
        invoice: { number: invoiceNumber, totals: invoiceTotals },
      } });
    } catch (error) {
      if (connection) await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: { code: 'CHECKOUT_CONFLICT', message: 'Checkout could not be completed due to a conflicting record' } });
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.use((error, _req, res, next) => {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    if (status >= 500) logger.error({ code: error?.code }, 'Stay API request failed');
    if (res.headersSent) return next(error);
    return res.status(status).json({
      error: {
        code: error?.code ?? 'INTERNAL_ERROR',
        message: status === 500 ? 'The stay request could not be completed' : error.message,
        ...(error?.details ? { details: error.details } : {}),
      },
    });
  });
  return router;
}

async function updateStayDates(db, req, stayId, data, shorten) {
  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT stay.id, stay.reservation_id, stay.status,
              reservation.check_in_date, reservation.check_out_date,
              reservation.rate_plan_id, reservation.total_estimate,
              reservation.status AS reservation_status
       FROM stays stay JOIN reservations reservation ON reservation.id = stay.reservation_id
         AND reservation.property_id = stay.property_id
       WHERE stay.property_id = ? AND stay.id = ? FOR UPDATE`,
      [req.propertyId, stayId],
    );
    const stay = rows[0];
    if (!stay || stay.status !== 'in_house') throw httpError(404, 'STAY_NOT_ACTIVE', 'In-house stay not found');
    const oldCheckOut = dateOnly(stay.check_out_date);
    if (shorten ? data.checkOutDate >= oldCheckOut : data.checkOutDate <= oldCheckOut) {
      throw httpError(400, shorten ? 'INVALID_SHORTENING' : 'INVALID_EXTENSION', shorten
        ? 'New checkout date must be earlier than the current checkout date'
        : 'New checkout date must be later than the current checkout date');
    }
    if (data.checkOutDate <= dateOnly(stay.check_in_date)) throw httpError(400, 'INVALID_STAY_LENGTH', 'Checkout must be after check-in');
    const [lines] = await connection.execute(
      `SELECT line.id, line.room_id, line.room_type_id, line.adults, line.children
       FROM reservation_rooms line
       WHERE line.property_id = ? AND line.reservation_id = ?`,
      [req.propertyId, stay.reservation_id],
    );
    if (!lines.length) throw httpError(409, 'ROOM_ASSIGNMENT_MISSING', 'The in-house reservation has no room assignments');
    const newNights = await ensureNightsAvailable(
      connection, req.propertyId, Number(stay.reservation_id), lines, dateOnly(stay.check_in_date), data.checkOutDate,
    );
    await replaceRoomNights(connection, req.propertyId, Number(stay.reservation_id), lines, newNights);
    let totalEstimateCents = 0n;
    for (const line of lines) {
      const ratePlanId = stay.rate_plan_id ?? await getDefaultRatePlan(
        connection, req.propertyId, Number(line.room_type_id),
      );
      const quoteResult = await quotedTotal(
        connection,
        req.propertyId,
        Number(line.room_type_id),
        Number(ratePlanId),
        Number(line.adults),
        Number(line.children),
        dateOnly(stay.check_in_date),
        data.checkOutDate,
      );
      totalEstimateCents += cents(quoteResult.totals.total);
      await connection.execute(
        `UPDATE reservation_rooms SET nightly_rate = ?
         WHERE property_id = ? AND reservation_id = ? AND id = ?`,
        [quoteResult.nightlyRates[0].rate, req.propertyId, stay.reservation_id, line.id],
      );
    }
    const totalEstimate = money(totalEstimateCents);
    await connection.execute(
      'UPDATE reservations SET check_out_date = ?, total_estimate = ? WHERE property_id = ? AND id = ?',
      [data.checkOutDate, totalEstimate, req.propertyId, stay.reservation_id],
    );
    const property = await propertyRow(connection, req.propertyId);
    await reservationHistory(
      connection,
      req.propertyId,
      Number(stay.reservation_id),
      req.auth.sub,
      shorten ? 'shortened' : 'extended',
      'checked_in',
      'checked_in',
      { checkOutDate: oldCheckOut, totalEstimate: String(stay.total_estimate) },
      { checkOutDate: data.checkOutDate, totalEstimate },
      data.reason,
    );
    await auditable(connection, {
      organizationId: property.organization_id,
      propertyId: req.propertyId,
      actorId: req.auth.sub,
      ip: req.ip,
      action: shorten ? 'stay.shortened' : 'stay.extended',
      entity: 'stay',
      entityId: stayId,
      before: { checkOutDate: oldCheckOut, totalEstimate: String(stay.total_estimate) },
      after: { checkOutDate: data.checkOutDate, totalEstimate, reason: data.reason },
    });
    await connection.commit();
    return { stayId, reservationId: Number(stay.reservation_id), checkOutDate: data.checkOutDate, totalEstimate };
  } catch (error) {
    if (connection) await connection.rollback();
    if (error?.code === 'ER_DUP_ENTRY') {
      throw httpError(409, 'ROOM_UNAVAILABLE', 'The requested stay dates conflict with another reservation');
    }
    throw error;
  } finally {
    connection?.release();
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
