import { getLicenseState } from './licensing.js';
import { env } from '../config/env.js';

function planError(code, message) {
  return Object.assign(new Error(message), { status: 409, code });
}

export async function getOrganizationPlan(db, organizationId) {
  if (organizationId === null || organizationId === undefined) {
    return { modules: [], maxRooms: 0, maxUsers: 0, licenseStatus: null, warning: null };
  }
  const [rows] = await db.execute(
    `SELECT o.licence_mode, o.status, o.subscription_status,
            p.max_rooms AS package_max_rooms, p.max_users AS package_max_users, p.modules
     FROM organizations o LEFT JOIN packages p ON p.id = o.package_id
     WHERE o.id = ? LIMIT 1`,
    [organizationId],
  );
  const organization = rows[0];
  if (!organization) {
    return { modules: [], maxRooms: 0, maxUsers: 0, licenseStatus: null, warning: null };
  }
  if (organization.status !== 'active') {
    return {
      modules: [],
      maxRooms: 0,
      maxUsers: 0,
      licenseStatus: 'suspended',
      warning: 'Organization is suspended; customer data export remains available',
    };
  }
  if (organization.subscription_status === 'cancelled') {
    return {
      modules: [],
      maxRooms: Number(organization.package_max_rooms ?? 0),
      maxUsers: Number(organization.package_max_users ?? 0),
      licenseStatus: 'cancelled',
      warning: 'Subscription is cancelled; contact your account manager to restore access',
    };
  }
  if (organization.licence_mode === 'local') {
    const state = getLicenseState(organizationId);
    if (!state && env.NODE_ENV !== 'production') {
      const modules = typeof organization.modules === 'string'
        ? JSON.parse(organization.modules)
        : organization.modules;
      return {
        modules: Array.isArray(modules) ? modules : [],
        maxRooms: Number(organization.package_max_rooms ?? 0),
        maxUsers: Number(organization.package_max_users ?? 0),
        licenseStatus: 'development_unconfigured',
        warning: 'Local licensing is not configured in this development environment',
      };
    }
    if (!state || !['active', 'grace'].includes(state.status)) {
      return {
        modules: [],
        maxRooms: 0,
        maxUsers: 0,
        licenseStatus: state?.status ?? 'invalid',
        warning: state?.warning ?? 'A valid local license is required',
      };
    }
    return {
      modules: state.payload.modules,
      maxRooms: state.payload.maxRooms,
      maxUsers: state.payload.maxUsers,
      licenseStatus: state.status,
      warning: state.warning,
    };
  }
  const modules = typeof organization.modules === 'string'
    ? JSON.parse(organization.modules)
    : organization.modules;
  return {
    modules: Array.isArray(modules) ? modules : [],
    maxRooms: Number(organization.package_max_rooms ?? 0),
    maxUsers: Number(organization.package_max_users ?? 0),
    licenseStatus: organization.subscription_status,
    warning: organization.subscription_status === 'past_due'
      ? 'Subscription is past due; contact your account manager'
      : null,
  };
}

export async function assertPlanCapacity(connection, organizationId, resource, increment = 1) {
  const [organizations] = await connection.execute(
    `SELECT o.licence_mode, o.status, p.max_rooms, p.max_users
     FROM organizations o LEFT JOIN packages p ON p.id = o.package_id
     WHERE o.id = ? LIMIT 1 FOR UPDATE`,
    [organizationId],
  );
  const organization = organizations[0];
  if (!organization || organization.status !== 'active') {
    throw planError('ORGANIZATION_UNAVAILABLE', 'The organization is not active');
  }
  const plan = await getOrganizationPlan(connection, organizationId);
  const limit = resource === 'rooms' ? plan.maxRooms : plan.maxUsers;
  const code = resource === 'rooms' ? 'PLAN_LIMIT_ROOMS' : 'PLAN_LIMIT_USERS';
  const message = resource === 'rooms'
    ? 'The organization has reached its room limit'
    : 'The organization has reached its user limit';
  if (resource !== 'rooms' && resource !== 'users') throw new Error(`Unknown plan resource: ${resource}`);
  const [rows] = await connection.execute(
    resource === 'rooms'
      ? `SELECT COUNT(*) AS total FROM rooms r
         JOIN properties p ON p.id = r.property_id
         WHERE p.organization_id = ? AND r.is_active = 1 AND r.deleted_at IS NULL`
      : 'SELECT COUNT(*) AS total FROM users WHERE organization_id = ? AND is_active = 1',
    [organizationId],
  );
  if (Number(rows[0].total) + increment > limit) {
    throw planError(code, `${message} (${limit})`);
  }
}

export async function requireEnabledModule(db, organizationId, moduleKey, res) {
  const plan = await getOrganizationPlan(db, organizationId);
  if (!plan.modules.includes(moduleKey)) {
    res.status(403).json({
      error: {
        code: 'MODULE_DISABLED',
        message: plan.warning
          ? `${moduleKey} is not enabled for this organization. ${plan.warning}`
          : `${moduleKey} is not enabled for this organization`,
      },
    });
    return false;
  }
  return true;
}
