import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { getRolePermissions } from './permissions.js';
import { requireEnabledModule } from '../platform/plans.js';

function forbidden(res, message = 'You do not have access to this resource') {
  return res.status(403).json({ error: { code: 'FORBIDDEN', message } });
}

export function authenticate(db) {
  return async (req, res, next) => {
    const authorization = req.get('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue' } });
    }

    try {
      const claims = jwt.verify(authorization.slice(7), env.JWT_ACCESS_SECRET);
      const [users] = await db.execute(
        `SELECT u.id, u.organization_id, u.role_id, u.is_active, r.name AS role_name,
                o.status AS organization_status, o.subscription_status
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN organizations o ON o.id = u.organization_id
         WHERE u.id = ? LIMIT 1`,
        [claims.sub],
      );
      const user = users[0];
      if (!user || !user.is_active) {
        return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Session is no longer valid' } });
      }
      const requestPath = req.originalUrl.split('?')[0];
      const suspensionException = (req.method === 'GET'
        && ['/api/auth/me', '/api/platform/data-export'].includes(requestPath))
        || (req.method === 'POST' && requestPath === '/api/platform/support/exit');
      if (user.organization_id !== null && user.organization_status !== 'active' && !suspensionException) {
        return res.status(403).json({ error: { code: 'ORGANIZATION_UNAVAILABLE', message: 'This organization is suspended; customer data export remains available' } });
      }
      if (user.subscription_status === 'cancelled' && !suspensionException) {
        return res.status(403).json({ error: { code: 'SUBSCRIPTION_CANCELLED', message: 'This subscription is cancelled; customer data export remains available' } });
      }
      let organizationId = user.organization_id === null ? null : Number(user.organization_id);
      let roleId = Number(user.role_id);
      let propertyIds = Array.isArray(claims.propertyIds) ? claims.propertyIds.map(Number) : [];
      let activePropertyId = claims.activePropertyId ? Number(claims.activePropertyId) : null;
      if (claims.supportSessionId) {
        if (user.role_name !== 'super_admin') {
          return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Support session actor is invalid' } });
        }
        const [sessions] = await db.execute(
          `SELECT s.organization_id, s.property_id, r.id AS support_role_id
           FROM support_access_sessions s
           JOIN support_access_requests request ON request.id = s.request_id AND request.status IN ('approved', 'started')
           JOIN roles r ON r.id = ? AND r.organization_id = s.organization_id
           WHERE s.id = ? AND s.actor_id = ? AND s.ended_at IS NULL
             AND s.expires_at > UTC_TIMESTAMP() AND request.expires_at > UTC_TIMESTAMP()
           LIMIT 1`,
          [claims.supportRoleId, claims.supportSessionId, user.id],
        );
        const supportSession = sessions[0];
        if (!supportSession || Number(supportSession.property_id) !== Number(claims.activePropertyId)) {
          return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Support session is invalid or expired' } });
        }
        organizationId = Number(supportSession.organization_id);
        roleId = Number(supportSession.support_role_id);
        propertyIds = [Number(supportSession.property_id)];
        activePropertyId = Number(supportSession.property_id);
      } else if (Number(user.organization_id ?? 0) !== Number(claims.orgId ?? 0)) {
        return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Session is no longer valid' } });
      }
      req.auth = {
        sub: Number(user.id),
        orgId: organizationId,
        roleId,
        role: claims.supportSessionId ? 'support' : claims.role,
        propertyIds,
        activePropertyId,
        ...(claims.supportSessionId ? { supportSessionId: Number(claims.supportSessionId) } : {}),
      };
      return next();
    } catch (error) {
      if (error?.name === 'JsonWebTokenError' || error?.name === 'TokenExpiredError') {
        return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Session is invalid or expired' } });
      }
      return next(error);
    }
  };
}

export function requirePermission(db, permissionKey) {
  return requireAnyPermission(db, [permissionKey]);
}

export function requireAnyPermission(db, permissionKeys) {
  return async (req, res, next) => {
    try {
      const permissions = await getRolePermissions(db, req.auth.roleId);
      if (!permissionKeys.some((permissionKey) => permissions.includes(permissionKey))) return forbidden(res);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export function propertyScope(db) {
  return async (req, res, next) => {
    const propertyId = req.auth?.activePropertyId;
    if (!propertyId) return forbidden(res, 'Select an assigned property to continue');

    try {
      if (req.auth?.supportSessionId) {
        const [rows] = await db.execute(
          `SELECT p.id
           FROM support_access_sessions s
           JOIN properties p ON p.id = s.property_id AND p.organization_id = s.organization_id
           JOIN support_access_requests r ON r.id = s.request_id AND r.status IN ('approved', 'started')
           WHERE s.id = ? AND s.actor_id = ? AND s.organization_id = ?
             AND s.property_id = ? AND s.ended_at IS NULL
             AND s.expires_at > UTC_TIMESTAMP() AND r.expires_at > UTC_TIMESTAMP()
             AND p.is_active = 1 LIMIT 1`,
          [req.auth.supportSessionId, req.auth.sub, req.auth.orgId, propertyId],
        );
        if (!rows.length) return forbidden(res, 'The approved support session is no longer active');
        req.propertyId = Number(rows[0].id);
        await db.execute(
          `INSERT INTO support_access_events
           (session_id, organization_id, property_id, actor_id, method, path)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            req.auth.supportSessionId,
            req.auth.orgId,
            req.propertyId,
            req.auth.sub,
            req.method,
            `${req.baseUrl}${req.path}`.slice(0, 500),
          ],
        );
        return next();
      }
      const [rows] = await db.execute(
        `SELECT p.id
         FROM user_properties up
         JOIN properties p ON p.id = up.property_id
         WHERE up.user_id = ? AND up.property_id = ?
           AND p.organization_id = ? AND p.is_active = 1
         LIMIT 1`,
        [req.auth.sub, propertyId, req.auth.orgId],
      );
      if (!rows.length) return forbidden(res, 'The selected property is not assigned to your account');
      req.propertyId = Number(rows[0].id);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export function requireModule(db, moduleKey) {
  return async (req, res, next) => {
    if (req.auth.orgId === null) return forbidden(res);
    try {
      if (!(await requireEnabledModule(db, req.auth.orgId, moduleKey, res))) return;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
