import { Router } from 'express';
import { z } from 'zod';
import { authenticate, propertyScope, requirePermission } from '../auth/middleware.js';
import { getRolePermissions } from '../auth/permissions.js';
import { auditable, inAuditedTransaction } from '../auth/audit.js';
import { logger } from '../config/logger.js';
import {
  decryptIdNumber,
  encryptIdNumber,
  hashIdNumber,
  idNumberLast4,
  maskIdNumber,
} from './pii.js';

const guestSchema = z.object({
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().max(190).nullable().optional(),
  nationality: z.string().trim().max(80).nullable().optional(),
  idType: z.string().trim().max(40).nullable().optional(),
  idNumber: z.string().trim().max(120).nullable().optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(validDate).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  preferences: z.record(z.string(), z.unknown()).nullable().optional(),
  isVip: z.boolean().optional(),
});
const companySchema = z.object({
  name: z.string().trim().min(1).max(200),
  tin: z.string().trim().max(80).nullable().optional(),
  contact: z.object({
    name: z.string().trim().max(200).nullable().optional(),
    email: z.string().trim().email().max(190).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
  }).nullable().optional(),
  creditTerms: z.string().trim().max(5000).nullable().optional(),
});
const groupSchema = z.object({
  name: z.string().trim().min(1).max(160),
  leaderGuestId: z.coerce.number().int().positive().nullable().optional(),
  guestIds: z.array(z.coerce.number().int().positive()).max(200).default([]),
  notes: z.string().trim().max(5000).nullable().optional(),
});
const requestSchema = z.object({
  guestId: z.coerce.number().int().positive().nullable().optional(),
  stayId: z.coerce.number().int().positive().nullable().optional(),
  type: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(5000),
  assignedDepartmentId: z.coerce.number().int().positive().nullable().optional(),
});
const requestUpdateSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'cancelled']).optional(),
  assignedDepartmentId: z.coerce.number().int().positive().nullable().optional(),
  assignedTo: z.coerce.number().int().positive().nullable().optional(),
});
const requestTransitions = {
  open: ['in_progress', 'cancelled'],
  in_progress: ['resolved', 'cancelled'],
  resolved: ['in_progress'],
  cancelled: [],
};
const anonymizeSchema = z.object({ reason: z.string().trim().min(5).max(500) });
const mergeSchema = z.object({
  targetGuestId: z.coerce.number().int().positive(),
  reason: z.string().trim().min(5).max(500),
});
const retentionSchema = z.object({ retentionDays: z.coerce.number().int().min(30).max(36500) });
const positiveId = z.coerce.number().int().positive();

function normalizePhone(value) {
  if (!value) return null;
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  return digits ? `${trimmed.startsWith('+') ? '+' : ''}${digits}` : null;
}

function validDate(value) {
  if (value === null || value === undefined) return true;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw Object.assign(
      new Error('Request validation failed'),
      { status: 400, code: 'VALIDATION_ERROR', details: result.error.issues },
    );
  }
  return result.data;
}

function jsonValue(value, fallback = null) {
  if (typeof value === 'string') return JSON.parse(value);
  return value ?? fallback;
}

function mapGuest(row) {
  return {
    id: Number(row.id),
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: `${row.first_name} ${row.last_name}`.trim(),
    phone: row.phone,
    email: row.email,
    nationality: row.nationality,
    idType: row.id_type,
    idNumber: maskIdNumber(row.id_number_last4),
    idLast4: row.id_number_last4,
    dateOfBirth: row.date_of_birth ? String(row.date_of_birth).slice(0, 10) : null,
    notes: row.notes,
    preferences: jsonValue(row.preferences, {}),
    isVip: Boolean(row.is_vip),
    isAnonymised: Boolean(row.anonymised_at),
    createdAt: row.created_at,
  };
}

function mapCompany(row) {
  return {
    id: Number(row.id),
    name: row.name,
    tin: row.tin,
    contact: jsonValue(row.contact, {}),
    creditTerms: row.credit_terms,
  };
}

async function getGuest(connection, propertyId, guestId, lock = false) {
  const [rows] = await connection.execute(
    `SELECT id, first_name, last_name, phone, email, nationality, id_type,
            id_number_enc, id_number_hash, id_number_last4, date_of_birth,
            notes, preferences, is_vip, anonymised_at, deleted_at, created_at
     FROM guests WHERE property_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [propertyId, guestId],
  );
  return rows[0] ?? null;
}

function normalizedGuestFields(data) {
  return {
    first_name: data.firstName,
    last_name: data.lastName,
    phone: normalizePhone(data.phone),
    email: data.email?.toLowerCase() || null,
    nationality: data.nationality || null,
    id_type: data.idType || null,
    date_of_birth: data.dateOfBirth || null,
    notes: data.notes || null,
    preferences: data.preferences === undefined || data.preferences === null
      ? null
      : JSON.stringify(data.preferences),
    is_vip: data.isVip ?? false,
  };
}

async function findDuplicate(connection, propertyId, data, idHash, excludedId = null) {
  const conditions = [];
  const values = [propertyId];
  if (data.phone) {
    conditions.push('phone = ?');
    values.push(normalizePhone(data.phone));
  }
  if (data.email) {
    conditions.push('LOWER(email) = ?');
    values.push(data.email.toLowerCase());
  }
  if (idHash) {
    conditions.push('id_number_hash = ?');
    values.push(idHash);
  }
  if (!conditions.length) return null;
  let exclusion = '';
  if (excludedId !== null) {
    exclusion = ' AND id <> ?';
    values.push(excludedId);
  }
  const [rows] = await connection.execute(
    `SELECT id, first_name, last_name FROM guests
     WHERE property_id = ? AND deleted_at IS NULL AND anonymised_at IS NULL
       AND (${conditions.join(' OR ')})${exclusion}
     ORDER BY id LIMIT 1`,
    values,
  );
  return rows[0] ?? null;
}

async function auditRead(db, req, action, entityId, after, entity = 'guest') {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await auditable(connection, {
      organizationId: req.auth.orgId,
      propertyId: req.propertyId,
      actorId: req.auth.sub,
      ip: req.ip,
      action,
      entity,
      entityId,
      after,
    });
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function ensureGuestIds(connection, propertyId, ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return [];
  const [rows] = await connection.execute(
    `SELECT id FROM guests WHERE property_id = ? AND deleted_at IS NULL
     AND anonymised_at IS NULL AND id IN (${uniqueIds.map(() => '?').join(',')})`,
    [propertyId, ...uniqueIds],
  );
  if (rows.length !== uniqueIds.length) {
    throw httpError(400, 'INVALID_GUEST', 'One or more guests are unavailable in this property');
  }
  return uniqueIds;
}

async function updateGroupMembers(connection, propertyId, groupId, guestIds) {
  const ids = await ensureGuestIds(connection, propertyId, guestIds);
  await connection.execute('DELETE FROM group_guests WHERE property_id = ? AND group_id = ?', [propertyId, groupId]);
  for (const guestId of ids) {
    await connection.execute(
      'INSERT INTO group_guests (property_id, group_id, guest_id) VALUES (?, ?, ?)',
      [propertyId, groupId, guestId],
    );
  }
}

const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

export function createGuestRouter(db) {
  const router = Router();
  router.use(authenticate(db), propertyScope(db));

  router.get('/guests', requirePermission(db, 'guests.view'), route(async (req, res) => {
    const search = String(req.query.search ?? '').trim().slice(0, 100);
    const params = [req.propertyId];
    let where = 'property_id = ? AND deleted_at IS NULL';
    if (search) {
      const digits = search.replace(/\D/g, '');
      where += ' AND (CONCAT(first_name, " ", last_name) LIKE ? OR email LIKE ? OR phone LIKE ?';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      if (digits.length >= 4) {
        where += ' OR id_number_last4 = ?';
        params.push(digits.slice(-4));
      }
      where += ')';
    }
    const [rows] = await db.execute(
      `SELECT id, first_name, last_name, phone, email, nationality, id_type,
              id_number_last4, date_of_birth, notes, preferences, is_vip,
              anonymised_at, created_at
       FROM guests WHERE ${where} ORDER BY last_name, first_name LIMIT 100`,
      params,
    );
    await auditRead(db, req, 'guest.search', null, { resultCount: rows.length, hasSearch: Boolean(search) });
    res.json({ data: rows.map(mapGuest) });
  }));

  router.post('/guests', requirePermission(db, 'guests.manage'), route(async (req, res) => {
    const data = parse(guestSchema, req.body);
    const idHash = data.idNumber ? hashIdNumber(data.idNumber) : null;
    const duplicate = await findDuplicate(db, req.propertyId, data, idHash);
    if (duplicate) {
      return res.status(409).json({
        error: { code: 'POSSIBLE_DUPLICATE', message: 'A matching guest already exists', duplicateGuestId: Number(duplicate.id) },
      });
    }
    const fields = normalizedGuestFields(data);
    const result = await inAuditedTransaction(db, req, (insertedGuest) => ({
      action: 'guest.create',
      entity: 'guest',
      entityId: insertedGuest.id,
      after: { fields: Object.keys(fields).filter((key) => fields[key] !== null), hasIdNumber: Boolean(idHash) },
    }), async (connection) => {
      const [inserted] = await connection.execute(
        `INSERT INTO guests
          (organization_id, property_id, first_name, last_name, phone, email, nationality,
           id_type, id_number_enc, id_number_hash, id_number_last4, date_of_birth,
           notes, preferences, is_vip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.auth.orgId,
          req.propertyId,
          fields.first_name,
          fields.last_name,
          fields.phone,
          fields.email,
          fields.nationality,
          fields.id_type,
          data.idNumber ? encryptIdNumber(data.idNumber) : null,
          idHash,
          data.idNumber ? idNumberLast4(data.idNumber) : null,
          fields.date_of_birth,
          fields.notes,
          fields.preferences,
          fields.is_vip,
        ],
      );
      return { id: Number(inserted.insertId) };
    });
    const row = await getGuest(db, req.propertyId, result.id);
    res.status(201).json({ data: mapGuest(row) });
  }));

  router.get('/guests/privacy-settings', requirePermission(db, 'guests.manage'), route(async (req, res) => {
    const [rows] = await db.execute(
      `SELECT setting_value FROM system_settings
       WHERE property_id = ? AND setting_key = 'guest_retention_days' ORDER BY id DESC LIMIT 1`,
      [req.propertyId],
    );
    const value = rows[0] ? Number(jsonValue(rows[0].setting_value, 3650)) : 3650;
    res.json({ data: { retentionDays: Number.isInteger(value) ? value : 3650 } });
  }));

  router.put('/guests/privacy-settings', requirePermission(db, 'guests.manage'), route(async (req, res) => {
    const { retentionDays } = parse(retentionSchema, req.body);
    await inAuditedTransaction(db, req, () => ({
      action: 'guest.retention_policy.update',
      entity: 'guest_privacy_settings',
      after: { retentionDays },
    }), async (connection) => {
      const [rows] = await connection.execute(
        `SELECT id FROM system_settings WHERE property_id = ?
         AND setting_key = 'guest_retention_days' ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [req.propertyId],
      );
      if (rows[0]) {
        await connection.execute('UPDATE system_settings SET setting_value = ? WHERE id = ?', [JSON.stringify(retentionDays), rows[0].id]);
      } else {
        await connection.execute(
          `INSERT INTO system_settings (organization_id, property_id, setting_key, setting_value)
           VALUES (?, ?, 'guest_retention_days', ?)`,
          [req.auth.orgId, req.propertyId, JSON.stringify(retentionDays)],
        );
      }
      return { retentionDays };
    });
    res.json({ data: { retentionDays } });
  }));

  router.get('/guests/:id', requirePermission(db, 'guests.view'), route(async (req, res) => {
    const guestId = parse(positiveId, req.params.id);
    const guest = await getGuest(db, req.propertyId, guestId);
    if (!guest) throw httpError(404, 'GUEST_NOT_FOUND', 'Guest not found');
    const [reservations] = await db.execute(
      `SELECT r.id, r.confirmation_no, r.status, r.check_in_date, r.check_out_date,
              r.adults, r.children, r.total_estimate, rt.name AS room_type,
              s.checked_in_at, s.checked_out_at
       FROM reservations r
       LEFT JOIN reservation_guests rg ON rg.reservation_id = r.id AND rg.property_id = r.property_id
       LEFT JOIN room_types rt ON rt.id = r.room_type_id AND rt.property_id = r.property_id
       LEFT JOIN stays s ON s.reservation_id = r.id AND s.property_id = r.property_id
       WHERE r.property_id = ? AND (r.primary_guest_id = ? OR rg.guest_id = ?)
       GROUP BY r.id, r.confirmation_no, r.status, r.check_in_date, r.check_out_date,
                r.adults, r.children, r.total_estimate, rt.name, s.checked_in_at, s.checked_out_at
       ORDER BY r.check_in_date DESC LIMIT 50`,
      [req.propertyId, guestId, guestId],
    );
    const [requests] = await db.execute(
      `SELECT id, type, description, status, assigned_department_id, created_at, completed_at
       FROM guest_requests WHERE property_id = ? AND guest_id = ? ORDER BY created_at DESC LIMIT 50`,
      [req.propertyId, guestId],
    );
    await auditRead(db, req, 'guest.profile.view', guestId, { reservationCount: reservations.length });
    res.json({
      data: {
        ...mapGuest(guest),
        reservations: reservations.map((row) => ({
          id: Number(row.id),
          confirmationNo: row.confirmation_no,
          status: row.status,
          checkInDate: String(row.check_in_date).slice(0, 10),
          checkOutDate: String(row.check_out_date).slice(0, 10),
          adults: Number(row.adults),
          children: Number(row.children),
          totalEstimate: String(row.total_estimate),
          roomType: row.room_type,
          checkedInAt: row.checked_in_at,
          checkedOutAt: row.checked_out_at,
        })),
        requests: requests.map((row) => ({
          id: Number(row.id),
          type: row.type,
          description: row.description,
          status: row.status,
          assignedDepartmentId: row.assigned_department_id === null ? null : Number(row.assigned_department_id),
          createdAt: row.created_at,
          completedAt: row.completed_at,
        })),
      },
    });
  }));

  router.put('/guests/:id', requirePermission(db, 'guests.manage'), route(async (req, res) => {
    const guestId = parse(positiveId, req.params.id);
    const data = parse(guestSchema.partial(), req.body);
    if (!Object.keys(data).length) throw httpError(400, 'EMPTY_UPDATE', 'Provide at least one field to update');
    const before = await getGuest(db, req.propertyId, guestId);
    if (!before) throw httpError(404, 'GUEST_NOT_FOUND', 'Guest not found');
    if (before.anonymised_at) throw httpError(409, 'GUEST_ANONYMISED', 'An anonymised guest cannot be edited');
    const idHash = Object.hasOwn(data, 'idNumber')
      ? data.idNumber ? hashIdNumber(data.idNumber) : null
      : before.id_number_hash;
    const duplicate = await findDuplicate(db, req.propertyId, data, idHash, guestId);
    if (duplicate) {
      return res.status(409).json({
        error: { code: 'POSSIBLE_DUPLICATE', message: 'A matching guest already exists', duplicateGuestId: Number(duplicate.id) },
      });
    }
    const fields = normalizedGuestFields({ ...mapGuest(before), ...data });
    const updates = { ...fields };
    if (Object.hasOwn(data, 'idNumber')) {
      updates.id_number_enc = data.idNumber ? encryptIdNumber(data.idNumber) : null;
      updates.id_number_hash = data.idNumber ? hashIdNumber(data.idNumber) : null;
      updates.id_number_last4 = data.idNumber ? idNumberLast4(data.idNumber) : null;
    }
    const columns = Object.keys(updates);
    await inAuditedTransaction(db, req, () => ({
      action: 'guest.update',
      entity: 'guest',
      entityId: guestId,
      before: { guestId, fields: Object.keys(data), hasIdNumber: Boolean(before.id_number_enc) },
      after: { guestId, fields: Object.keys(data), hasIdNumber: Boolean(updates.id_number_enc ?? before.id_number_enc) },
    }), async (connection) => {
      await connection.execute(
        `UPDATE guests SET ${columns.map((column) => `\`${column}\` = ?`).join(', ')}
         WHERE id = ? AND property_id = ? AND deleted_at IS NULL`,
        [...columns.map((column) => updates[column]), guestId, req.propertyId],
      );
      return { id: guestId };
    });
    const updated = await getGuest(db, req.propertyId, guestId);
    res.json({ data: mapGuest(updated) });
  }));

  router.post('/guests/:id/reveal-id', requirePermission(db, 'guest.view_id'), route(async (req, res) => {
    const guestId = parse(positiveId, req.params.id);
    const guest = await getGuest(db, req.propertyId, guestId);
    if (!guest || !guest.id_number_enc || guest.anonymised_at) throw httpError(404, 'ID_NOT_FOUND', 'Guest identity number is unavailable');
    const idNumber = decryptIdNumber(guest.id_number_enc);
    await auditRead(db, req, 'guest.id.reveal', guestId, { revealed: true });
    res.json({ data: { idType: guest.id_type, idNumber } });
  }));

  router.post('/guests/:id/export', requirePermission(db, 'guests.manage'), route(async (req, res) => {
    const guestId = parse(positiveId, req.params.id);
    const guest = await getGuest(db, req.propertyId, guestId);
    if (!guest) throw httpError(404, 'GUEST_NOT_FOUND', 'Guest not found');
    const permissions = await getRolePermissions(db, req.auth.roleId);
    const includeId = permissions.includes('guest.view_id') && Boolean(guest.id_number_enc) && !guest.anonymised_at;
    const [reservations] = await db.execute(
      `SELECT r.id, r.confirmation_no, r.status, r.check_in_date, r.check_out_date, r.total_estimate
       FROM reservations r
       WHERE r.property_id = ? AND (
         r.primary_guest_id = ? OR EXISTS (
           SELECT 1 FROM reservation_guests rg
           WHERE rg.reservation_id = r.id AND rg.property_id = r.property_id AND rg.guest_id = ?
         )
       )
       ORDER BY r.check_in_date DESC`,
      [req.propertyId, guestId, guestId],
    );
    const [guestRequests] = await db.execute(
      `SELECT type, description, status, created_at, completed_at
       FROM guest_requests WHERE property_id = ? AND guest_id = ? ORDER BY created_at DESC`,
      [req.propertyId, guestId],
    );
    await auditRead(db, req, 'guest.data.export', guestId, {
      includedIdNumber: includeId,
      reservationCount: reservations.length,
      requestCount: guestRequests.length,
    });
    res.json({
      data: {
        ...mapGuest(guest),
        ...(includeId ? { idNumber: decryptIdNumber(guest.id_number_enc) } : {}),
        reservations: reservations.map((row) => ({
          id: Number(row.id),
          confirmationNo: row.confirmation_no,
          status: row.status,
          checkInDate: String(row.check_in_date).slice(0, 10),
          checkOutDate: String(row.check_out_date).slice(0, 10),
          totalEstimate: String(row.total_estimate),
        })),
        requests: guestRequests.map((row) => ({
          type: row.type,
          description: row.description,
          status: row.status,
          createdAt: row.created_at,
          completedAt: row.completed_at,
        })),
      },
    });
  }));

  router.post('/guests/:id/anonymize', requirePermission(db, 'guests.manage'), route(async (req, res) => {
    const guestId = parse(positiveId, req.params.id);
    const { reason } = parse(anonymizeSchema, req.body);
    await inAuditedTransaction(db, req, () => ({
      action: 'guest.anonymize',
      entity: 'guest',
      entityId: guestId,
      before: { guestId, anonymised: false },
      after: { guestId, anonymised: true, reason },
    }), async (connection) => {
      const guest = await getGuest(connection, req.propertyId, guestId, true);
      if (!guest) throw httpError(404, 'GUEST_NOT_FOUND', 'Guest not found');
      if (guest.anonymised_at) throw httpError(409, 'GUEST_ANONYMISED', 'Guest is already anonymised');
      await connection.execute(
        `UPDATE guests SET first_name = 'Anonymous', last_name = 'Guest',
           phone = NULL, email = NULL, nationality = NULL, id_type = NULL,
           id_number_enc = NULL, id_number_hash = NULL, id_number_last4 = NULL,
           date_of_birth = NULL, notes = NULL, preferences = NULL, is_vip = 0,
           anonymised_at = CURRENT_TIMESTAMP
         WHERE id = ? AND property_id = ?`,
        [guestId, req.propertyId],
      );
      return { id: guestId };
    });
    res.json({ data: { id: guestId, anonymised: true } });
  }));

  router.post('/guests/:id/merge', requirePermission(db, 'guests.manage'), route(async (req, res) => {
    const sourceId = parse(positiveId, req.params.id);
    const { targetGuestId, reason } = parse(mergeSchema, req.body);
    if (sourceId === targetGuestId) throw httpError(400, 'INVALID_MERGE', 'Source and target guests must be different');
    await inAuditedTransaction(db, req, () => ({
      action: 'guest.merge',
      entity: 'guest',
      entityId: sourceId,
      before: { sourceGuestId: sourceId, targetGuestId },
      after: { sourceGuestId: sourceId, targetGuestId, reason },
    }), async (connection) => {
      const source = await getGuest(connection, req.propertyId, sourceId, true);
      const target = await getGuest(connection, req.propertyId, targetGuestId, true);
      if (!source || !target) throw httpError(404, 'GUEST_NOT_FOUND', 'One or both guests are unavailable');
      if (source.anonymised_at || target.anonymised_at) throw httpError(409, 'GUEST_ANONYMISED', 'Anonymised guests cannot be merged');

      await connection.execute(
        `DELETE source_row FROM reservation_guests source_row
         JOIN reservation_guests target_row
           ON target_row.property_id = source_row.property_id
          AND target_row.reservation_id = source_row.reservation_id
          AND target_row.guest_id = ?
         WHERE source_row.property_id = ? AND source_row.guest_id = ?`,
        [targetGuestId, req.propertyId, sourceId],
      );
      await connection.execute('UPDATE reservations SET primary_guest_id = ? WHERE property_id = ? AND primary_guest_id = ?', [targetGuestId, req.propertyId, sourceId]);
      await connection.execute('UPDATE reservation_guests SET guest_id = ? WHERE property_id = ? AND guest_id = ?', [targetGuestId, req.propertyId, sourceId]);
      await connection.execute('UPDATE folios SET guest_id = ? WHERE property_id = ? AND guest_id = ?', [targetGuestId, req.propertyId, sourceId]);
      await connection.execute('UPDATE groups SET leader_guest_id = ? WHERE property_id = ? AND leader_guest_id = ?', [targetGuestId, req.propertyId, sourceId]);
      await connection.execute(
        `DELETE source_row FROM group_guests source_row
         JOIN group_guests target_row
           ON target_row.property_id = source_row.property_id
          AND target_row.group_id = source_row.group_id
          AND target_row.guest_id = ?
         WHERE source_row.property_id = ? AND source_row.guest_id = ?`,
        [targetGuestId, req.propertyId, sourceId],
      );
      await connection.execute('UPDATE group_guests SET guest_id = ? WHERE property_id = ? AND guest_id = ?', [targetGuestId, req.propertyId, sourceId]);
      await connection.execute('UPDATE guest_requests SET guest_id = ? WHERE property_id = ? AND guest_id = ?', [targetGuestId, req.propertyId, sourceId]);
      await connection.execute(
        `UPDATE guests SET first_name = 'Merged', last_name = 'Guest', phone = NULL, email = NULL,
           nationality = NULL, id_type = NULL, id_number_enc = NULL, id_number_hash = NULL,
           id_number_last4 = NULL, date_of_birth = NULL, notes = NULL, preferences = NULL,
           is_vip = 0, anonymised_at = CURRENT_TIMESTAMP, deleted_at = CURRENT_TIMESTAMP
         WHERE id = ? AND property_id = ?`,
        [sourceId, req.propertyId],
      );
      return { sourceId, targetGuestId };
    });
    res.json({ data: { sourceGuestId: sourceId, targetGuestId, merged: true } });
  }));

  router.get('/companies', requirePermission(db, 'guests.view'), route(async (req, res) => {
    const [rows] = await db.execute(
      `SELECT id, name, tin, contact, credit_terms FROM companies
       WHERE property_id = ? AND deleted_at IS NULL ORDER BY name`,
      [req.propertyId],
    );
    res.json({ data: rows.map(mapCompany) });
  }));

  router.post('/companies', requirePermission(db, 'guests.manage'), route(async (req, res) => {
    const data = parse(companySchema, req.body);
    const result = await inAuditedTransaction(db, req, () => ({
      action: 'company.create',
      entity: 'company',
      after: { name: data.name },
    }), async (connection) => {
      const [inserted] = await connection.execute(
        `INSERT INTO companies (property_id, name, tin, contact, credit_terms)
         VALUES (?, ?, ?, ?, ?)`,
        [req.propertyId, data.name, data.tin || null, data.contact ? JSON.stringify(data.contact) : null, data.creditTerms || null],
      );
      return { id: Number(inserted.insertId) };
    });
    res.status(201).json({ data: { id: result.id, ...data } });
  }));

  router.put('/companies/:id', requirePermission(db, 'guests.manage'), route(async (req, res) => {
    const id = parse(positiveId, req.params.id);
    const data = parse(companySchema, req.body);
    const [rows] = await db.execute('SELECT id, name FROM companies WHERE id = ? AND property_id = ? AND deleted_at IS NULL', [id, req.propertyId]);
    if (!rows.length) throw httpError(404, 'COMPANY_NOT_FOUND', 'Company not found');
    await inAuditedTransaction(db, req, () => ({
      action: 'company.update',
      entity: 'company',
      entityId: id,
      before: { name: rows[0].name },
      after: { name: data.name },
    }), async (connection) => {
      await connection.execute(
        `UPDATE companies SET name = ?, tin = ?, contact = ?, credit_terms = ?
         WHERE id = ? AND property_id = ? AND deleted_at IS NULL`,
        [data.name, data.tin || null, data.contact ? JSON.stringify(data.contact) : null, data.creditTerms || null, id, req.propertyId],
      );
      return { id };
    });
    res.json({ data: { id, ...data } });
  }));

  router.delete('/companies/:id', requirePermission(db, 'guests.manage'), route(async (req, res) => {
    const id = parse(positiveId, req.params.id);
    const [rows] = await db.execute('SELECT name FROM companies WHERE id = ? AND property_id = ? AND deleted_at IS NULL', [id, req.propertyId]);
    if (!rows.length) throw httpError(404, 'COMPANY_NOT_FOUND', 'Company not found');
    await inAuditedTransaction(db, req, () => ({
      action: 'company.archive',
      entity: 'company',
      entityId: id,
      before: { name: rows[0].name },
      after: { archived: true },
    }), async (connection) => {
      await connection.execute('UPDATE companies SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND property_id = ?', [id, req.propertyId]);
      return { id };
    });
    res.status(204).end();
  }));

  router.get('/guest-groups', requirePermission(db, 'guests.view'), route(async (req, res) => {
    const [groups] = await db.execute(
      `SELECT g.id, g.name, g.leader_guest_id, g.notes, leader.first_name, leader.last_name,
              COUNT(gg.guest_id) AS member_count
       FROM groups g
       LEFT JOIN guests leader ON leader.id = g.leader_guest_id AND leader.property_id = g.property_id
       LEFT JOIN group_guests gg ON gg.group_id = g.id AND gg.property_id = g.property_id
       WHERE g.property_id = ? AND g.deleted_at IS NULL
       GROUP BY g.id, g.name, g.leader_guest_id, g.notes, leader.first_name, leader.last_name
       ORDER BY g.name`,
      [req.propertyId],
    );
    const data = [];
    for (const group of groups) {
      const [members] = await db.execute(
        `SELECT guest.id, guest.first_name, guest.last_name
         FROM group_guests gg JOIN guests guest ON guest.id = gg.guest_id AND guest.property_id = gg.property_id
         WHERE gg.property_id = ? AND gg.group_id = ? AND guest.deleted_at IS NULL
         ORDER BY guest.last_name, guest.first_name`,
        [req.propertyId, group.id],
      );
      data.push({
        id: Number(group.id),
        name: group.name,
        leaderGuestId: group.leader_guest_id === null ? null : Number(group.leader_guest_id),
        leaderName: group.first_name ? `${group.first_name} ${group.last_name}` : null,
        notes: group.notes,
        memberCount: Number(group.member_count),
        members: members.map((member) => ({ id: Number(member.id), name: `${member.first_name} ${member.last_name}` })),
      });
    }
    await auditRead(db, req, 'guest_group.view', null, { resultCount: data.length }, 'guest_group');
    res.json({ data });
  }));

  router.post('/guest-groups', requirePermission(db, 'guests.manage'), route(async (req, res) => {
    const data = parse(groupSchema, req.body);
    const ids = [...new Set([...data.guestIds, ...(data.leaderGuestId ? [data.leaderGuestId] : [])])];
    await ensureGuestIds(db, req.propertyId, ids);
    const result = await inAuditedTransaction(db, req, () => ({
      action: 'guest_group.create',
      entity: 'guest_group',
      after: { name: data.name, memberCount: ids.length },
    }), async (connection) => {
      const [inserted] = await connection.execute(
        'INSERT INTO groups (property_id, name, leader_guest_id, notes) VALUES (?, ?, ?, ?)',
        [req.propertyId, data.name, data.leaderGuestId || null, data.notes || null],
      );
      const id = Number(inserted.insertId);
      await updateGroupMembers(connection, req.propertyId, id, ids);
      return { id };
    });
    res.status(201).json({ data: { id: result.id, name: data.name, leaderGuestId: data.leaderGuestId ?? null, guestIds: ids } });
  }));

  router.put('/guest-groups/:id', requirePermission(db, 'guests.manage'), route(async (req, res) => {
    const id = parse(positiveId, req.params.id);
    const data = parse(groupSchema, req.body);
    const ids = [...new Set([...data.guestIds, ...(data.leaderGuestId ? [data.leaderGuestId] : [])])];
    await ensureGuestIds(db, req.propertyId, ids);
    const [rows] = await db.execute('SELECT name FROM groups WHERE id = ? AND property_id = ? AND deleted_at IS NULL', [id, req.propertyId]);
    if (!rows.length) throw httpError(404, 'GROUP_NOT_FOUND', 'Guest group not found');
    await inAuditedTransaction(db, req, () => ({
      action: 'guest_group.update',
      entity: 'guest_group',
      entityId: id,
      before: { name: rows[0].name },
      after: { name: data.name, memberCount: ids.length },
    }), async (connection) => {
      await connection.execute(
        'UPDATE groups SET name = ?, leader_guest_id = ?, notes = ? WHERE id = ? AND property_id = ?',
        [data.name, data.leaderGuestId || null, data.notes || null, id, req.propertyId],
      );
      await updateGroupMembers(connection, req.propertyId, id, ids);
      return { id };
    });
    res.json({ data: { id, name: data.name, leaderGuestId: data.leaderGuestId ?? null, guestIds: ids } });
  }));

  router.get('/guest-requests', requirePermission(db, 'guests.view'), route(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !['open', 'in_progress', 'resolved', 'cancelled'].includes(status)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Unsupported request status');
    }
    const parameters = [req.propertyId];
    const statusFilter = status ? ' AND gr.status = ?' : '';
    if (status) parameters.push(status);
    const [rows] = await db.execute(
      `SELECT gr.id, gr.guest_id, gr.stay_id, gr.type, gr.description, gr.status,
              gr.assigned_department_id, gr.assigned_to, gr.created_at, gr.completed_at,
              guest.first_name, guest.last_name, department.name AS department_name,
              assignee.name AS assignee_name
       FROM guest_requests gr
       LEFT JOIN guests guest ON guest.id = gr.guest_id AND guest.property_id = gr.property_id
       LEFT JOIN departments department ON department.id = gr.assigned_department_id AND department.property_id = gr.property_id
       LEFT JOIN users assignee ON assignee.id = gr.assigned_to
       WHERE gr.property_id = ?${statusFilter}
       ORDER BY FIELD(gr.status, 'open', 'in_progress', 'resolved', 'cancelled'), gr.created_at DESC
       LIMIT 200`,
      parameters,
    );
    await auditRead(db, req, 'guest_requests.view', null, { resultCount: rows.length });
    res.json({ data: rows.map((row) => ({
      id: Number(row.id),
      guestId: row.guest_id === null ? null : Number(row.guest_id),
      guestName: row.first_name ? `${row.first_name} ${row.last_name}` : null,
      stayId: row.stay_id === null ? null : Number(row.stay_id),
      type: row.type,
      description: row.description,
      status: row.status,
      assignedDepartmentId: row.assigned_department_id === null ? null : Number(row.assigned_department_id),
      departmentName: row.department_name,
      assignedTo: row.assigned_to === null ? null : Number(row.assigned_to),
      assigneeName: row.assignee_name,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    })) });
  }));

  router.get('/guest-requests/departments', requirePermission(db, 'guests.view'), route(async (req, res) => {
    const [rows] = await db.execute(
      `SELECT id, name FROM departments WHERE property_id = ? AND deleted_at IS NULL ORDER BY name`,
      [req.propertyId],
    );
    res.json({ data: rows.map((row) => ({ id: Number(row.id), name: row.name })) });
  }));

  router.post('/guest-requests', requirePermission(db, 'guest_requests.manage'), route(async (req, res) => {
    const data = parse(requestSchema, req.body);
    if (data.guestId) {
      const guest = await getGuest(db, req.propertyId, data.guestId);
      if (!guest) throw httpError(400, 'INVALID_GUEST', 'Guest is unavailable in this property');
    }
    if (data.stayId) {
      const [stays] = await db.execute(
        'SELECT id FROM stays WHERE id = ? AND property_id = ? LIMIT 1',
        [data.stayId, req.propertyId],
      );
      if (!stays.length) throw httpError(400, 'INVALID_STAY', 'Stay is unavailable in this property');
    }
    if (data.assignedDepartmentId) {
      const [departments] = await db.execute(
        'SELECT id FROM departments WHERE id = ? AND property_id = ? AND deleted_at IS NULL',
        [data.assignedDepartmentId, req.propertyId],
      );
      if (!departments.length) throw httpError(400, 'INVALID_DEPARTMENT', 'Department is unavailable in this property');
    }
    const result = await inAuditedTransaction(db, req, () => ({
      action: 'guest_request.create',
      entity: 'guest_request',
      after: { guestId: data.guestId ?? null, stayId: data.stayId ?? null, type: data.type, status: 'open' },
    }), async (connection) => {
      const [inserted] = await connection.execute(
        `INSERT INTO guest_requests
          (property_id, guest_id, stay_id, type, description, status, assigned_department_id, created_by)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
        [req.propertyId, data.guestId ?? null, data.stayId ?? null, data.type, data.description, data.assignedDepartmentId ?? null, req.auth.sub],
      );
      return { id: Number(inserted.insertId) };
    });
    res.status(201).json({ data: { id: result.id, ...data, status: 'open' } });
  }));

  router.patch('/guest-requests/:id', requirePermission(db, 'guest_requests.manage'), route(async (req, res) => {
    const id = parse(positiveId, req.params.id);
    const data = parse(requestUpdateSchema, req.body);
    if (!Object.keys(data).length) throw httpError(400, 'EMPTY_UPDATE', 'Provide a status or assignment');
    const [rows] = await db.execute(
      'SELECT id, status, assigned_department_id, assigned_to FROM guest_requests WHERE id = ? AND property_id = ?',
      [id, req.propertyId],
    );
    const before = rows[0];
    if (!before) throw httpError(404, 'GUEST_REQUEST_NOT_FOUND', 'Guest request not found');
    if (data.status && data.status !== before.status && !requestTransitions[before.status]?.includes(data.status)) {
      throw httpError(409, 'INVALID_STATUS_TRANSITION', `Cannot move a ${before.status} request to ${data.status}`);
    }
    if (data.assignedDepartmentId) {
      const [departments] = await db.execute(
        'SELECT id FROM departments WHERE id = ? AND property_id = ? AND deleted_at IS NULL',
        [data.assignedDepartmentId, req.propertyId],
      );
      if (!departments.length) throw httpError(400, 'INVALID_DEPARTMENT', 'Department is unavailable in this property');
    }
    if (data.assignedTo) {
      const [users] = await db.execute(
        `SELECT u.id FROM users u JOIN user_properties up ON up.user_id = u.id
         WHERE u.id = ? AND u.is_active = 1 AND up.property_id = ?`,
        [data.assignedTo, req.propertyId],
      );
      if (!users.length) throw httpError(400, 'INVALID_ASSIGNEE', 'Assignee is unavailable in this property');
    }
    const updates = [];
    const values = [];
    if (Object.hasOwn(data, 'status')) {
      updates.push('status = ?');
      values.push(data.status);
      updates.push('completed_at = ?');
      values.push(data.status === 'resolved' ? new Date() : null);
    }
    if (Object.hasOwn(data, 'assignedDepartmentId')) {
      updates.push('assigned_department_id = ?');
      values.push(data.assignedDepartmentId);
    }
    if (Object.hasOwn(data, 'assignedTo')) {
      updates.push('assigned_to = ?');
      values.push(data.assignedTo);
    }
    await inAuditedTransaction(db, req, () => ({
      action: 'guest_request.update',
      entity: 'guest_request',
      entityId: id,
      before: { status: before.status, departmentId: before.assigned_department_id, assignedTo: before.assigned_to },
      after: data,
    }), async (connection) => {
      await connection.execute(
        `UPDATE guest_requests SET ${updates.join(', ')} WHERE id = ? AND property_id = ?`,
        [...values, id, req.propertyId],
      );
      return { id };
    });
    res.json({ data: { id, ...data } });
  }));

  router.use((error, _req, res, next) => {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    if (status >= 500) logger.error({ code: error?.code }, 'Guest API request failed');
    if (res.headersSent) return next(error);
    if (error?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: { code: 'DUPLICATE_RECORD', message: 'A matching record already exists' } });
    }
    const payload = {
      code: error?.code ?? 'INTERNAL_ERROR',
      message: status === 500 ? 'The guest request could not be completed' : error.message,
    };
    if (error?.details) payload.details = error.details;
    return res.status(status).json({ error: payload });
  });
  return router;
}
