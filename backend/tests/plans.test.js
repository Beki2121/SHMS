import { describe, expect, it, vi } from 'vitest';
import { getOrganizationPlan, assertPlanCapacity, requireEnabledModule } from '../src/platform/plans.js';

function mockDb(organization, total = 0) {
  return {
    execute: vi.fn(async (query) => {
      if (query.includes('SELECT o.licence_mode')) return [[organization]];
      if (query.includes('SELECT COUNT(*)')) return [[{ total }]];
      return [[organization]];
    }),
  };
}

const activeOrganization = {
  licence_mode: 'cloud',
  status: 'active',
  subscription_status: 'active',
  package_max_rooms: 30,
  package_max_users: 15,
  modules: '["reservations","reports"]',
};

describe('organization plan enforcement', () => {
  it('returns enabled package modules and limits', async () => {
    const plan = await getOrganizationPlan(mockDb(activeOrganization), 7);
    expect(plan).toMatchObject({
      modules: ['reservations', 'reports'],
      maxRooms: 30,
      maxUsers: 15,
      licenseStatus: 'active',
    });
  });

  it('disables package modules for cancelled or suspended organizations', async () => {
    const cancelled = await getOrganizationPlan(mockDb({
      ...activeOrganization,
      subscription_status: 'cancelled',
    }), 7);
    expect(cancelled).toMatchObject({ modules: [], licenseStatus: 'cancelled' });

    const suspended = await getOrganizationPlan(mockDb({
      ...activeOrganization,
      status: 'suspended',
    }), 7);
    expect(suspended).toMatchObject({ modules: [], maxRooms: 0, maxUsers: 0 });
  });

  it('rejects room additions that exceed the organization limit', async () => {
    const connection = mockDb(activeOrganization, 30);
    await expect(assertPlanCapacity(connection, 7, 'rooms')).rejects.toMatchObject({
      status: 409,
      code: 'PLAN_LIMIT_ROOMS',
    });
  });

  it('blocks a disabled module with an explicit API error', async () => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await expect(requireEnabledModule(mockDb(activeOrganization), 7, 'maintenance', response)).resolves.toBe(false);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'MODULE_DISABLED' }),
    }));
  });
});
