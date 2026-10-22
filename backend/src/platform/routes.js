import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { authenticate, propertyScope, requirePermission } from '../auth/middleware.js';
import { auditable, inAuditedTransaction } from '../auth/audit.js';
import { getRolePermissions, rolePermissionMatrix } from '../auth/permissions.js';
import { env } from '../config/env.js';
import { getOrganizationPlan } from './plans.js';

const adminName = z.string().trim().min(1).max(200);
const propertySchema = z.object({
  name: z.string().trim().min(1).max(200),
  city: z.string().trim().max(120).optional().default(''),
  timezone: z.string().trim().min(1).max(80).default('Africa/Addis_Ababa'),
  currency: z.string().regex(/^[A-Z]{3}$/).default('ETB'),
});

const organizationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  packageId: z.coerce.number().int().positive(),
  licenseMode: z.enum(['cloud', 'local']).default('cloud'),
  property: propertySchema,
  owner: z.object({
    name: adminName,
    email: z.string().trim().email().max(190),
    password: z.string().min(12).max(128),
  }),
});
const propertyCreateSchema = z.object({ organizationId: z.coerce.number().int().positive(), ...propertySchema.shape });
const organizationUpdateSchema = z.object({
  status: z.enum(['active', 'suspended']).optional(),
  subscriptionStatus: z.enum(['trial', 'active', 'past_due', 'cancelled']).optional(),
  packageId: z.coerce.number().int().positive().optional(),
});
const billingNoteSchema = z.object({
  note: z.string().trim().min(1).max(5000),
  amount: z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).default('ETB'),
  periodFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  periodTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
const packageSchema = z.object({
  name: z.string().trim().min(1).max(100),
  maxRooms: z.coerce.number().int().min(1).max(100000),
  maxUsers: z.coerce.number().int().min(1).max(100000),
  modules: z.array(z.string().trim().min(1).max(80)).max(50),
  monthlyFee: z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/),
});
const supportRequestSchema = z.object({
  organizationId: z.coerce.number().int().positive(),
  propertyId: z.coerce.number().int().positive(),
  reason: z.string().trim().min(10).max(1000),
  durationMinutes: z.coerce.number().int().min(5).max(60).default(30),
});

function responseError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function insertProperty(connection, organizationId, property) {
  return connection.execute(
    `INSERT INTO properties
      (organization_id, name, city, timezone, currency, business_date, check_in_time, check_out_time, tax_settings, is_active)
     VALUES (?, ?, ?, ?, ?, UTC_DATE(), '14:00:00', '11:00:00', ?, 1)`,
    [
      organizationId,
      property.name,
      property.city,
      property.timezone,
      property.currency,
      JSON.stringify({ vatPercent: 0, serviceChargePercent: 0, tourismLevyPercent: 0, pricesTaxInclusive: false }),
    ],
  );
}

async function exportOrganizationData(db, organizationId) {
  const [properties] = await db.execute(
    'SELECT id FROM properties WHERE organization_id = ? ORDER BY id',
    [organizationId],
  );
  const propertyIds = properties.map(({ id }) => Number(id));
  const [columns] = await db.execute(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
     ORDER BY TABLE_NAME, ORDINAL_POSITION`,
  );
  const tables = new Map();
  for (const { tableName, columnName } of columns) {
    if (!tables.has(tableName)) tables.set(tableName, new Set());
    tables.get(tableName).add(columnName);
  }
  const exported = {};
  for (const [tableName, tableColumns] of tables) {
    const scopedByOrganization = tableColumns.has('organization_id');
    const scopedByProperty = tableColumns.has('property_id') && propertyIds.length > 0;
    if (!scopedByOrganization && !scopedByProperty) continue;
    let rows;
    if (scopedByOrganization) {
      [rows] = await db.execute(
        `SELECT * FROM \`${tableName}\` WHERE organization_id = ? ORDER BY id`,
        [organizationId],
      );
    } else {
      [rows] = await db.execute(
        `SELECT * FROM \`${tableName}\` WHERE property_id IN (${propertyIds.map(() => '?').join(',')}) ORDER BY id`,
        propertyIds,
      );
    }
    if (tableName === 'users') {
      const excludedColumns = new Set(['password_hash', 'failed_login_attempts', 'locked_until']);
      rows = rows.map((user) => Object.fromEntries(
        Object.entries(user).filter(([column]) => !excludedColumns.has(column)),
      ));
    }
    exported[tableName] = rows;
  }
  if (tables.has('role_permissions')) {
    [exported.role_permissions] = await db.execute(
      `SELECT rp.* FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       WHERE r.organization_id = ?
       ORDER BY rp.role_id, rp.permission_key`,
      [organizationId],
    );
  }
  if (tables.has('user_properties')) {
    [exported.user_properties] = await db.execute(
      `SELECT up.* FROM user_properties up
       JOIN users u ON u.id = up.user_id AND u.organization_id = ?
       JOIN properties p ON p.id = up.property_id AND p.organization_id = ?
       ORDER BY up.user_id, up.property_id`,
      [organizationId, organizationId],
    );
  }
  if (tables.has('permissions')) {
    [exported.permissions] = await db.execute('SELECT * FROM permissions ORDER BY id');
  }
  if (tables.has('packages')) {
    [exported.packages] = await db.execute(
      `SELECT p.* FROM packages p
       JOIN organizations o ON o.package_id = p.id
       WHERE o.id = ?`,
      [organizationId],
    );
  }
  return { exportedAt: new Date().toISOString(), organizationId, data: exported };
}

export function createPlatformRouter(db) {
  const router = Router();
  const platformAdmin = [authenticate(db), requirePermission(db, 'super_admin.manage')];
  const customerAdmin = [authenticate(db), propertyScope(db), requirePermission(db, 'users.manage')];

  router.get('/packages', ...platformAdmin, async (_req, res, next) => {
    try {
      const [rows] = await db.execute(
        'SELECT id, name, max_rooms AS maxRooms, max_users AS maxUsers, modules, monthly_fee AS monthlyFee FROM packages ORDER BY max_rooms, name',
      );
      return res.json({
        data: rows.map((row) => ({
          ...row,
          id: Number(row.id),
          maxRooms: Number(row.maxRooms),
          maxUsers: Number(row.maxUsers),
          modules: typeof row.modules === 'string' ? JSON.parse(row.modules) : row.modules,
        })),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/packages', ...platformAdmin, async (req, res, next) => {
    const parsed = packageSchema.safeParse(req.body);
    if (!parsed.success) return responseError(res, 400, 'VALIDATION_ERROR', 'Package details are invalid');
    try {
      const [insert] = await db.execute(
        'INSERT INTO packages (name, max_rooms, max_users, modules, monthly_fee) VALUES (?, ?, ?, ?, ?)',
        [
          parsed.data.name,
          parsed.data.maxRooms,
          parsed.data.maxUsers,
          JSON.stringify([...new Set(parsed.data.modules)]),
          parsed.data.monthlyFee,
        ],
      );
      await auditable(db, {
        organizationId: null,
        actorId: req.auth.sub,
        action: 'package.created',
        entity: 'package',
        entityId: insert.insertId,
        after: parsed.data,
        ip: req.ip,
      });
      return res.status(201).json({ data: { id: Number(insert.insertId) } });
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') return responseError(res, 409, 'PACKAGE_EXISTS', 'A package with that name already exists');
      return next(error);
    }
  });

  router.patch('/packages/:id', ...platformAdmin, async (req, res, next) => {
    const packageId = Number(req.params.id);
    const parsed = packageSchema.safeParse(req.body);
    if (!Number.isInteger(packageId) || packageId < 1 || !parsed.success) {
      return responseError(res, 400, 'VALIDATION_ERROR', 'Package details are invalid');
    }
    try {
      const [result] = await db.execute(
        `UPDATE packages SET name = ?, max_rooms = ?, max_users = ?, modules = ?, monthly_fee = ?
         WHERE id = ?`,
        [
          parsed.data.name, parsed.data.maxRooms, parsed.data.maxUsers,
          JSON.stringify([...new Set(parsed.data.modules)]), parsed.data.monthlyFee, packageId,
        ],
      );
      if (!result.affectedRows) return responseError(res, 404, 'PACKAGE_NOT_FOUND', 'Package not found');
      await auditable(db, {
        organizationId: null,
        actorId: req.auth.sub,
        action: 'package.updated',
        entity: 'package',
        entityId: packageId,
        after: parsed.data,
        ip: req.ip,
      });
      return res.status(204).end();
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') return responseError(res, 409, 'PACKAGE_EXISTS', 'A package with that name already exists');
      return next(error);
    }
  });
  router.get('/organizations', ...platformAdmin, async (_req, res, next) => {
    try {
      const [organizations] = await db.execute(
        `SELECT o.id, o.name, o.status, o.subscription_status AS subscriptionStatus,
                o.licence_mode AS licenseMode, o.installation_id AS installationId,
                p.id AS packageId, p.name AS packageName, p.max_rooms AS roomLimit,
                p.max_users AS userLimit, p.modules,
                (SELECT COUNT(*) FROM properties pr WHERE pr.organization_id = o.id AND pr.is_active = 1) AS propertyCount,
                (SELECT COUNT(*) FROM rooms r JOIN properties pr ON pr.id = r.property_id
                 WHERE pr.organization_id = o.id AND r.is_active = 1 AND r.deleted_at IS NULL) AS roomCount,
                (SELECT COUNT(*) FROM users u WHERE u.organization_id = o.id AND u.is_active = 1) AS userCount
         FROM organizations o LEFT JOIN packages p ON p.id = o.package_id
         ORDER BY o.name`,
      );
      return res.json({
        data: organizations.map((organization) => ({
          ...organization,
          id: Number(organization.id),
          packageId: Number(organization.packageId),
          roomLimit: Number(organization.roomLimit),
          userLimit: Number(organization.userLimit),
          propertyCount: Number(organization.propertyCount),
          roomCount: Number(organization.roomCount),
          userCount: Number(organization.userCount),
          modules: typeof organization.modules === 'string'
            ? JSON.parse(organization.modules)
            : organization.modules,
        })),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/organizations', ...platformAdmin, async (req, res, next) => {
    const parsed = organizationSchema.safeParse(req.body);
    if (!parsed.success) return responseError(res, 400, 'VALIDATION_ERROR', 'Organization details are invalid');
    try {
      const created = await inAuditedTransaction(db, req, (result) => ({
        action: 'organization.created',
        entity: 'organization',
        entityId: result.organizationId,
        after: { name: parsed.data.name, packageId: parsed.data.packageId, licenseMode: parsed.data.licenseMode },
      }), async (connection) => {
        const [packages] = await connection.execute('SELECT id FROM packages WHERE id = ? LIMIT 1', [parsed.data.packageId]);
        if (!packages.length) throw Object.assign(new Error('Package does not exist'), { status: 400, code: 'INVALID_PACKAGE' });
        const installationId = parsed.data.licenseMode === 'local' ? randomUUID() : null;
        const [organization] = await connection.execute(
          `INSERT INTO organizations (name, package_id, status, licence_mode, subscription_status, installation_id)
           VALUES (?, ?, 'active', ?, 'active', ?)`,
          [parsed.data.name, parsed.data.packageId, parsed.data.licenseMode, installationId],
        );
        const organizationId = Number(organization.insertId);
        const [property] = await insertProperty(connection, organizationId, parsed.data.property);
        const propertyId = Number(property.insertId);
        const roleIds = {};
        for (const [roleName, permissionKeys] of Object.entries(rolePermissionMatrix)) {
          if (roleName === 'super_admin') continue;
          const [role] = await connection.execute(
            'INSERT INTO roles (organization_id, name, is_system) VALUES (?, ?, 1)',
            [organizationId, roleName],
          );
          roleIds[roleName] = Number(role.insertId);
          for (const permissionKey of permissionKeys) {
            await connection.execute(
              'INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)',
              [roleIds[roleName], permissionKey],
            );
          }
        }
        const [owner] = await connection.execute(
          `INSERT INTO users (organization_id, name, email, password_hash, role_id, is_active)
           VALUES (?, ?, ?, ?, ?, 1)`,
          [
            organizationId,
            parsed.data.owner.name,
            parsed.data.owner.email.toLowerCase(),
            await bcrypt.hash(parsed.data.owner.password, 12),
            roleIds.owner_gm,
          ],
        );
        await connection.execute(
          'INSERT INTO user_properties (user_id, property_id) VALUES (?, ?)',
          [owner.insertId, propertyId],
        );
        return { organizationId, propertyId };
      });
      return res.status(201).json({ data: created });
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') return responseError(res, 409, 'DUPLICATE_ORGANIZATION', 'Organization name or owner email already exists');
      return next(error);
    }
  });

  router.patch('/organizations/:id', ...platformAdmin, async (req, res, next) => {
    const organizationId = Number(req.params.id);
    const parsed = organizationUpdateSchema.safeParse(req.body);
    if (!Number.isInteger(organizationId) || organizationId < 1 || !parsed.success || !Object.keys(parsed.data).length) {
      return responseError(res, 400, 'VALIDATION_ERROR', 'Organization update is invalid');
    }
    try {
      await inAuditedTransaction(db, req, (result) => ({
        action: 'organization.updated',
        entity: 'organization',
        entityId: organizationId,
        before: result.before,
        after: parsed.data,
      }), async (connection) => {
        const [rows] = await connection.execute(
          'SELECT id, status, subscription_status AS subscriptionStatus, package_id AS packageId FROM organizations WHERE id = ? FOR UPDATE',
          [organizationId],
        );
        if (!rows.length) throw Object.assign(new Error('Organization not found'), { status: 404, code: 'ORGANIZATION_NOT_FOUND' });
        if (parsed.data.packageId) {
          const [packages] = await connection.execute('SELECT id FROM packages WHERE id = ?', [parsed.data.packageId]);
          if (!packages.length) throw Object.assign(new Error('Package does not exist'), { status: 400, code: 'INVALID_PACKAGE' });
        }
        const fields = [];
        const values = [];
        for (const [key, column] of [['status', 'status'], ['subscriptionStatus', 'subscription_status'], ['packageId', 'package_id']]) {
          if (parsed.data[key] !== undefined) {
            fields.push(`${column} = ?`);
            values.push(parsed.data[key]);
          }
        }
        await connection.execute(`UPDATE organizations SET ${fields.join(', ')} WHERE id = ?`, [...values, organizationId]);
        return { before: rows[0] };
      });
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post('/properties', ...platformAdmin, async (req, res, next) => {
    const parsed = propertyCreateSchema.safeParse(req.body);
    if (!parsed.success) return responseError(res, 400, 'VALIDATION_ERROR', 'Property details are invalid');
    try {
      const [organizations] = await db.execute('SELECT id FROM organizations WHERE id = ? AND status = \'active\'', [parsed.data.organizationId]);
      if (!organizations.length) return responseError(res, 404, 'ORGANIZATION_NOT_FOUND', 'Active organization not found');
      const [property] = await insertProperty(db, parsed.data.organizationId, parsed.data);
      await auditable(db, {
        organizationId: null,
        actorId: req.auth.sub,
        action: 'property.created_by_platform',
        entity: 'property',
        entityId: property.insertId,
        after: { organizationId: parsed.data.organizationId, name: parsed.data.name },
        ip: req.ip,
      });
      return res.status(201).json({ data: { id: Number(property.insertId) } });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/organizations/:id/billing-notes', ...platformAdmin, async (req, res, next) => {
    const organizationId = Number(req.params.id);
    if (!Number.isInteger(organizationId) || organizationId < 1) return responseError(res, 400, 'VALIDATION_ERROR', 'Organization id is invalid');
    try {
      const [notes] = await db.execute(
        `SELECT id, note, amount, currency, period_from AS periodFrom, period_to AS periodTo, created_at AS createdAt
         FROM billing_notes WHERE organization_id = ? ORDER BY created_at DESC`,
        [organizationId],
      );
      return res.json({ data: notes.map((note) => ({ ...note, id: Number(note.id) })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/organizations/:id/billing-notes', ...platformAdmin, async (req, res, next) => {
    const organizationId = Number(req.params.id);
    const parsed = billingNoteSchema.safeParse(req.body);
    if (!Number.isInteger(organizationId) || organizationId < 1 || !parsed.success) {
      return responseError(res, 400, 'VALIDATION_ERROR', 'Billing note is invalid');
    }
    try {
      const [insert] = await db.execute(
        `INSERT INTO billing_notes (organization_id, created_by, note, amount, currency, period_from, period_to)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          organizationId, req.auth.sub, parsed.data.note, parsed.data.amount ?? null,
          parsed.data.currency, parsed.data.periodFrom ?? null, parsed.data.periodTo ?? null,
        ],
      );
      await auditable(db, {
        organizationId: null,
        actorId: req.auth.sub,
        action: 'billing.note_added',
        entity: 'billing_note',
        entityId: insert.insertId,
        after: { organizationId, amount: parsed.data.amount ?? null, currency: parsed.data.currency },
        ip: req.ip,
      });
      return res.status(201).json({ data: { id: Number(insert.insertId) } });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/organizations/:id/usage', ...platformAdmin, async (req, res, next) => {
    const organizationId = Number(req.params.id);
    if (!Number.isInteger(organizationId) || organizationId < 1) return responseError(res, 400, 'VALIDATION_ERROR', 'Organization id is invalid');
    try {
      const plan = await getOrganizationPlan(db, organizationId);
      const [properties] = await db.execute('SELECT id FROM properties WHERE organization_id = ?', [organizationId]);
      return res.json({
        data: {
          ...plan,
          properties: properties.length,
          rooms: (await countRooms(db, organizationId)),
          users: (await countUsers(db, organizationId)),
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/support-requests', ...platformAdmin, async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT r.id, r.organization_id AS organizationId, o.name AS organizationName,
                r.requested_by AS requestedBy, r.reason, r.status, r.requested_at AS requestedAt,
                r.reviewed_at AS reviewedAt, r.expires_at AS expiresAt
         FROM support_access_requests r JOIN organizations o ON o.id = r.organization_id
         ORDER BY r.requested_at DESC LIMIT 100`,
      );
      return res.json({ data: rows.map((row) => ({ ...row, id: Number(row.id), organizationId: Number(row.organizationId) })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/support-requests', ...platformAdmin, async (req, res, next) => {
    const parsed = supportRequestSchema.safeParse(req.body);
    if (!parsed.success) return responseError(res, 400, 'VALIDATION_ERROR', 'Support request is invalid');
    try {
      const request = await inAuditedTransaction(db, req, (result) => ({
        organizationId: parsed.data.organizationId,
        propertyId: parsed.data.propertyId,
        action: 'support_access.requested',
        entity: 'support_access_request',
        entityId: result.id,
        after: { reason: parsed.data.reason, durationMinutes: parsed.data.durationMinutes },
      }), async (connection) => {
        const [properties] = await connection.execute(
          `SELECT id FROM properties WHERE id = ? AND organization_id = ? AND is_active = 1`,
          [parsed.data.propertyId, parsed.data.organizationId],
        );
        if (!properties.length) {
          throw Object.assign(new Error('Property does not belong to the selected organization'), {
            status: 400,
            code: 'INVALID_PROPERTY',
          });
        }
        const [insert] = await connection.execute(
          `INSERT INTO support_access_requests (organization_id, property_id, requested_by, reason, duration_minutes)
           VALUES (?, ?, ?, ?, ?)`,
          [parsed.data.organizationId, parsed.data.propertyId, req.auth.sub, parsed.data.reason, parsed.data.durationMinutes],
        );
        return { id: Number(insert.insertId) };
      });
      return res.status(201).json({ data: { id: request.id, status: 'pending' } });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/support-requests/customer', ...customerAdmin, async (req, res, next) => {
    if (req.auth.supportSessionId) return responseError(res, 403, 'SUPPORT_READ_ONLY', 'Support access cannot view customer approval requests');
    try {
      const [rows] = await db.execute(
        `SELECT id, property_id AS propertyId, requested_by AS requestedBy, reason, status,
                requested_at AS requestedAt, duration_minutes AS durationMinutes
         FROM support_access_requests
         WHERE organization_id = ? AND property_id = ? AND status IN ('pending', 'started', 'approved')
         ORDER BY requested_at`,
        [req.auth.orgId, req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({ ...row, id: Number(row.id), propertyId: Number(row.propertyId) })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/support-requests/:id/decision', ...customerAdmin, async (req, res, next) => {
    const requestId = Number(req.params.id);
    const parsed = z.object({ decision: z.enum(['approved', 'denied']) }).safeParse(req.body);
    if (!Number.isInteger(requestId) || requestId < 1 || !parsed.success) return responseError(res, 400, 'VALIDATION_ERROR', 'Support decision is invalid');
    try {
      await inAuditedTransaction(db, req, () => ({
        action: `support_access.${parsed.data.decision}`,
        entity: 'support_access_request',
        entityId: requestId,
        after: { decision: parsed.data.decision },
      }), async (connection) => {
        const [requests] = await connection.execute(
          `SELECT id FROM support_access_requests
           WHERE id = ? AND organization_id = ? AND property_id = ? AND status = 'pending'
           FOR UPDATE`,
          [requestId, req.auth.orgId, req.propertyId],
        );
        if (!requests.length) {
          throw Object.assign(new Error('Pending support request not found'), {
            status: 404,
            code: 'SUPPORT_REQUEST_NOT_FOUND',
          });
        }
        await connection.execute(
          `UPDATE support_access_requests
           SET status = ?, reviewed_by = ?, reviewed_at = UTC_TIMESTAMP(),
               expires_at = IF(? = 'approved', DATE_ADD(UTC_TIMESTAMP(), INTERVAL duration_minutes MINUTE), NULL)
           WHERE id = ?`,
          [parsed.data.decision, req.auth.sub, parsed.data.decision, requestId],
        );
      });
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post('/support-requests/:id/revoke', ...customerAdmin, async (req, res, next) => {
    const requestId = Number(req.params.id);
    if (!Number.isInteger(requestId) || requestId < 1) return responseError(res, 400, 'VALIDATION_ERROR', 'Support request id is invalid');
    try {
      await inAuditedTransaction(db, req, () => ({
        action: 'support_access.revoked',
        entity: 'support_access_request',
        entityId: requestId,
      }), async (connection) => {
        const [requests] = await connection.execute(
          `SELECT id FROM support_access_requests
           WHERE id = ? AND organization_id = ? AND property_id = ? AND status IN ('approved', 'started')
           FOR UPDATE`,
          [requestId, req.auth.orgId, req.propertyId],
        );
        if (!requests.length) {
          throw Object.assign(new Error('Approved support request not found'), {
            status: 404,
            code: 'SUPPORT_REQUEST_NOT_FOUND',
          });
        }
        await connection.execute(
          `UPDATE support_access_requests
           SET status = 'revoked', reviewed_by = ?, reviewed_at = UTC_TIMESTAMP() WHERE id = ?`,
          [req.auth.sub, requestId],
        );
        await connection.execute(
          'UPDATE support_access_sessions SET ended_at = UTC_TIMESTAMP() WHERE request_id = ? AND ended_at IS NULL',
          [requestId],
        );
      });
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post('/support-requests/:id/activate', ...platformAdmin, async (req, res, next) => {
    const requestId = Number(req.params.id);
    if (!Number.isInteger(requestId) || requestId < 1) return responseError(res, 400, 'VALIDATION_ERROR', 'Support request id is invalid');
    try {
      const activation = await inAuditedTransaction(db, req, (result) => ({
        organizationId: result.organizationId,
        propertyId: result.propertyId,
        action: 'support_access.started',
        entity: 'support_access_session',
        entityId: result.sessionId,
        after: { requestId, expiresAt: result.expiresAt },
      }), async (connection) => {
        const [rows] = await connection.execute(
          `SELECT r.id, r.organization_id, r.property_id, r.reviewed_by, r.expires_at,
                  TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), r.expires_at) AS remaining_seconds,
                  u.id AS support_role_id, p.name AS property_name
           FROM support_access_requests r
           JOIN organizations o ON o.id = r.organization_id AND o.status = 'active'
           JOIN roles u ON u.organization_id = r.organization_id AND u.name = 'owner_gm'
           JOIN properties p ON p.id = r.property_id AND p.organization_id = r.organization_id AND p.is_active = 1
           WHERE r.id = ? AND r.status = 'approved' AND r.expires_at > UTC_TIMESTAMP()
           LIMIT 1 FOR UPDATE`,
          [requestId],
        );
        const approvedRequest = rows[0];
        if (!approvedRequest) {
          throw Object.assign(new Error('Customer approval is missing or expired'), {
            status: 403,
            code: 'SUPPORT_APPROVAL_REQUIRED',
          });
        }
        const [session] = await connection.execute(
          `INSERT INTO support_access_sessions
            (request_id, organization_id, property_id, actor_id, approved_by, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            requestId, approvedRequest.organization_id, approvedRequest.property_id,
            req.auth.sub, approvedRequest.reviewed_by, approvedRequest.expires_at,
          ],
        );
        await connection.execute(
          `UPDATE support_access_requests SET status = 'started' WHERE id = ?`,
          [requestId],
        );
        return {
          sessionId: Number(session.insertId),
          organizationId: Number(approvedRequest.organization_id),
          propertyId: Number(approvedRequest.property_id),
          supportRoleId: Number(approvedRequest.support_role_id),
          propertyName: approvedRequest.property_name,
          expiresAt: approvedRequest.expires_at,
          remainingSeconds: Number(approvedRequest.remaining_seconds),
        };
      });
      const accessToken = jwt.sign({
        orgId: activation.organizationId,
        role: 'support',
        propertyIds: [activation.propertyId],
        activePropertyId: activation.propertyId,
        supportSessionId: activation.sessionId,
        supportRoleId: activation.supportRoleId,
      }, env.JWT_ACCESS_SECRET, {
        subject: String(req.auth.sub),
        expiresIn: Math.max(1, activation.remainingSeconds),
      });
      const permissions = await getRolePermissions(db, activation.supportRoleId);
      return res.json({
        data: {
          accessToken,
          supportSessionId: activation.sessionId,
          propertyId: activation.propertyId,
          property: { name: activation.propertyName },
          permissionKeys: permissions,
          modules: (await getOrganizationPlan(db, activation.organizationId)).modules,
          expiresAt: activation.expiresAt,
        },
      });
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') return responseError(res, 409, 'SUPPORT_SESSION_EXISTS', 'Support request already has a session');
      return next(error);
    }
  });

  router.post('/support/exit', authenticate(db), async (req, res, next) => {
    if (!req.auth.supportSessionId) return responseError(res, 403, 'SUPPORT_SESSION_REQUIRED', 'This action requires an active support session');
    try {
      const [result] = await db.execute(
        `UPDATE support_access_sessions SET ended_at = UTC_TIMESTAMP()
         WHERE id = ? AND actor_id = ? AND ended_at IS NULL`,
        [req.auth.supportSessionId, req.auth.sub],
      );
      if (!result.affectedRows) return responseError(res, 404, 'SUPPORT_SESSION_NOT_FOUND', 'Active support session not found');
      await db.execute(
        `INSERT INTO support_access_events
         (session_id, organization_id, property_id, actor_id, method, path)
         VALUES (?, ?, ?, ?, 'POST', '/api/platform/support/exit')`,
        [req.auth.supportSessionId, req.auth.orgId, req.auth.activePropertyId, req.auth.sub],
      );
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.get('/data-export', authenticate(db), propertyScope(db), requirePermission(db, 'users.manage'), async (req, res, next) => {
    if (req.auth.supportSessionId) return responseError(res, 403, 'SUPPORT_READ_ONLY', 'Support access cannot export customer data');
    try {
      const result = await exportOrganizationData(db, req.auth.orgId);
      await auditable(db, {
        organizationId: req.auth.orgId,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        action: 'organization.data_exported',
        entity: 'organization',
        entityId: req.auth.orgId,
        after: { format: req.query.format === 'csv' ? 'csv' : 'json' },
        ip: req.ip,
      });
      if (req.query.format === 'csv') {
        const csvRows = ['table,row_json'];
        for (const [tableName, rows] of Object.entries(result.data)) {
          for (const row of rows) {
            csvRows.push([tableName, JSON.stringify(row)].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','));
          }
        }
        res.type('text/csv').attachment(`smarthotel-export-${result.organizationId}.csv`);
        return res.send(csvRows.join('\r\n'));
      }
      res.type('application/json').attachment(`smarthotel-export-${result.organizationId}.json`);
      return res.send(JSON.stringify(result));
    } catch (error) {
      return next(error);
    }
  });

  router.use((error, _req, res, next) => {
    if (Number.isInteger(error?.status)) {
      return res.status(error.status).json({
        error: { code: error.code ?? 'REQUEST_FAILED', message: error.message },
      });
    }
    return next(error);
  });
  return router;
}

async function countRooms(db, organizationId) {
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS total FROM rooms r JOIN properties p ON p.id = r.property_id
     WHERE p.organization_id = ? AND r.is_active = 1 AND r.deleted_at IS NULL`,
    [organizationId],
  );
  return Number(rows[0].total);
}

async function countUsers(db, organizationId) {
  const [rows] = await db.execute(
    'SELECT COUNT(*) AS total FROM users WHERE organization_id = ? AND is_active = 1',
    [organizationId],
  );
  return Number(rows[0].total);
}
