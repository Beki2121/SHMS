import { describe, expect, it } from 'vitest';
import { rolePermissionMatrix } from '../../../backend/src/auth/permissions.js';
import { getVisibleNavigation } from './navigation.js';

describe('role-based navigation', () => {
  it('hides reservations-owned screens when the module is disabled', () => {
    const permissionKeys = rolePermissionMatrix.owner_gm;
    const visibleWithoutReservations = getVisibleNavigation(permissionKeys, []);
    expect(visibleWithoutReservations.some(([path]) => path === '/rooms')).toBe(false);
    expect(visibleWithoutReservations.some(([path]) => path === '/guests')).toBe(false);

    const visibleWithReservations = getVisibleNavigation(permissionKeys, ['reservations']);
    expect(visibleWithReservations.some(([path]) => path === '/rooms')).toBe(true);
    expect(visibleWithReservations.some(([path]) => path === '/guests')).toBe(true);
  });

  it('shows only modules granted to each seeded role', () => {
    for (const [role, permissionKeys] of Object.entries(rolePermissionMatrix)) {
      const visible = getVisibleNavigation(permissionKeys);
      expect(visible.some(([path]) => path === '/')).toBe(true);
      expect(
        visible.every(([, , , permission]) => !permission || (
          Array.isArray(permission)
            ? permission.some((key) => permissionKeys.includes(key))
            : permissionKeys.includes(permission)
        )),
        role,
      ).toBe(true);
      expect(visible.some(([path]) => path === '/admin/users')).toBe(permissionKeys.includes('users.manage'));
      expect(visible.some(([path]) => path === '/admin/roles')).toBe(permissionKeys.includes('roles.manage'));
    }
  });
});
