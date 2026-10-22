import { randomBytes, createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { authenticate, propertyScope, requirePermission } from './middleware.js';
import { clearPermissionCache, getRolePermissions, permissionKeys } from './permissions.js';
import { auditable, inAuditedTransaction } from './audit.js';
import { getOrganizationPlan, assertPlanCapacity } from '../platform/plans.js';

const accessTokenLifetimeSeconds = 15 * 60;
const refreshTokenLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const passwordSchema = z.string().min(12).max(128);
const loginSchema = z.object({
  email: z.string().email().max(190),
  password: z.string().min(1).max(128),
});
const refreshSchema = z.object({ refreshToken: z.string().min(32).optional() });
const switchPropertySchema = z.object({ propertyId: z.coerce.number().int().positive() });
const userSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(190),
  phone: z.string().trim().max(40).optional().nullable(),
  password: passwordSchema,
  roleId: z.coerce.number().int().positive(),
  propertyIds: z.array(z.coerce.number().int().positive()).min(1),
});
const rolePermissionsSchema = z.object({
  permissionKeys: z.array(z.string()).max(permissionKeys.length),
});
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
const resetPasswordSchema = z.object({ password: passwordSchema });

function cookieValue(req, name) {
  const cookieHeader = req.get('cookie') ?? '';
  const entry = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!entry) return null;
  try {
    return decodeURIComponent(entry.slice(name.length + 1));
  } catch {
    return null;
  }
}

function refreshTokenFrom(req) {
  const parsed = refreshSchema.safeParse(req.body ?? {});
  return parsed.success ? parsed.data.refreshToken ?? cookieValue(req, 'smarthotel_refresh') : null;
}

function setRefreshCookie(res, token) {
  const options = [
    'HttpOnly',
    'SameSite=Strict',
    'Path=/api/auth',
    `Max-Age=${Math.floor(refreshTokenLifetimeMs / 1000)}`,
  ];
  if (env.NODE_ENV === 'production') options.push('Secure');
  res.setHeader('Set-Cookie', `smarthotel_refresh=${encodeURIComponent(token)}; ${options.join('; ')}`);
}

function clearRefreshCookie(res) {
  const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `smarthotel_refresh=; HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=0${secure}`);
}

function hashRefreshToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function issueAccessToken(user, propertyIds, activePropertyId) {
  return jwt.sign(
    {
      orgId: user.organization_id === null ? null : Number(user.organization_id),
      role: user.role_name,
      propertyIds,
      activePropertyId,
    },
    env.JWT_ACCESS_SECRET,
    { subject: String(user.id), expiresIn: accessTokenLifetimeSeconds },
  );
}

async function loadSessionData(db, userId) {
  const [rows] = await db.execute(
    `SELECT u.id, u.organization_id, u.name, u.email, u.phone, u.role_id, u.is_active,
            r.name AS role_name
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = ? LIMIT 1`,
    [userId],
  );
  const user = rows[0];
  if (!user || !user.is_active) return null;
  const [properties] = await db.execute(
    `SELECT p.id, p.name, p.city
     FROM user_properties up
     JOIN properties p ON p.id = up.property_id
     WHERE up.user_id = ? AND p.organization_id = ? AND p.is_active = 1
     ORDER BY p.id`,
    [userId, user.organization_id],
  );
  const permissionKeysForUser = await getRolePermissions(db, user.role_id);
  const plan = await getOrganizationPlan(db, user.organization_id);
  return { user, properties, permissionKeys: permissionKeysForUser, plan };
}

function publicUser(user) {
  return {
    id: Number(user.id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role_name,
    organizationId: user.organization_id === null ? null : Number(user.organization_id),
  };
}

function validationError(res, issues) {
  return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: issues } });
}

function unknownCredentials(res) {
  return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' } });
}

function isDuplicateError(error) {
  return error?.code === 'ER_DUP_ENTRY';
}

export function createAuthRouter(db) {
  const router = Router();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.post('/login', loginLimiter, async (req, res, next) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    let connection;
    try {
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT u.id, u.organization_id, u.name, u.email, u.phone, u.password_hash,
                u.role_id, u.is_active, u.failed_login_attempts, u.locked_until,
                r.name AS role_name
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
         WHERE u.email = ? LIMIT 1 FOR UPDATE`,
        [parsed.data.email.trim().toLowerCase()],
      );
      const user = rows[0];
      if (!user || !user.is_active || !user.role_name) {
        await connection.rollback();
        return unknownCredentials(res);
      }
      if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
        await connection.rollback();
        return res.status(423).json({ error: { code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again later.' } });
      }
      const valid = await bcrypt.compare(parsed.data.password, user.password_hash);
      if (!valid) {
        const attempts = Number(user.failed_login_attempts) + 1;
        const lockUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
        await connection.execute(
          `UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?`,
          [attempts, lockUntil, user.id],
        );
        await connection.commit();
        return unknownCredentials(res);
      }

      await connection.execute(
        `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [user.id],
      );
      const [propertyRows] = await connection.execute(
        `SELECT p.id, p.name, p.city
         FROM user_properties up
         JOIN properties p ON p.id = up.property_id
         WHERE up.user_id = ? AND p.organization_id = ? AND p.is_active = 1
         ORDER BY p.id`,
        [user.id, user.organization_id],
      );
      await connection.commit();

      const properties = propertyRows.map((property) => ({ ...property, id: Number(property.id) }));
      const activePropertyId = properties[0]?.id ?? null;
      const loginPermissions = await getRolePermissions(db, user.role_id);
      const plan = await getOrganizationPlan(db, user.organization_id);
      const refreshToken = randomBytes(48).toString('hex');
      const familyId = randomUUID();
      await db.execute(
        `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
         VALUES (?, ?, ?, ?)`,
        [user.id, hashRefreshToken(refreshToken), familyId, new Date(Date.now() + refreshTokenLifetimeMs)],
      );
      setRefreshCookie(res, refreshToken);
      return res.json({
        data: {
          accessToken: issueAccessToken(user, properties.map((property) => property.id), activePropertyId),
          tokenType: 'Bearer',
          expiresIn: accessTokenLifetimeSeconds,
          user: publicUser(user),
          properties,
          activePropertyId,
          permissionKeys: loginPermissions,
          modules: plan.modules,
          licenseStatus: plan.licenseStatus,
          licenseWarning: plan.warning,
        },
      });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/refresh', async (req, res, next) => {
    const token = refreshTokenFrom(req);
    if (!token) return unknownCredentials(res);
    let connection;
    try {
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT id, user_id, family_id, expires_at, revoked_at
         FROM refresh_tokens WHERE token_hash = ? LIMIT 1 FOR UPDATE`,
        [hashRefreshToken(token)],
      );
      const stored = rows[0];
      if (!stored) {
        await connection.rollback();
        clearRefreshCookie(res);
        return unknownCredentials(res);
      }
      if (stored.revoked_at) {
        await connection.execute(
          `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP())
           WHERE family_id = ?`,
          [stored.family_id],
        );
        await connection.commit();
        clearRefreshCookie(res);
        return res.status(401).json({ error: { code: 'REFRESH_REUSE_DETECTED', message: 'Session refresh token reuse detected; sign in again' } });
      }
      if (new Date(stored.expires_at).getTime() <= Date.now()) {
        await connection.rollback();
        clearRefreshCookie(res);
        return unknownCredentials(res);
      }

      const session = await loadSessionData(connection, stored.user_id);
      if (!session) {
        await connection.execute(
          `UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE family_id = ?`,
          [stored.family_id],
        );
        await connection.commit();
        clearRefreshCookie(res);
        return unknownCredentials(res);
      }

      const nextToken = randomBytes(48).toString('hex');
      const [insertResult] = await connection.execute(
        `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
         VALUES (?, ?, ?, ?)`,
        [stored.user_id, hashRefreshToken(nextToken), stored.family_id, new Date(Date.now() + refreshTokenLifetimeMs)],
      );
      await connection.execute(
        `UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(), replaced_by_id = ? WHERE id = ?`,
        [insertResult.insertId, stored.id],
      );
      await connection.commit();

      const properties = session.properties.map((property) => ({ ...property, id: Number(property.id) }));
      const activePropertyId = properties.some((property) => property.id === Number(req.body?.activePropertyId))
        ? Number(req.body.activePropertyId)
        : properties[0]?.id ?? null;
      setRefreshCookie(res, nextToken);
      return res.json({
        data: {
          accessToken: issueAccessToken(session.user, properties.map((property) => property.id), activePropertyId),
          tokenType: 'Bearer',
          expiresIn: accessTokenLifetimeSeconds,
          user: publicUser(session.user),
          properties,
          activePropertyId,
          permissionKeys: session.permissionKeys,
          modules: session.plan.modules,
          licenseStatus: session.plan.licenseStatus,
          licenseWarning: session.plan.warning,
        },
      });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/logout', async (req, res, next) => {
    const token = refreshTokenFrom(req);
    try {
      if (token) {
        await db.execute(
          `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP())
           WHERE token_hash = ?`,
          [hashRefreshToken(token)],
        );
      }
      clearRefreshCookie(res);
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.get('/me', authenticate(db), async (req, res, next) => {
    try {
      const session = await loadSessionData(db, req.auth.sub);
      if (!session) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Session is no longer valid' } });
      return res.json({
        data: {
          user: publicUser(session.user),
          role: { id: Number(session.user.role_id), name: session.user.role_name },
          permissionKeys: session.permissionKeys,
          modules: session.plan.modules,
          licenseStatus: session.plan.licenseStatus,
          licenseWarning: session.plan.warning,
          properties: session.properties.map((property) => ({ ...property, id: Number(property.id) })),
          activePropertyId: req.auth.activePropertyId,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/switch-property', authenticate(db), async (req, res, next) => {
    const parsed = switchPropertySchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    try {
      const [rows] = await db.execute(
        `SELECT p.id
         FROM user_properties up
         JOIN properties p ON p.id = up.property_id
         WHERE up.user_id = ? AND up.property_id = ?
           AND p.organization_id = ? AND p.is_active = 1 LIMIT 1`,
        [req.auth.sub, parsed.data.propertyId, req.auth.orgId],
      );
      if (!rows.length) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'The selected property is not assigned to your account' } });
      const session = await loadSessionData(db, req.auth.sub);
      const properties = session.properties.map((property) => Number(property.id));
      return res.json({
        data: {
          accessToken: issueAccessToken(session.user, properties, parsed.data.propertyId),
          activePropertyId: parsed.data.propertyId,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/change-password', authenticate(db), async (req, res, next) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    let connection;
    try {
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT id, password_hash FROM users WHERE id = ? FOR UPDATE',
        [req.auth.sub],
      );
      const user = rows[0];
      if (!user || !(await bcrypt.compare(parsed.data.currentPassword, user.password_hash))) {
        await connection.rollback();
        return res.status(400).json({ error: { code: 'CURRENT_PASSWORD_INVALID', message: 'Current password is incorrect' } });
      }
      const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
      await connection.execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, user.id]);
      await connection.execute(
        'UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP()) WHERE user_id = ?',
        [user.id],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId,
        propertyId: req.auth.activePropertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'password.changed',
        entity: 'user',
        entityId: user.id,
        before: { passwordChanged: false },
        after: { passwordChanged: true },
      });
      await connection.commit();
      return res.status(204).end();
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/admin/users/:id/password', authenticate(db), propertyScope(db), requirePermission(db, 'users.manage'), async (req, res, next) => {
    const parsed = resetPasswordSchema.safeParse(req.body);
    const targetId = Number(req.params.id);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    if (!Number.isInteger(targetId) || targetId < 1) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'User id is invalid' } });
    try {
      await inAuditedTransaction(db, req, (target) => ({
        action: 'user.password_reset',
        entity: 'user',
        entityId: target.id,
        before: { passwordReset: false },
        after: { passwordReset: true },
      }), async (connection) => {
        const [rows] = await connection.execute(
          `SELECT u.id FROM users u
           JOIN user_properties up ON up.user_id = u.id AND up.property_id = ?
           WHERE u.id = ? AND u.organization_id = ? FOR UPDATE`,
          [req.propertyId, targetId, req.auth.orgId],
        );
        if (!rows.length) {
          const error = new Error('User not found in the selected property');
          error.status = 404;
          error.code = 'USER_NOT_FOUND';
          throw error;
        }
        const passwordHash = await bcrypt.hash(parsed.data.password, 12);
        await connection.execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, targetId]);
        await connection.execute(
          'UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP()) WHERE user_id = ?',
          [targetId],
        );
        return { id: targetId };
      });
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.get('/admin/users', authenticate(db), propertyScope(db), requirePermission(db, 'users.manage'), async (req, res, next) => {
    try {
      const [users] = await db.execute(
        `SELECT u.id, u.name, u.email, u.phone, u.is_active, r.name AS role_name
         FROM users u
         JOIN user_properties up ON up.user_id = u.id AND up.property_id = ?
         JOIN roles r ON r.id = u.role_id
         WHERE u.organization_id = ?
         ORDER BY u.name`,
        [req.propertyId, req.auth.orgId],
      );
      return res.json({ data: users.map((user) => ({ ...user, id: Number(user.id), isActive: Boolean(user.is_active), role: user.role_name })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/admin/users', authenticate(db), propertyScope(db), requirePermission(db, 'users.manage'), async (req, res, next) => {
    const parsed = userSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    const propertyIds = [...new Set(parsed.data.propertyIds)];
    if (!propertyIds.includes(req.propertyId) || propertyIds.some((id) => !req.auth.propertyIds.includes(id))) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Users can only be assigned to properties available to the current user' } });
    }
    try {
      const created = await inAuditedTransaction(db, req, (result) => ({
        action: 'user.created',
        entity: 'user',
        entityId: result.id,
        before: null,
        after: { name: parsed.data.name, email: parsed.data.email, roleId: parsed.data.roleId, propertyIds },
      }), async (connection) => {
        await assertPlanCapacity(connection, req.auth.orgId, 'users');
        const [roleRows] = await connection.execute(
          'SELECT id FROM roles WHERE id = ? AND organization_id = ? LIMIT 1',
          [parsed.data.roleId, req.auth.orgId],
        );
        if (!roleRows.length) {
          const error = new Error('Role does not belong to the current organization');
          error.status = 400;
          error.code = 'INVALID_ROLE';
          throw error;
        }
        const [propertyRows] = await connection.execute(
          `SELECT id FROM properties
           WHERE organization_id = ? AND is_active = 1 AND id IN (${propertyIds.map(() => '?').join(',')})`,
          [req.auth.orgId, ...propertyIds],
        );
        if (propertyRows.length !== propertyIds.length) {
          const error = new Error('One or more properties are not available to this organization');
          error.status = 400;
          error.code = 'INVALID_PROPERTY_ASSIGNMENT';
          throw error;
        }
        const [insert] = await connection.execute(
          `INSERT INTO users (organization_id, name, email, phone, password_hash, role_id, is_active)
           VALUES (?, ?, ?, ?, ?, ?, 1)`,
          [
            req.auth.orgId,
            parsed.data.name,
            parsed.data.email.toLowerCase(),
            parsed.data.phone ?? null,
            await bcrypt.hash(parsed.data.password, 12),
            parsed.data.roleId,
          ],
        );
        for (const propertyId of propertyIds) {
          await connection.execute(
            'INSERT INTO user_properties (user_id, property_id) VALUES (?, ?)',
            [insert.insertId, propertyId],
          );
        }
        return { id: insert.insertId };
      });
      return res.status(201).json({ data: { id: Number(created.id) } });
    } catch (error) {
      if (isDuplicateError(error)) return res.status(409).json({ error: { code: 'EMAIL_EXISTS', message: 'An account with that email already exists' } });
      return next(error);
    }
  });

  router.get('/admin/roles', authenticate(db), propertyScope(db), requirePermission(db, 'roles.manage'), async (req, res, next) => {
    try {
      const [roles] = await db.execute(
        'SELECT id, name, is_system FROM roles WHERE organization_id = ? ORDER BY name',
        [req.auth.orgId],
      );
      const data = [];
      for (const role of roles) {
        const [permissions] = await db.execute(
          'SELECT permission_key FROM role_permissions WHERE role_id = ? ORDER BY permission_key',
          [role.id],
        );
        data.push({
          id: Number(role.id),
          name: role.name,
          isSystem: Boolean(role.is_system),
          permissionKeys: permissions.map((permission) => permission.permission_key),
        });
      }
      return res.json({
        data: {
          roles: data,
          permissionKeys: permissionKeys.filter((key) => key !== 'super_admin.manage'),
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/admin/assignable-roles', authenticate(db), propertyScope(db), requirePermission(db, 'users.manage'), async (req, res, next) => {
    try {
      const [roles] = await db.execute(
        'SELECT id, name FROM roles WHERE organization_id = ? ORDER BY name',
        [req.auth.orgId],
      );
      return res.json({ data: roles.map((role) => ({ id: Number(role.id), name: role.name })) });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/admin/roles/:id/permissions', authenticate(db), propertyScope(db), requirePermission(db, 'roles.manage'), async (req, res, next) => {
    const parsed = rolePermissionsSchema.safeParse(req.body);
    const roleId = Number(req.params.id);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    if (!Number.isInteger(roleId) || roleId < 1) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Role id is invalid' } });
    const requested = [...new Set(parsed.data.permissionKeys)];
    if (requested.some((key) => !permissionKeys.includes(key) || key === 'super_admin.manage')) {
      return res.status(400).json({ error: { code: 'INVALID_PERMISSION', message: 'One or more permission keys are unknown' } });
    }
    try {
      await inAuditedTransaction(db, req, (result) => ({
        action: 'role.permissions_updated',
        entity: 'role',
        entityId: roleId,
        before: result.before,
        after: { permissionKeys: requested },
      }), async (connection) => {
        const [roles] = await connection.execute(
          'SELECT id FROM roles WHERE id = ? AND organization_id = ? FOR UPDATE',
          [roleId, req.auth.orgId],
        );
        if (!roles.length) {
          const error = new Error('Role not found in the current organization');
          error.status = 404;
          error.code = 'ROLE_NOT_FOUND';
          throw error;
        }
        const [currentRows] = await connection.execute(
          'SELECT permission_key FROM role_permissions WHERE role_id = ?',
          [roleId],
        );
        const before = { permissionKeys: currentRows.map((row) => row.permission_key).sort() };
        await connection.execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
        for (const permissionKey of requested) {
          await connection.execute(
            'INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)',
            [roleId, permissionKey],
          );
        }
        return { before };
      });
      clearPermissionCache(roleId);
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.use((error, _req, res, next) => {
    logger.error({ err: error }, 'Authentication or user-management request failed');
    if (res.headersSent) return next(error);
    const status = Number.isInteger(error.status) ? error.status : 500;
    return res.status(status).json({
      error: {
        code: error.code ?? 'INTERNAL_ERROR',
        message: status === 500 ? 'The request could not be completed' : error.message,
      },
    });
  });

  return router;
}
