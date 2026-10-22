import { Router } from 'express';
import { z } from 'zod';
import { authenticate, propertyScope, requireAnyPermission, requirePermission } from '../auth/middleware.js';
import { getRolePermissions } from '../auth/permissions.js';
import { inAuditedTransaction } from '../auth/audit.js';
import { logger } from '../config/logger.js';
import { quote } from './rate-calculator.js';
import { assertPlanCapacity } from '../platform/plans.js';

const money = z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/);
const percentage = z.coerce.number()
  .min(0)
  .max(100)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8);
const taxSettingsSchema = z.object({
  vatPercent: percentage,
  serviceChargePercent: percentage,
  tourismLevyPercent: percentage,
  pricesTaxInclusive: z.boolean(),
});
function validTime(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours < 24 && minutes < 60;
}

function validTimezone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isCalendarDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const propertyProfileSchema = z.object({
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().max(1000).nullable(),
  city: z.string().trim().max(120).nullable(),
  phone: z.string().trim().max(40).nullable(),
  email: z.string().trim().email().max(190).nullable().or(z.literal('')),
  timezone: z.string().trim().min(1).max(80).refine(validTimezone),
  currency: z.string().trim().regex(/^[A-Z]{3}$/),
  checkInTime: z.string().regex(/^\d{2}:\d{2}$/).refine(validTime),
  checkOutTime: z.string().regex(/^\d{2}:\d{2}$/).refine(validTime),
  taxSettings: taxSettingsSchema,
  requireIdAtCheckIn: z.boolean().default(false),
  earlyCheckInFee: money.default('0.00'),
  lateCheckoutFee: money.default('0.00'),
});
const nameSchema = z.object({ name: z.string().trim().min(1).max(120) });
const floorSchema = z.object({
  name: z.string().trim().min(1).max(80),
  floorNumber: z.coerce.number().int().min(-10).max(200),
  buildingId: z.coerce.number().int().positive(),
});
const roomTypeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(5000).nullable().optional(),
  maxAdults: z.coerce.number().int().min(1).max(20),
  maxChildren: z.coerce.number().int().min(0).max(20),
  baseRate: money,
  isActive: z.boolean().optional(),
  amenities: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
});
const ratePlanSchema = z.object({
  name: z.string().trim().min(1).max(120),
  mealPlan: z.string().trim().max(50).nullable().optional(),
  isActive: z.boolean().optional(),
});
const rateRuleSchema = z.object({
  roomTypeId: z.coerce.number().int().positive(),
  ratePlanId: z.coerce.number().int().positive(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDate),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDate),
  weekdayMask: z.coerce.number().int().min(1).max(127),
  amount: money,
  minStay: z.coerce.number().int().min(1).max(365),
  reason: z.string().trim().min(3).max(500),
});
const bulkRoomsSchema = z.object({
  roomTypeId: z.coerce.number().int().positive(),
  floorId: z.coerce.number().int().positive(),
  startNumber: z.coerce.number().int().min(0).max(999_999),
  endNumber: z.coerce.number().int().min(0).max(999_999),
  prefix: z.string().max(12).default(''),
  suffix: z.string().max(12).default(''),
  padLength: z.coerce.number().int().min(0).max(6).default(0),
});
const activateRoomSchema = z.object({ isActive: z.boolean() });
const quoteSchema = z.object({
  roomTypeId: z.coerce.number().int().positive(),
  ratePlanId: z.coerce.number().int().positive(),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDate),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDate),
  adults: z.coerce.number().int().min(1).max(20),
  children: z.coerce.number().int().min(0).max(20),
});

function sendValidationError(res, issues) {
  return res.status(400).json({
    error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: issues },
  });
}

function parseTaxSettings(value) {
  if (typeof value === 'string') return JSON.parse(value);
  return value ?? { vatPercent: 0, serviceChargePercent: 0, tourismLevyPercent: 0, pricesTaxInclusive: false };
}

function mapProperty(row) {
  return {
    id: Number(row.id),
    name: row.name,
    address: row.address,
    city: row.city,
    phone: row.phone,
    email: row.email,
    timezone: row.timezone,
    currency: row.currency,
    businessDate: row.business_date ? String(row.business_date).slice(0, 10) : null,
    checkInTime: String(row.check_in_time ?? '').slice(0, 5),
    checkOutTime: String(row.check_out_time ?? '').slice(0, 5),
    taxSettings: parseTaxSettings(row.tax_settings),
    requireIdAtCheckIn: Boolean(row.require_id_at_checkin),
    earlyCheckInFee: String(row.early_checkin_fee ?? '0.00'),
    lateCheckoutFee: String(row.late_checkout_fee ?? '0.00'),
  };
}

function databaseError(error, res, next) {
  if (error?.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ error: { code: 'DUPLICATE_CONFIGURATION', message: 'A record with the same value already exists' } });
  }
  if (Number.isInteger(error?.status)) {
    return res.status(error.status).json({
      error: { code: error.code ?? 'REQUEST_FAILED', message: error.message, ...(error.minimumStay ? { minimumStay: error.minimumStay } : {}) },
    });
  }
  return next(error);
}

function propertyErrorHandler(error, _req, res, next) {
  logger.error({ err: error }, 'Property configuration request failed');
  if (res.headersSent) return next(error);
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed' },
  });
}

function validated(schema, req, res) {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return null;
  }
  return parsed.data;
}

async function propertyExists(connection, propertyId, table, id) {
  if (!['buildings', 'floors', 'room_types', 'rate_plans'].includes(table)) {
    throw new Error('Unsupported property relation');
  }
  const softDeleteFilter = ['room_types', 'rate_plans'].includes(table) ? ' AND deleted_at IS NULL' : '';
  const [rows] = await connection.execute(
    `SELECT id FROM ${table} WHERE property_id = ? AND id = ?${softDeleteFilter} LIMIT 1`,
    [propertyId, id],
  );
  return rows.length > 0;
}

async function saveRoomTypeAmenities(connection, propertyId, roomTypeId, amenities) {
  if (amenities === undefined) return;
  await connection.execute('DELETE FROM room_type_amenities WHERE property_id = ? AND room_type_id = ?', [
    propertyId,
    roomTypeId,
  ]);
  for (const name of [...new Set(amenities.map((item) => item.trim()).filter(Boolean))]) {
    const [existing] = await connection.execute(
      'SELECT id FROM amenities WHERE property_id = ? AND name = ? LIMIT 1',
      [propertyId, name],
    );
    let amenityId = existing[0]?.id;
    if (!amenityId) {
      const [insert] = await connection.execute(
        'INSERT INTO amenities (property_id, name) VALUES (?, ?)',
        [propertyId, name],
      );
      amenityId = insert.insertId;
    }
    await connection.execute(
      'INSERT INTO room_type_amenities (property_id, room_type_id, amenity_id) VALUES (?, ?, ?)',
      [propertyId, roomTypeId, amenityId],
    );
  }
}

export function createPropertyRouter(db) {
  const router = Router();
  const propertyUser = [authenticate(db), propertyScope(db)];

  router.get('/property', ...propertyUser, requirePermission(db, 'property.manage'), async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT id, name, address, city, phone, email, timezone, currency, business_date,
                check_in_time, check_out_time, tax_settings, require_id_at_checkin,
                early_checkin_fee, late_checkout_fee
         FROM properties WHERE id = ? AND organization_id = ? LIMIT 1`,
        [req.propertyId, req.auth.orgId],
      );
      if (!rows.length) return res.status(404).json({ error: { code: 'PROPERTY_NOT_FOUND', message: 'Property not found' } });
      return res.json({ data: mapProperty(rows[0]) });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/property', ...propertyUser, requirePermission(db, 'property.manage'), async (req, res, next) => {
    const data = validated(propertyProfileSchema, req, res);
    if (!data) return;
    try {
      const result = await inAuditedTransaction(db, req, (change) => ({
        action: 'property.profile_updated',
        entity: 'property',
        entityId: req.propertyId,
        before: change.before,
        after: data,
      }), async (connection) => {
        const [rows] = await connection.execute(
          `SELECT id, name, address, city, phone, email, timezone, currency, business_date,
                  check_in_time, check_out_time, tax_settings, require_id_at_checkin,
                  early_checkin_fee, late_checkout_fee
           FROM properties WHERE id = ? AND organization_id = ? FOR UPDATE`,
          [req.propertyId, req.auth.orgId],
        );
        if (!rows.length) {
          throw Object.assign(new Error('Property not found'), { status: 404, code: 'PROPERTY_NOT_FOUND' });
        }
        const before = mapProperty(rows[0]);
        await connection.execute(
          `UPDATE properties
           SET name = ?, address = ?, city = ?, phone = ?, email = ?, timezone = ?,
               currency = ?, check_in_time = ?, check_out_time = ?, tax_settings = ?,
               require_id_at_checkin = ?, early_checkin_fee = ?, late_checkout_fee = ?
           WHERE id = ? AND organization_id = ?`,
          [
            data.name,
            data.address,
            data.city,
            data.phone,
            data.email || null,
            data.timezone,
            data.currency,
            `${data.checkInTime}:00`,
            `${data.checkOutTime}:00`,
            JSON.stringify(data.taxSettings),
            data.requireIdAtCheckIn,
            data.earlyCheckInFee,
            data.lateCheckoutFee,
            req.propertyId,
            req.auth.orgId,
          ],
        );
        return { before };
      });
      return res.json({ data: { ...data, id: req.propertyId, businessDate: result.before.businessDate } });
    } catch (error) {
      return databaseError(error, res, next);
    }
  });

  router.get('/property/buildings', ...propertyUser, requirePermission(db, 'rooms.manage'), async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        'SELECT id, name FROM buildings WHERE property_id = ? ORDER BY name',
        [req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({ id: Number(row.id), name: row.name })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/property/buildings', ...propertyUser, requirePermission(db, 'rooms.manage'), async (req, res, next) => {
    const data = validated(nameSchema, req, res);
    if (!data) return;
    try {
      const result = await inAuditedTransaction(db, req, () => ({
        action: 'building.created',
        entity: 'building',
        after: data,
      }), async (connection) => {
        const [insert] = await connection.execute(
          'INSERT INTO buildings (property_id, name) VALUES (?, ?)',
          [req.propertyId, data.name],
        );
        return { id: Number(insert.insertId) };
      });
      return res.status(201).json({ data: result });
    } catch (error) {
      return databaseError(error, res, next);
    }
  });

  router.get('/property/floors', ...propertyUser, requirePermission(db, 'rooms.manage'), async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT f.id, f.name, f.floor_number AS floorNumber, f.building_id AS buildingId, b.name AS buildingName
         FROM floors f LEFT JOIN buildings b ON b.id = f.building_id AND b.property_id = f.property_id
         WHERE f.property_id = ? ORDER BY f.floor_number, f.name`,
        [req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({ ...row, id: Number(row.id), buildingId: Number(row.buildingId) })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/property/floors', ...propertyUser, requirePermission(db, 'rooms.manage'), async (req, res, next) => {
    const data = validated(floorSchema, req, res);
    if (!data) return;
    try {
      const result = await inAuditedTransaction(db, req, () => ({
        action: 'floor.created',
        entity: 'floor',
        after: data,
      }), async (connection) => {
        if (!(await propertyExists(connection, req.propertyId, 'buildings', data.buildingId))) {
          throw Object.assign(new Error('Building is not in the selected property'), { status: 400, code: 'INVALID_BUILDING' });
        }
        const [insert] = await connection.execute(
          'INSERT INTO floors (property_id, building_id, name, floor_number) VALUES (?, ?, ?, ?)',
          [req.propertyId, data.buildingId, data.name, data.floorNumber],
        );
        return { id: Number(insert.insertId) };
      });
      return res.status(201).json({ data: result });
    } catch (error) {
      return databaseError(error, res, next);
    }
  });

  router.get('/property/room-types', ...propertyUser, requireAnyPermission(db, ['rooms.manage', 'rates.view']), async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT rt.id, rt.name, rt.description, rt.max_adults AS maxAdults,
                rt.max_children AS maxChildren, rt.base_rate AS baseRate, rt.is_active AS isActive,
                GROUP_CONCAT(DISTINCT a.name ORDER BY a.name SEPARATOR ',') AS amenities
         FROM room_types rt
         LEFT JOIN room_type_amenities ra ON ra.property_id = rt.property_id AND ra.room_type_id = rt.id
         LEFT JOIN amenities a ON a.id = ra.amenity_id AND a.property_id = rt.property_id
         WHERE rt.property_id = ? AND rt.deleted_at IS NULL
         GROUP BY rt.id ORDER BY rt.name`,
        [req.propertyId],
      );
      return res.json({
        data: rows.map((row) => ({
          ...row,
          id: Number(row.id),
          maxAdults: Number(row.maxAdults),
          maxChildren: Number(row.maxChildren),
          isActive: Boolean(row.isActive),
          amenities: row.amenities ? row.amenities.split(',') : [],
        })),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/property/room-types', ...propertyUser, requirePermission(db, 'rooms.manage'), async (req, res, next) => {
    const data = validated(roomTypeSchema, req, res);
    if (!data) return;
    try {
      const result = await inAuditedTransaction(db, req, () => ({
        action: 'room_type.created',
        entity: 'room_type',
        after: data,
      }), async (connection) => {
        const [insert] = await connection.execute(
          `INSERT INTO room_types
           (property_id, name, description, max_adults, max_children, base_rate, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            req.propertyId,
            data.name,
            data.description ?? null,
            data.maxAdults,
            data.maxChildren,
            data.baseRate,
            data.isActive ?? true,
          ],
        );
        await saveRoomTypeAmenities(connection, req.propertyId, insert.insertId, data.amenities);
        return { id: Number(insert.insertId) };
      });
      return res.status(201).json({ data: result });
    } catch (error) {
      return databaseError(error, res, next);
    }
  });

  router.put('/property/room-types/:id', ...propertyUser, requirePermission(db, 'rooms.manage'), async (req, res, next) => {
    const data = validated(roomTypeSchema, req, res);
    const id = Number(req.params.id);
    if (!data) return;
    if (!Number.isInteger(id) || id < 1) return sendValidationError(res, [{ path: ['id'], message: 'Room type id is invalid' }]);
    try {
      await inAuditedTransaction(db, req, (change) => ({
        action: 'room_type.updated',
        entity: 'room_type',
        entityId: id,
        before: change.before,
        after: data,
      }), async (connection) => {
        const [rows] = await connection.execute(
          `SELECT id, name, description, max_adults, max_children, base_rate, is_active
           FROM room_types WHERE id = ? AND property_id = ? AND deleted_at IS NULL FOR UPDATE`,
          [id, req.propertyId],
        );
        if (!rows.length) throw Object.assign(new Error('Room type not found'), { status: 404, code: 'ROOM_TYPE_NOT_FOUND' });
        const before = rows[0];
        await connection.execute(
          `UPDATE room_types
           SET name = ?, description = ?, max_adults = ?, max_children = ?, base_rate = ?, is_active = ?
           WHERE id = ? AND property_id = ?`,
          [
            data.name,
            data.description ?? null,
            data.maxAdults,
            data.maxChildren,
            data.baseRate,
            data.isActive ?? true,
            id,
            req.propertyId,
          ],
        );
        await saveRoomTypeAmenities(connection, req.propertyId, id, data.amenities);
        return { before };
      });
      return res.status(204).end();
    } catch (error) {
      return databaseError(error, res, next);
    }
  });

  router.get('/property/rooms', ...propertyUser, requirePermission(db, 'rooms.manage'), async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT r.id, r.room_number AS roomNumber, r.status, r.housekeeping_priority AS housekeepingPriority,
                r.is_active AS isActive, r.room_type_id AS roomTypeId, rt.name AS roomType,
                r.floor_id AS floorId, f.name AS floor, f.floor_number AS floorNumber,
                b.name AS building
         FROM rooms r
         JOIN room_types rt ON rt.id = r.room_type_id AND rt.property_id = r.property_id
         LEFT JOIN floors f ON f.id = r.floor_id AND f.property_id = r.property_id
         LEFT JOIN buildings b ON b.id = f.building_id AND b.property_id = r.property_id
         WHERE r.property_id = ? AND r.deleted_at IS NULL
         ORDER BY f.floor_number, r.room_number`,
        [req.propertyId],
      );
      return res.json({
        data: rows.map((row) => ({
          ...row,
          id: Number(row.id),
          roomTypeId: Number(row.roomTypeId),
          floorId: row.floorId === null ? null : Number(row.floorId),
          isActive: Boolean(row.isActive),
        })),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/property/rooms/bulk', ...propertyUser, requirePermission(db, 'rooms.manage'), async (req, res, next) => {
    const data = validated(bulkRoomsSchema, req, res);
    if (!data) return;
    if (data.endNumber < data.startNumber) {
      return sendValidationError(res, [{ path: ['endNumber'], message: 'End number must not be before start number' }]);
    }
    if (data.endNumber - data.startNumber >= 100) {
      return sendValidationError(res, [{ path: ['endNumber'], message: 'Create at most 100 rooms per request' }]);
    }
    const roomNumbers = Array.from(
      { length: data.endNumber - data.startNumber + 1 },
      (_, index) => `${data.prefix}${String(data.startNumber + index).padStart(data.padLength, '0')}${data.suffix}`,
    );
    try {
      const result = await inAuditedTransaction(db, req, (created) => ({
        action: 'rooms.bulk_created',
        entity: 'room',
        entityId: req.propertyId,
        before: null,
        after: { roomNumbers: created.roomNumbers, floorId: data.floorId, roomTypeId: data.roomTypeId },
      }), async (connection) => {
        await assertPlanCapacity(connection, req.auth.orgId, 'rooms', roomNumbers.length);
        if (!(await propertyExists(connection, req.propertyId, 'room_types', data.roomTypeId))) {
          throw Object.assign(new Error('Room type is not in the selected property'), { status: 400, code: 'INVALID_ROOM_TYPE' });
        }
        if (!(await propertyExists(connection, req.propertyId, 'floors', data.floorId))) {
          throw Object.assign(new Error('Floor is not in the selected property'), { status: 400, code: 'INVALID_FLOOR' });
        }
        const placeholders = roomNumbers.map(() => '?').join(',');
        const [duplicates] = await connection.execute(
          `SELECT room_number FROM rooms
           WHERE property_id = ? AND room_number IN (${placeholders}) AND deleted_at IS NULL`,
          [req.propertyId, ...roomNumbers],
        );
        if (duplicates.length) {
          throw Object.assign(new Error(`Room numbers already exist: ${duplicates.map((row) => row.room_number).join(', ')}`), {
            status: 409,
            code: 'ROOM_NUMBERS_EXIST',
          });
        }
        for (const roomNumber of roomNumbers) {
          await connection.execute(
            `INSERT INTO rooms (property_id, room_type_id, floor_id, room_number, status, housekeeping_priority, is_active)
             VALUES (?, ?, ?, ?, 'CLEAN', 0, 1)`,
            [req.propertyId, data.roomTypeId, data.floorId, roomNumber],
          );
        }
        return { roomNumbers };
      });
      return res.status(201).json({ data: { created: result.roomNumbers.length, roomNumbers: result.roomNumbers } });
    } catch (error) {
      return databaseError(error, res, next);
    }
  });

  router.patch('/property/rooms/:id/active', ...propertyUser, requirePermission(db, 'rooms.manage'), async (req, res, next) => {
    const data = validated(activateRoomSchema, req, res);
    const id = Number(req.params.id);
    if (!data) return;
    if (!Number.isInteger(id) || id < 1) return sendValidationError(res, [{ path: ['id'], message: 'Room id is invalid' }]);
    try {
      await inAuditedTransaction(db, req, (change) => ({
        action: data.isActive ? 'room.activated' : 'room.deactivated',
        entity: 'room',
        entityId: id,
        before: change.before,
        after: { isActive: data.isActive },
      }), async (connection) => {
        const [rows] = await connection.execute(
          `SELECT id, is_active FROM rooms
           WHERE id = ? AND property_id = ? AND deleted_at IS NULL FOR UPDATE`,
          [id, req.propertyId],
        );
        if (!rows.length) throw Object.assign(new Error('Room not found'), { status: 404, code: 'ROOM_NOT_FOUND' });
        if (!data.isActive) {
          const [reservations] = await connection.execute(
            `SELECT id FROM reservations
             WHERE property_id = ? AND assigned_room_id = ?
               AND (status = 'checked_in'
                 OR (status IN ('tentative', 'confirmed') AND check_out_date >= COALESCE(
                   (SELECT business_date FROM properties WHERE id = ?), CURRENT_DATE
                 ))) LIMIT 1`,
            [req.propertyId, id, req.propertyId],
          );
          if (reservations.length) {
            throw Object.assign(new Error('Room has an active or future reservation and cannot be deactivated'), {
              status: 409,
              code: 'ROOM_HAS_RESERVATIONS',
            });
          }
        }
        await connection.execute(
          'UPDATE rooms SET is_active = ? WHERE id = ? AND property_id = ?',
          [data.isActive, id, req.propertyId],
        );
        return { before: { isActive: Boolean(rows[0].is_active) } };
      });
      return res.status(204).end();
    } catch (error) {
      return databaseError(error, res, next);
    }
  });

  router.get('/property/rate-plans', ...propertyUser, requirePermission(db, 'rates.view'), async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT id, name, meal_plan AS mealPlan, is_active AS isActive
         FROM rate_plans WHERE property_id = ? AND deleted_at IS NULL ORDER BY name`,
        [req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({ ...row, id: Number(row.id), isActive: Boolean(row.isActive) })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/property/rate-plans', ...propertyUser, requirePermission(db, 'rates.edit'), async (req, res, next) => {
    const data = validated(ratePlanSchema, req, res);
    if (!data) return;
    try {
      const result = await inAuditedTransaction(db, req, () => ({
        action: 'rate_plan.created',
        entity: 'rate_plan',
        after: data,
      }), async (connection) => {
        const [insert] = await connection.execute(
          'INSERT INTO rate_plans (property_id, name, meal_plan, is_active) VALUES (?, ?, ?, ?)',
          [req.propertyId, data.name, data.mealPlan ?? null, data.isActive ?? true],
        );
        return { id: Number(insert.insertId) };
      });
      return res.status(201).json({ data: result });
    } catch (error) {
      return databaseError(error, res, next);
    }
  });

  router.get('/property/rates', ...propertyUser, requirePermission(db, 'rates.edit'), async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT r.id, r.room_type_id AS roomTypeId, rt.name AS roomType,
                r.rate_plan_id AS ratePlanId, rp.name AS ratePlan, r.date_from AS dateFrom,
                r.date_to AS dateTo, r.weekday_mask AS weekdayMask, r.amount,
                r.min_stay AS minStay, r.reason
         FROM rates r
         JOIN room_types rt ON rt.id = r.room_type_id AND rt.property_id = r.property_id
         JOIN rate_plans rp ON rp.id = r.rate_plan_id AND rp.property_id = r.property_id
         WHERE r.property_id = ? ORDER BY r.date_from DESC, r.id DESC`,
        [req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({ ...row, id: Number(row.id), roomTypeId: Number(row.roomTypeId), ratePlanId: Number(row.ratePlanId), weekdayMask: Number(row.weekdayMask), minStay: Number(row.minStay) })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/property/rates', ...propertyUser, requirePermission(db, 'rates.edit'), async (req, res, next) => {
    const data = validated(rateRuleSchema, req, res);
    if (!data) return;
    if (data.dateTo < data.dateFrom) {
      return sendValidationError(res, [{ path: ['dateTo'], message: 'End date must not be before start date' }]);
    }
    try {
      const result = await inAuditedTransaction(db, req, () => ({
        action: 'rate.created',
        entity: 'rate',
        after: data,
      }), async (connection) => {
        const [propertyRows] = await connection.execute(
          'SELECT business_date FROM properties WHERE id = ? AND organization_id = ? FOR UPDATE',
          [req.propertyId, req.auth.orgId],
        );
        if (!propertyRows.length) throw Object.assign(new Error('Property not found'), { status: 404, code: 'PROPERTY_NOT_FOUND' });
        if (data.dateFrom < String(propertyRows[0].business_date).slice(0, 10)) {
          const permissions = await getRolePermissions(connection, req.auth.roleId);
          if (!permissions.includes('rates.override_past')) {
            throw Object.assign(new Error('Creating a rate in the past requires rates.override_past'), {
              status: 403,
              code: 'PAST_RATE_OVERRIDE_REQUIRED',
            });
          }
        }
        if (!(await propertyExists(connection, req.propertyId, 'room_types', data.roomTypeId))
          || !(await propertyExists(connection, req.propertyId, 'rate_plans', data.ratePlanId))) {
          throw Object.assign(new Error('Room type and rate plan must belong to the selected property'), {
            status: 400,
            code: 'INVALID_RATE_CONFIGURATION',
          });
        }
        const [insert] = await connection.execute(
          `INSERT INTO rates
           (property_id, room_type_id, rate_plan_id, date_from, date_to, weekday_mask, amount, min_stay, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            req.propertyId,
            data.roomTypeId,
            data.ratePlanId,
            data.dateFrom,
            data.dateTo,
            data.weekdayMask,
            data.amount,
            data.minStay,
            data.reason,
          ],
        );
        return { id: Number(insert.insertId) };
      });
      return res.status(201).json({ data: result });
    } catch (error) {
      return databaseError(error, res, next);
    }
  });

  router.put('/property/rates/:id', ...propertyUser, requirePermission(db, 'rates.edit'), async (req, res, next) => {
    const data = validated(rateRuleSchema, req, res);
    const id = Number(req.params.id);
    if (!data) return;
    if (!Number.isInteger(id) || id < 1) return sendValidationError(res, [{ path: ['id'], message: 'Rate id is invalid' }]);
    if (data.dateTo < data.dateFrom) {
      return sendValidationError(res, [{ path: ['dateTo'], message: 'End date must not be before start date' }]);
    }
    try {
      await inAuditedTransaction(db, req, (change) => ({
        action: 'rate.updated',
        entity: 'rate',
        entityId: id,
        before: change.before,
        after: data,
      }), async (connection) => {
        const [rows] = await connection.execute(
          `SELECT r.id, r.date_from, r.date_to, p.business_date
           FROM rates r JOIN properties p ON p.id = r.property_id
           WHERE r.id = ? AND r.property_id = ? FOR UPDATE`,
          [id, req.propertyId],
        );
        if (!rows.length) throw Object.assign(new Error('Rate not found'), { status: 404, code: 'RATE_NOT_FOUND' });
        const businessDate = String(rows[0].business_date).slice(0, 10);
        const pastDated = String(rows[0].date_from).slice(0, 10) < businessDate
          || String(rows[0].date_to).slice(0, 10) < businessDate
          || data.dateFrom < businessDate
          || data.dateTo < businessDate;
        if (pastDated) {
          const permissions = await getRolePermissions(connection, req.auth.roleId);
          if (!permissions.includes('rates.override_past')) {
            throw Object.assign(new Error('Changing a past-dated rate requires rates.override_past'), {
              status: 403,
              code: 'PAST_RATE_OVERRIDE_REQUIRED',
            });
          }
        }
        if (!(await propertyExists(connection, req.propertyId, 'room_types', data.roomTypeId))
          || !(await propertyExists(connection, req.propertyId, 'rate_plans', data.ratePlanId))) {
          throw Object.assign(new Error('Room type and rate plan must belong to the selected property'), {
            status: 400,
            code: 'INVALID_RATE_CONFIGURATION',
          });
        }
        const before = rows[0];
        await connection.execute(
          `UPDATE rates
           SET room_type_id = ?, rate_plan_id = ?, date_from = ?, date_to = ?, weekday_mask = ?,
               amount = ?, min_stay = ?, reason = ?
           WHERE id = ? AND property_id = ?`,
          [
            data.roomTypeId,
            data.ratePlanId,
            data.dateFrom,
            data.dateTo,
            data.weekdayMask,
            data.amount,
            data.minStay,
            data.reason,
            id,
            req.propertyId,
          ],
        );
        return { before };
      });
      return res.status(204).end();
    } catch (error) {
      return databaseError(error, res, next);
    }
  });

  router.post('/property/rates/quote', ...propertyUser, requirePermission(db, 'rates.view'), async (req, res, next) => {
    const data = validated(quoteSchema, req, res);
    if (!data) return;
    try {
      const [[propertyRows], [roomTypes], [ratePlans], [rates]] = await Promise.all([
        db.execute('SELECT tax_settings, currency FROM properties WHERE id = ? AND organization_id = ? LIMIT 1', [req.propertyId, req.auth.orgId]),
        db.execute('SELECT id, property_id, max_adults, max_children, base_rate, is_active FROM room_types WHERE property_id = ? AND deleted_at IS NULL', [req.propertyId]),
        db.execute('SELECT id, property_id, is_active FROM rate_plans WHERE property_id = ? AND deleted_at IS NULL', [req.propertyId]),
        db.execute('SELECT id, room_type_id, rate_plan_id, date_from, date_to, weekday_mask, amount, min_stay, created_at FROM rates WHERE property_id = ?', [req.propertyId]),
      ]);
      if (!propertyRows.length) throw Object.assign(new Error('Property not found'), { status: 404, code: 'PROPERTY_NOT_FOUND' });
      const result = quote(data, {
        roomTypes,
        ratePlans,
        rates,
        taxSettings: parseTaxSettings(propertyRows[0].tax_settings),
      });
      return res.json({ data: { ...result, currency: propertyRows[0].currency } });
    } catch (error) {
      return databaseError(error, res, next);
    }
  });

  router.use(propertyErrorHandler);
  return router;
}
