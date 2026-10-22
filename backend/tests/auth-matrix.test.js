import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';
import { clearPermissionCache, rolePermissionMatrix } from '../src/auth/permissions.js';

describe('authentication permission and property matrix', () => {
  const app = createApp();
  let roles;

  beforeAll(async () => {
    const [rows] = await pool.execute(
      `SELECT r.name AS role_name, u.id AS user_id, u.organization_id,
              MIN(up.property_id) AS property_id
       FROM roles r
       JOIN users u ON u.role_id = r.id
       LEFT JOIN user_properties up ON up.user_id = u.id
       WHERE u.email NOT LIKE 'auth-test-%'
       GROUP BY r.id, r.name, u.id, u.organization_id
       ORDER BY r.name`,
    );
    roles = rows;
    clearPermissionCache();
  });

  it('checks each seeded role against scoped user and role-management routes', async () => {
    expect(roles.map((row) => row.role_name).sort()).toEqual(Object.keys(rolePermissionMatrix).sort());

    for (const role of roles) {
      const assignedProperty = role.property_id === null ? null : Number(role.property_id);
      const propertyIds = assignedProperty ? [assignedProperty] : [];
      const token = jwt.sign(
        {
          orgId: role.organization_id === null ? null : Number(role.organization_id),
          role: role.role_name,
          propertyIds,
          activePropertyId: assignedProperty,
        },
        env.JWT_ACCESS_SECRET,
        { subject: String(role.user_id), expiresIn: '5m' },
      );
      const client = request(app);
      const assigned = Boolean(assignedProperty);

      const me = await client.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
      expect(me.status, `${role.role_name} / me`).toBe(200);

      const expectedUsers = assigned && rolePermissionMatrix[role.role_name].includes('users.manage') ? 200 : 403;
      const users = await client.get('/api/auth/admin/users')
        .set('Authorization', `Bearer ${token}`)
        .send({ propertyId: 2147483647 });
      expect(users.status, `${role.role_name} / users / own property`).toBe(expectedUsers);
      if (users.status === 200) {
        const listedUserIds = users.body.data.map((user) => user.id);
        if (listedUserIds.length) {
          const [membershipRows] = await pool.execute(
            `SELECT COUNT(DISTINCT user_id) AS count
             FROM user_properties
             WHERE property_id = ? AND user_id IN (${listedUserIds.map(() => '?').join(',')})`,
            [assignedProperty, ...listedUserIds],
          );
          expect(Number(membershipRows[0].count)).toBe(listedUserIds.length);
        }
      }

      const expectedRoles = assigned && rolePermissionMatrix[role.role_name].includes('roles.manage') ? 200 : 403;
      const roleList = await client.get('/api/auth/admin/roles').set('Authorization', `Bearer ${token}`);
      expect(roleList.status, `${role.role_name} / roles / own property`).toBe(expectedRoles);

      const expectedRoomRack = assigned && rolePermissionMatrix[role.role_name].includes('rooms.manage') ? 200 : 403;
      const rack = await client.get('/api/property/rooms?propertyId=2147483647')
        .set('Authorization', `Bearer ${token}`);
      expect(rack.status, `${role.role_name} / room rack / own property`).toBe(expectedRoomRack);
      if (rack.status === 200) {
        const ids = rack.body.data.map((room) => room.id);
        if (ids.length) {
          const [scopedRooms] = await pool.execute(
            `SELECT COUNT(*) AS count FROM rooms
             WHERE property_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
            [assignedProperty, ...ids],
          );
          expect(Number(scopedRooms[0].count)).toBe(ids.length);
        }
      }
      const expectedTypes = assigned && (
        rolePermissionMatrix[role.role_name].includes('rooms.manage')
        || rolePermissionMatrix[role.role_name].includes('rates.view')
      ) ? 200 : 403;
      const types = await client.get('/api/property/room-types')
        .set('Authorization', `Bearer ${token}`);
      expect(types.status, `${role.role_name} / room types / own property`).toBe(expectedTypes);

      const expectedProfile = assigned && rolePermissionMatrix[role.role_name].includes('property.manage') ? 200 : 403;
      const profile = await client.get('/api/property?propertyId=2147483647')
        .set('Authorization', `Bearer ${token}`);
      expect(profile.status, `${role.role_name} / property profile / own property`).toBe(expectedProfile);

      const expectedRatePlans = assigned && rolePermissionMatrix[role.role_name].includes('rates.view') ? 200 : 403;
      const ratePlans = await client.get('/api/property/rate-plans')
        .set('Authorization', `Bearer ${token}`);
      expect(ratePlans.status, `${role.role_name} / rates / own property`).toBe(expectedRatePlans);

      const permissions = rolePermissionMatrix[role.role_name];
      const guestRead = assigned && permissions.includes('guests.view');
      const guestManage = assigned && permissions.includes('guests.manage');
      const guestIdView = assigned && permissions.includes('guest.view_id');
      const requestManage = assigned && permissions.includes('guest_requests.manage');
      const reservationRead = assigned && permissions.includes('reservations.view');
      const reservationCreate = assigned && permissions.includes('reservations.create');
      const checkIn = assigned && permissions.includes('checkin.perform');
      const checkOut = assigned && permissions.includes('checkout.perform');
      const canShorten = assigned && permissions.includes('stays.shorten');
      const canViewFolios = assigned && permissions.includes('folio.view');
      const canPostCharges = assigned && permissions.includes('folio.post_charge');
      const canAdjustFolios = assigned && permissions.includes('folio.adjust');
      const canManageCashierShift = assigned && permissions.includes('cashier.shift.manage');
      const canRunNightAudit = assigned && permissions.includes('night_audit.run');
      const canViewFinancialReports = assigned && permissions.includes('reports.view_financial');
      const canViewHousekeeping = assigned && permissions.includes('housekeeping.view');
      const canAssignHousekeeping = assigned && permissions.includes('housekeeping.assign');
      const canWorkHousekeeping = assigned && permissions.includes('housekeeping.work');
      const canInspectHousekeeping = assigned && permissions.includes('housekeeping.inspect');
      const canManageChecklists = assigned && permissions.includes('housekeeping.checklist.manage');
      const canManageMaintenance = assigned && permissions.includes('maintenance.manage');
      const canManageStaff = assigned && permissions.includes('staff.manage');
      const canUseStaffSelfService = assigned && (
        permissions.includes('staff.manage') || permissions.includes('staff.self_service')
      );
      const staffDepartments = await client.get('/api/staff/departments')
        .set('Authorization', `Bearer ${token}`);
      expect(staffDepartments.status, `${role.role_name} / staff management`).toBe(canManageStaff ? 200 : 403);
      const staffProfile = await client.get('/api/staff/me')
        .set('Authorization', `Bearer ${token}`);
      if (!canUseStaffSelfService) {
        expect(staffProfile.status, `${role.role_name} / staff self-service`).toBe(403);
      } else {
        expect([200, 404], `${role.role_name} / staff self-service`).toContain(staffProfile.status);
      }
      const canManageExpenses = assigned && permissions.includes('expenses.manage');
      const canManageInventory = assigned && permissions.includes('inventory.manage');
      const canManageServices = assigned && permissions.includes('services.manage');
      const canPostServices = assigned && permissions.includes('folio.post_charge');
      const canManageAutomation = assigned && permissions.includes('automation.manage');
      const automationRules = await client.get('/api/automation/rules')
        .set('Authorization', `Bearer ${token}`);
      expect(automationRules.status, `${role.role_name} / automation access`)
        .toBe(canManageAutomation ? 200 : 403);
      const notifications = await client.get('/api/notifications')
        .set('Authorization', `Bearer ${token}`);
      expect(notifications.status, `${role.role_name} / property notifications`)
        .toBe(assigned ? 200 : 403);
      const expenseCategories = await client.get('/api/expenses/categories')
        .set('Authorization', `Bearer ${token}`);
      expect(expenseCategories.status, `${role.role_name} / expense access`)
        .toBe(canManageExpenses ? 200 : 403);
      const inventoryItems = await client.get('/api/inventory/items')
        .set('Authorization', `Bearer ${token}`);
      expect(inventoryItems.status, `${role.role_name} / inventory access`)
        .toBe(canManageInventory ? 200 : 403);
      const serviceCatalog = await client.get('/api/services/catalog')
        .set('Authorization', `Bearer ${token}`);
      expect(serviceCatalog.status, `${role.role_name} / service catalog access`)
        .toBe(canManageServices || canPostServices ? 200 : 403);
      const guestRouteCases = [
        ['get', '/api/reservations?search=', null, reservationRead ? 200 : 403, 'reservation list'],
        ['get', '/api/reservations/availability?from=2098-01-01&to=2098-01-02', null, reservationRead ? 200 : 403, 'reservation availability'],
        ['get', '/api/reservations/arrivals?date=2098-01-01', null, reservationRead ? 200 : 403, 'arrival list'],
        ['get', '/api/reservations/departures?date=2098-01-01', null, reservationRead ? 200 : 403, 'departure list'],
        ['get', '/api/reservations/calendar?from=2098-01-01&to=2098-01-07', null, reservationRead ? 200 : 403, 'reservation calendar'],
        ['post', '/api/reservations', {}, reservationCreate ? 400 : 403, 'reservation create'],
        ['get', '/api/reservations/2147483647', null, reservationRead ? 404 : 403, 'reservation detail'],
        ['put', '/api/reservations/2147483647', {}, permissions.includes('reservations.edit') && assigned ? 400 : 403, 'reservation update'],
        ['post', '/api/reservations/2147483647/cancel', {}, permissions.includes('reservations.cancel') && assigned ? 400 : 403, 'reservation cancellation'],
        ['get', '/api/stays/in-house', null, checkIn ? 200 : 403, 'in-house stay list'],
        ['get', '/api/stays/2147483647', null, checkIn ? 404 : 403, 'stay detail'],
        ['post', '/api/reservations/2147483647/check-in', { roomIds: [1] }, checkIn ? 404 : 403, 'reservation check-in'],
        ['post', '/api/walk-ins', {}, checkIn ? 400 : 403, 'walk-in check-in'],
        ['post', '/api/stays/2147483647/move', { roomId: 1, reason: 'Permission matrix test' }, checkIn ? 404 : 403, 'stay room move'],
        ['post', '/api/stays/2147483647/shorten', { checkOutDate: '2099-01-01', reason: 'Permission matrix test' }, canShorten ? 404 : 403, 'stay shortening'],
        ['post', '/api/stays/2147483647/check-out', {}, checkOut ? 404 : 403, 'stay checkout'],
        ['get', '/api/folios?status=open', null, canViewFolios ? 200 : 403, 'folio list'],
        ['get', '/api/folios/2147483647', null, canViewFolios ? 404 : 403, 'folio detail'],
        ['post', '/api/folios/2147483647/charges', {}, canPostCharges ? 400 : 403, 'folio charge posting'],
        ['post', '/api/folios/2147483647/payments', {}, permissions.includes('folio.take_payment') && assigned ? 400 : 403, 'folio payment'],
        ['get', '/api/adjustment-requests', null, canAdjustFolios ? 200 : 403, 'adjustment inbox'],
        ['post', '/api/folios/2147483647/adjustment-requests', {}, canAdjustFolios ? 400 : 403, 'adjustment request'],
        ['get', '/api/cashier-shifts/current', null, canViewFolios ? 200 : 403, 'current cashier shift'],
        ['post', '/api/cashier-shifts/open', {}, canManageCashierShift ? 400 : 403, 'open cashier shift'],
        ['get', '/api/cashier-shifts', null, canViewFinancialReports ? 200 : 403, 'cashier shift reports'],
        ['get', '/api/night-audit/status', null, canRunNightAudit ? 200 : 403, 'night audit status'],
        ['post', '/api/night-audit/run', {}, canRunNightAudit ? 400 : 403, 'night audit run'],
        ['get', '/api/housekeeping/rooms', null, canViewHousekeeping || canWorkHousekeeping || checkIn ? 200 : 403, 'housekeeping room board'],
        ['get', '/api/housekeeping/tasks', null, canViewHousekeeping || canWorkHousekeeping || checkIn ? 200 : 403, 'housekeeping task list'],
        ['get', '/api/housekeeping/settings', null, canViewHousekeeping ? 200 : 403, 'housekeeping settings'],
        ['get', '/api/housekeeping/checklists', null, canViewHousekeeping || canWorkHousekeeping || checkIn ? 200 : 403, 'housekeeping checklist templates'],
        ['get', '/api/housekeeping/staff', null, canAssignHousekeeping ? 200 : 403, 'housekeeping staff'],
        ['get', '/api/housekeeping/reports', null, canViewHousekeeping ? 200 : 403, 'housekeeping reports'],
        ['post', '/api/housekeeping/tasks', {}, canAssignHousekeeping ? 400 : 403, 'housekeeping task creation'],
        ['post', '/api/housekeeping/tasks/bulk-assignment', {}, canAssignHousekeeping ? 400 : 403, 'housekeeping bulk assignment'],
        ['post', '/api/housekeeping/checklists', {}, canManageChecklists ? 400 : 403, 'housekeeping checklist creation'],
        ['post', '/api/housekeeping/tasks/2147483647/start', {}, canWorkHousekeeping ? 404 : 403, 'housekeeping task start'],
        ['patch', '/api/housekeeping/tasks/2147483647/items/1', { complete: true }, canWorkHousekeeping ? 404 : 403, 'housekeeping checklist update'],
        ['post', '/api/housekeeping/tasks/2147483647/submit', {}, canWorkHousekeeping ? 404 : 403, 'housekeeping task submission'],
        ['post', '/api/housekeeping/tasks/2147483647/inspection', { decision: 'approve' }, canInspectHousekeeping ? 404 : 403, 'housekeeping inspection'],
        ['get', '/api/maintenance/tickets', null, canManageMaintenance ? 200 : 403, 'maintenance ticket list'],
        ['get', '/api/maintenance/assets', null, canManageMaintenance ? 200 : 403, 'maintenance asset list'],
        ['get', '/api/maintenance/rooms', null, canManageMaintenance ? 200 : 403, 'maintenance room board'],
        ['get', '/api/maintenance/staff', null, canManageMaintenance ? 200 : 403, 'maintenance staff list'],
        ['post', '/api/maintenance/tickets', {}, canManageMaintenance ? 400 : 403, 'maintenance ticket creation'],
        ['post', '/api/maintenance/assets', {}, canManageMaintenance ? 400 : 403, 'maintenance asset creation'],
        ['patch', '/api/maintenance/tickets/2147483647/status', {}, canManageMaintenance ? 400 : 403, 'maintenance ticket status'],
        ['get', '/api/documents/invoices/2147483647', null, canViewFolios ? 404 : 403, 'invoice document'],
        ['get', '/api/guests', null, guestRead ? 200 : 403, 'guest search'],
        ['get', '/api/guests/2147483647', null, guestRead ? 404 : 403, 'guest profile'],
        ['post', '/api/guests', {}, guestManage ? 400 : 403, 'guest create'],
        ['put', '/api/guests/2147483647', {}, guestManage ? 400 : 403, 'guest update'],
        ['post', '/api/guests/2147483647/reveal-id', {}, guestIdView ? 404 : 403, 'ID reveal'],
        ['post', '/api/guests/2147483647/export', {}, guestManage ? 404 : 403, 'guest export'],
        ['post', '/api/guests/2147483647/anonymize', { reason: 'Permission matrix test' }, guestManage ? 404 : 403, 'guest anonymisation'],
        ['post', '/api/guests/2147483646/merge', { targetGuestId: 2147483647, reason: 'Permission matrix test' }, guestManage ? 404 : 403, 'guest merge'],
        ['get', '/api/guests/privacy-settings', null, guestManage ? 200 : 403, 'privacy settings read'],
        ['put', '/api/guests/privacy-settings', {}, guestManage ? 400 : 403, 'privacy settings write'],
        ['get', '/api/companies', null, guestRead ? 200 : 403, 'company list'],
        ['post', '/api/companies', {}, guestManage ? 400 : 403, 'company create'],
        ['put', '/api/companies/2147483647', { name: 'Test' }, guestManage ? 404 : 403, 'company update'],
        ['delete', '/api/companies/2147483647', null, guestManage ? 404 : 403, 'company archive'],
        ['get', '/api/guest-groups', null, guestRead ? 200 : 403, 'guest group list'],
        ['post', '/api/guest-groups', {}, guestManage ? 400 : 403, 'guest group create'],
        ['put', '/api/guest-groups/2147483647', { name: 'Test', guestIds: [] }, guestManage ? 404 : 403, 'guest group update'],
        ['get', '/api/guest-requests', null, guestRead ? 200 : 403, 'guest request list'],
        ['get', '/api/guest-requests/departments', null, guestRead ? 200 : 403, 'guest request departments'],
        ['post', '/api/guest-requests', {}, requestManage ? 400 : 403, 'guest request create'],
        ['patch', '/api/guest-requests/2147483647', { status: 'resolved' }, requestManage ? 404 : 403, 'guest request update'],
      ];
      for (const [method, path, body, expected, label] of guestRouteCases) {
        let call = request(app)[method](path).set('Authorization', `Bearer ${token}`);
        if (body !== null) call = call.send(body);
        const response = await call;
        expect(response.status, `${role.role_name} / ${label}`).toBe(expected);
      }

      const otherPropertyToken = jwt.sign(
        {
          orgId: role.organization_id === null ? null : Number(role.organization_id),
          role: role.role_name,
          propertyIds: [2147483647],
          activePropertyId: 2147483647,
        },
        env.JWT_ACCESS_SECRET,
        { subject: String(role.user_id), expiresIn: '5m' },
      );
      const otherUsers = await client.get('/api/auth/admin/users')
        .set('Authorization', `Bearer ${otherPropertyToken}`);
      expect(otherUsers.status, `${role.role_name} / users / unassigned property`).toBe(403);
      const otherRoles = await client.get('/api/auth/admin/roles')
        .set('Authorization', `Bearer ${otherPropertyToken}`);
      expect(otherRoles.status, `${role.role_name} / roles / unassigned property`).toBe(403);
      const otherRack = await client.get('/api/property/rooms')
        .set('Authorization', `Bearer ${otherPropertyToken}`);
      expect(otherRack.status, `${role.role_name} / room rack / unassigned property`).toBe(403);
      const otherGuests = await client.get('/api/guests')
        .set('Authorization', `Bearer ${otherPropertyToken}`);
      expect(otherGuests.status, `${role.role_name} / guest search / unassigned property`).toBe(403);
    }
  }, 120_000);
});
