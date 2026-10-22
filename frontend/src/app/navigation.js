import { en } from '../i18n/en.js';

export const navigation = [
  ['/', en.overview, '⌂', null],
  ['/front-desk', en.frontDesk, '▤', 'checkin.perform', 'reservations'],
  ['/reservations', en.reservations, '▦', 'reservations.view', 'reservations'],
  ['/rooms', en.rooms, '▣', 'rooms.manage', 'reservations'],
  ['/housekeeping', en.housekeeping, '✳', 'housekeeping.view', 'housekeeping'],
  ['/maintenance', en.maintenance, '⌁', 'maintenance.manage', 'maintenance'],
  ['/staff', en.staff, '♟', ['staff.manage', 'staff.self_service'], 'staff'],
  ['/operations', en.operations, '▧', ['expenses.manage', 'inventory.manage', 'services.manage'], 'inventory'],
  ['/automation', en.automation, '◷', 'automation.manage'],
  ['/guests', en.guestManagement, '♙', 'guests.view', 'reservations'],
  ['/finance', en.finance, '◈', 'folio.view'],
  ['/reports', en.reports, '▥', 'reports.view', 'reports'],
  ['/setup', 'Property setup', '⚙', 'property.manage'],
  ['/admin/users', 'Users', '♙', 'users.manage'],
  ['/admin/roles', 'Roles', '⚙', 'roles.manage'],
  ['/admin/data-export', 'Data export', '⇩', 'users.manage'],
  ['/admin/support', 'Support approvals', '◷', 'users.manage'],
  ['/platform', 'Platform console', '⌂', 'super_admin.manage'],
];

export function getVisibleNavigation(permissionKeys, modules, isSuperAdmin = false) {
  const granted = new Set(permissionKeys);
  const enabledModules = new Set(modules ?? []);
  return navigation.filter(([, , , permission, moduleKey]) => (!permission
    || (Array.isArray(permission) ? permission.some((key) => granted.has(key)) : granted.has(permission)))
    && (!moduleKey || isSuperAdmin || enabledModules.has(moduleKey)));
}
