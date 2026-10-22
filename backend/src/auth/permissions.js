export const permissionKeys = [
  'reservations.view',
  'reservations.create',
  'reservations.edit',
  'reservations.cancel',
  'checkin.perform',
  'checkout.perform',
  'stays.shorten',
  'stays.rate_change_approve',
  'guests.view',
  'guests.manage',
  'guest.view_id',
  'guest_requests.manage',
  'folio.view',
  'folio.post_charge',
  'folio.take_payment',
  'folio.adjust',
  'folio.approve_credit',
  'refund.approve',
  'cashier.shift.manage',
  'night_audit.run',
  'rates.view',
  'rates.edit',
  'rates.override_past',
  'rooms.manage',
  'housekeeping.view',
  'housekeeping.assign',
  'housekeeping.inspect',
  'housekeeping.work',
  'housekeeping.checklist.manage',
  'housekeeping.skip_inspection',
  'maintenance.manage',
  'staff.manage',
  'staff.self_service',
  'reports.view',
  'reports.view_financial',
  'users.manage',
  'roles.manage',
  'audit.view',
  'property.manage',
  'expenses.manage',
  'inventory.manage',
  'services.manage',
  'automation.manage',
  'super_admin.manage',
];

export const rolePermissionMatrix = {
  owner_gm: permissionKeys.filter((key) => key !== 'super_admin.manage'),
  front_desk: [
    'reservations.view',
    'reservations.create',
    'reservations.edit',
    'rates.view',
    'checkin.perform',
    'checkout.perform',
    'guests.view',
    'guests.manage',
    'guest_requests.manage',
    'housekeeping.view',
    'staff.self_service',
    'folio.view',
    'folio.take_payment',
    'cashier.shift.manage',
    'rooms.manage',
    'reports.view',
  ],
  cashier_accountant: [
    'reservations.view',
    'guests.view',
    'guest_requests.manage',
    'folio.view',
    'folio.post_charge',
    'folio.take_payment',
    'folio.adjust',
    'refund.approve',
    'cashier.shift.manage',
    'night_audit.run',
    'reports.view',
    'reports.view_financial',
    'expenses.manage',
    'inventory.manage',
    'staff.self_service',
  ],
  housekeeping_supervisor: [
    'housekeeping.view',
    'housekeeping.assign',
    'housekeeping.inspect',
    'housekeeping.work',
    'housekeeping.checklist.manage',
    'rooms.manage',
    'reports.view',
    'staff.self_service',
  ],
  housekeeping_staff: ['housekeeping.view', 'housekeeping.work', 'staff.self_service'],
  maintenance_staff: ['maintenance.manage', 'rooms.manage', 'staff.self_service'],
  hr_manager: ['staff.manage', 'staff.self_service', 'reports.view'],
  system_admin: permissionKeys.filter((key) => key !== 'super_admin.manage'),
  auditor: [
    'reservations.view',
    'guests.view',
    'folio.view',
    'reports.view',
    'reports.view_financial',
    'audit.view',
  ],
  super_admin: permissionKeys.filter((key) => key !== 'staff.self_service'),
};

const permissionCache = new Map();

export function clearPermissionCache(roleId) {
  if (roleId === undefined) permissionCache.clear();
  else permissionCache.delete(Number(roleId));
}

export async function getRolePermissions(db, roleId) {
  const id = Number(roleId);
  const cached = permissionCache.get(id);
  if (!cached || cached.expiresAt <= Date.now()) {
    const [rows] = await db.execute(
      'SELECT permission_key FROM role_permissions WHERE role_id = ?',
      [id],
    );
    permissionCache.set(id, {
      permissions: rows.map((row) => row.permission_key),
      expiresAt: Date.now() + 30_000,
    });
  }
  return permissionCache.get(id).permissions;
}
