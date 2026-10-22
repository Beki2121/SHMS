import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';
import { clearPermissionCache } from '../src/auth/permissions.js';

describe('Phase 10 maintenance and room blocking', () => {
  const app = createApp();
  let propertyId;
  let roomTypeId;
  let organizationId;
  let ownerId;
  let maintenanceStaffId;
  let ownerToken;
  let staffToken;
  let roomId;
  let assetId;
  let ticketId;
  let assetTag;
  let reservationId;

  function tokenFor(userId, role) {
    return jwt.sign({
      orgId: organizationId,
      role,
      propertyIds: [propertyId],
      activePropertyId: propertyId,
    }, env.JWT_ACCESS_SECRET, { subject: String(userId), expiresIn: '10m' });
  }

  function authorized(token, method, path) {
    return request(app)[method](path).set('Authorization', ['Bearer', token].join(' '));
  }

  beforeAll(async () => {
    clearPermissionCache();
    const [owners] = await pool.execute(
      `SELECT user.id, user.organization_id, membership.property_id, role.name AS role_name
       FROM users user
       JOIN roles role ON role.id = user.role_id
       JOIN user_properties membership ON membership.user_id = user.id
       WHERE user.email = 'owner@smarthotel.local' LIMIT 1`,
    );
    if (!owners.length) throw new Error('Maintenance tests require the seeded owner');
    propertyId = Number(owners[0].property_id);
    organizationId = Number(owners[0].organization_id);
    ownerId = Number(owners[0].id);
    ownerToken = tokenFor(ownerId, owners[0].role_name);
    const [staff] = await pool.execute(
      `SELECT user.id, role.name AS role_name
       FROM users user
       JOIN roles role ON role.id = user.role_id
       JOIN user_properties membership ON membership.user_id = user.id
       JOIN role_permissions permission ON permission.role_id = role.id
         AND permission.permission_key = 'maintenance.manage'
       WHERE membership.property_id = ? AND user.is_active = 1
         AND role.name = 'maintenance_staff' LIMIT 1`,
      [propertyId],
    );
    if (!staff.length) throw new Error('Maintenance tests require the seeded maintenance user');
    maintenanceStaffId = Number(staff[0].id);
    staffToken = tokenFor(maintenanceStaffId, staff[0].role_name);
    const [types] = await pool.execute(
      'SELECT id FROM room_types WHERE property_id = ? AND is_active = 1 AND deleted_at IS NULL LIMIT 1',
      [propertyId],
    );
    roomTypeId = Number(types[0].id);
    const [room] = await pool.execute(
      `INSERT INTO rooms (property_id, room_type_id, room_number, status, housekeeping_priority, is_active)
       VALUES (?, ?, ?, 'CLEAN', 0, 1)`,
      [propertyId, roomTypeId, `MT-${Date.now()}`],
    );
    roomId = Number(room.insertId);
    assetTag = `MT-${Date.now()}`;
  });

  afterAll(async () => {
    if (ticketId) {
      const [tickets] = await pool.execute(
        'SELECT status FROM maintenance_tickets WHERE property_id = ? AND id = ?',
        [propertyId, ticketId],
      );
      let status = tickets[0]?.status;
      if (status === 'open' || status === 'assigned') {
        const started = await authorized(ownerToken, 'patch', `/api/maintenance/tickets/${ticketId}/status`)
          .send({ status: 'in_progress' });
        if (started.status === 200) status = 'in_progress';
      }
      if (status === 'in_progress') {
        const resolved = await authorized(ownerToken, 'patch', `/api/maintenance/tickets/${ticketId}/status`)
          .send({ status: 'resolved', resolutionNotes: 'Test cleanup completed' });
        if (resolved.status === 200) status = 'resolved';
      }
      if (status === 'resolved') {
        await authorized(ownerToken, 'patch', `/api/maintenance/tickets/${ticketId}/status`)
          .send({ status: 'closed', clearanceNotes: 'Test cleanup cleared' });
      }
    }
    if (reservationId) {
      await authorized(ownerToken, 'post', `/api/reservations/${reservationId}/cancel`)
        .send({ reason: 'Maintenance integration test cleanup' });
    }
    if (assetId) {
      await pool.execute(
        'UPDATE assets SET deleted_at = COALESCE(deleted_at, UTC_TIMESTAMP()) WHERE property_id = ? AND id = ?',
        [propertyId, assetId],
      );
    }
    if (roomId) {
      await pool.execute('UPDATE rooms SET is_active = 0 WHERE property_id = ? AND id = ?', [propertyId, roomId]);
    }
  });

  it('tracks assets, excludes blocked rooms, and requires audited maintenance clearance', async () => {
    const asset = await authorized(ownerToken, 'post', '/api/maintenance/assets')
      .send({ name: 'Test room air conditioner', assetTag, category: 'HVAC', roomId, status: 'needs_service' });
    expect(asset.status).toBe(201);
    assetId = asset.body.data.id;

    const baselineAvailability = await authorized(ownerToken, 'get', '/api/reservations/availability?from=2099-01-01&to=2099-01-02');
    expect(baselineAvailability.status).toBe(200);
    const baselineRooms = baselineAvailability.body.data[0].roomTypes
      .find((type) => type.id === roomTypeId);
    expect(baselineRooms).toBeDefined();

    const [[guests], [plans]] = await Promise.all([
      pool.execute(
        `SELECT id FROM guests WHERE property_id = ? AND deleted_at IS NULL
         AND anonymised_at IS NULL LIMIT 1`,
        [propertyId],
      ),
      pool.execute(
        `SELECT id FROM rate_plans WHERE property_id = ? AND is_active = 1 AND deleted_at IS NULL LIMIT 1`,
        [propertyId],
      ),
    ]);
    const reservation = await authorized(ownerToken, 'post', '/api/reservations')
      .send({
        primaryGuestId: Number(guests[0].id),
        checkInDate: '2099-01-01',
        checkOutDate: '2099-01-02',
        rooms: [{ roomTypeId, roomId, ratePlanId: Number(plans[0].id), adults: 1, children: 0 }],
      });
    expect(reservation.status).toBe(201);
    reservationId = reservation.body.data.id;

    const duplicateAsset = await authorized(ownerToken, 'post', '/api/maintenance/assets')
      .send({ name: 'Duplicate tag test', assetTag, category: 'HVAC' });
    expect(duplicateAsset.status).toBe(409);
    expect(duplicateAsset.body.error.code).toBe('ASSET_TAG_EXISTS');

    const created = await authorized(ownerToken, 'post', '/api/maintenance/tickets')
      .send({
        assetId,
        category: 'HVAC',
        priority: 'urgent',
        description: 'Cooling failure in test room',
        blocksRoom: true,
        assignedTo: maintenanceStaffId,
      });
    expect(created.status).toBe(201);
    ticketId = created.body.data.id;
    expect(created.body.data).toMatchObject({ roomId, roomStatus: 'BLOCKED_MAINTENANCE' });
    expect(created.body.data.conflicts).toEqual([expect.objectContaining({
      confirmationNo: reservation.body.data.confirmationNo,
      checkInDate: '2099-01-01',
      checkOutDate: '2099-01-02',
    })]);

    const [blockedRoom] = await pool.execute(
      'SELECT status FROM rooms WHERE property_id = ? AND id = ?',
      [propertyId, roomId],
    );
    expect(blockedRoom[0].status).toBe('BLOCKED_MAINTENANCE');
    const blockedAvailability = await authorized(ownerToken, 'get', '/api/reservations/availability?from=2099-01-01&to=2099-01-02');
    const blockedRooms = blockedAvailability.body.data[0].roomTypes.find((type) => type.id === roomTypeId);
    expect(blockedRooms.totalRooms).toBe(baselineRooms.totalRooms - 1);
    const blockingMutation = pool.execute(
      'UPDATE rooms SET status = ? WHERE property_id = ? AND id = ?',
      ['CLEAN', propertyId, roomId],
    );
    await expect(blockingMutation).rejects.toThrow(/audited clearance/i);

    const assigned = await authorized(ownerToken, 'get', '/api/maintenance/tickets');
    expect(assigned.status).toBe(200);
    expect(assigned.body.data.find((ticket) => ticket.id === ticketId)).toMatchObject({
      status: 'assigned',
      blocksRoom: true,
      assignedTo: maintenanceStaffId,
      assetTag,
    });
    const staffTickets = await authorized(staffToken, 'get', '/api/maintenance/tickets');
    expect(staffTickets.status).toBe(200);
    const underway = await authorized(staffToken, 'patch', `/api/maintenance/tickets/${ticketId}/status`)
      .send({ status: 'in_progress' });
    expect(underway.status).toBe(200);
    const resolved = await authorized(staffToken, 'patch', `/api/maintenance/tickets/${ticketId}/status`)
      .send({ status: 'resolved', resolutionNotes: 'Replaced the cooling unit fuse' });
    expect(resolved.status).toBe(200);

    const stillBlocked = await authorized(ownerToken, 'get', '/api/reservations/availability?from=2099-01-01&to=2099-01-02');
    expect(stillBlocked.body.data[0].roomTypes.find((type) => type.id === roomTypeId).totalRooms)
      .toBe(baselineRooms.totalRooms - 1);
    const missingClearance = await authorized(ownerToken, 'patch', `/api/maintenance/tickets/${ticketId}/status`)
      .send({ status: 'closed' });
    expect(missingClearance.status).toBe(400);

    const cleared = await authorized(ownerToken, 'patch', `/api/maintenance/tickets/${ticketId}/status`)
      .send({ status: 'closed', clearanceNotes: 'Test room inspected and ready for service' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({
      status: 'closed',
      clearedBy: ownerId,
      clearanceNotes: 'Test room inspected and ready for service',
      roomStatus: 'CLEAN',
    });
    const availableAgain = await authorized(ownerToken, 'get', '/api/reservations/availability?from=2099-01-01&to=2099-01-02');
    expect(availableAgain.body.data[0].roomTypes.find((type) => type.id === roomTypeId).totalRooms)
      .toBe(baselineRooms.totalRooms);
    const [clearAudit] = await pool.execute(
      `SELECT action FROM audit_log
       WHERE property_id = ? AND entity = 'maintenance_ticket' AND entity_id = ?`,
      [propertyId, String(ticketId)],
    );
    expect(clearAudit.some((entry) => entry.action === 'maintenance.ticket_cleared')).toBe(true);
    const [roomHistory] = await pool.execute(
      `SELECT from_status, to_status FROM room_status_history
       WHERE property_id = ? AND room_id = ? ORDER BY id DESC LIMIT 1`,
      [propertyId, roomId],
    );
    expect(roomHistory[0]).toMatchObject({ from_status: 'BLOCKED_MAINTENANCE', to_status: 'CLEAN' });

    const archived = await authorized(ownerToken, 'delete', `/api/maintenance/assets/${assetId}`);
    expect(archived.status).toBe(204);
    const assets = await authorized(ownerToken, 'get', '/api/maintenance/assets');
    expect(assets.body.data.some((assetRow) => assetRow.id === assetId)).toBe(false);
  });
});
