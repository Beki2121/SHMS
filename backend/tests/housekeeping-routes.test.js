import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';
import { clearPermissionCache } from '../src/auth/permissions.js';

describe('Phase 9 housekeeping and room readiness', () => {
  const app = createApp();
  let propertyId;
  let roomTypeId;
  let roomId;
  let ownerToken;
  let supervisorToken;
  let staffToken;
  let staffId;
  let taskId;

  function tokenFor(user) {
    return jwt.sign({
      orgId: Number(user.organization_id),
      role: user.role_name,
      propertyIds: [propertyId],
      activePropertyId: propertyId,
    }, env.JWT_ACCESS_SECRET, { subject: String(user.id), expiresIn: '10m' });
  }

  function authorized(token, method, path) {
    return request(app)[method](path).set('Authorization', ['Bearer', token].join(' '));
  }

  async function changeRoomStatus(nextStatus, reason, targetRoomId = roomId) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT status FROM rooms WHERE property_id = ? AND id = ? FOR UPDATE',
        [propertyId, targetRoomId],
      );
      await connection.execute(
        `INSERT INTO room_status_history
          (property_id, room_id, from_status, to_status, reason, changed_by, changed_at)
         VALUES (?, ?, ?, ?, ?, NULL, UTC_TIMESTAMP())`,
        [propertyId, targetRoomId, rows[0].status, nextStatus, reason],
      );
      await connection.execute('SET @shms_housekeeping_transition = 1');
      await connection.execute(
        'UPDATE rooms SET status = ? WHERE property_id = ? AND id = ?',
        [nextStatus, propertyId, targetRoomId],
      );
      await connection.execute('SET @shms_housekeeping_transition = 0');
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      await connection.execute('SET @shms_housekeeping_transition = 0');
      throw error;
    } finally {
      connection.release();
    }
  }

  beforeAll(async () => {
    clearPermissionCache();
    const [ownerRows] = await pool.execute(
      `SELECT u.id, u.organization_id, role.name AS role_name, membership.property_id
       FROM users u JOIN roles role ON role.id = u.role_id
       JOIN user_properties membership ON membership.user_id = u.id
       WHERE u.email = 'owner@smarthotel.local' LIMIT 1`,
    );
    if (!ownerRows.length) throw new Error('Housekeeping tests require the seeded owner');
    const owner = ownerRows[0];
    propertyId = Number(owner.property_id);
    ownerToken = tokenFor(owner);
    const [staffRows] = await pool.execute(
      `SELECT u.id, u.organization_id, role.name AS role_name, membership.property_id
       FROM users u JOIN roles role ON role.id = u.role_id
       JOIN user_properties membership ON membership.user_id = u.id
       WHERE membership.property_id = ? AND role.name = 'housekeeping_staff' AND u.is_active = 1 LIMIT 1`,
      [propertyId],
    );
    const [supervisorRows] = await pool.execute(
      `SELECT u.id, u.organization_id, role.name AS role_name, membership.property_id
       FROM users u JOIN roles role ON role.id = u.role_id
       JOIN user_properties membership ON membership.user_id = u.id
       WHERE membership.property_id = ? AND role.name = 'housekeeping_supervisor' AND u.is_active = 1 LIMIT 1`,
      [propertyId],
    );
    if (!staffRows.length || !supervisorRows.length) throw new Error('Housekeeping tests require seeded staff and supervisor accounts');
    staffId = Number(staffRows[0].id);
    staffToken = tokenFor(staffRows[0]);
    supervisorToken = tokenFor(supervisorRows[0]);

    const [types] = await pool.execute(
      `SELECT id FROM room_types WHERE property_id = ? AND is_active = 1 AND deleted_at IS NULL LIMIT 1`,
      [propertyId],
    );
    roomTypeId = Number(types[0].id);
    const roomNumber = `HK-${Date.now()}`;
    const [room] = await pool.execute(
      `INSERT INTO rooms (property_id, room_type_id, room_number, status, housekeeping_priority, is_active)
       VALUES (?, ?, ?, 'CLEAN', 0, 1)`,
      [propertyId, roomTypeId, roomNumber],
    );
    roomId = Number(room.insertId);
  });

  afterAll(async () => {
    if (!roomId) return;
    const [testRooms] = await pool.execute(
      `SELECT id, status FROM rooms
       WHERE property_id = ? AND room_number LIKE 'HK-%'`,
      [propertyId],
    );
    for (const testRoom of testRooms) {
      const [tasks] = await pool.execute(
        'SELECT id FROM housekeeping_tasks WHERE property_id = ? AND room_id = ?',
        [propertyId, testRoom.id],
      );
      for (const task of tasks) {
        await pool.execute('DELETE FROM task_checklist_items WHERE property_id = ? AND task_id = ?', [propertyId, task.id]);
      }
      await pool.execute('DELETE FROM housekeeping_tasks WHERE property_id = ? AND room_id = ?', [propertyId, testRoom.id]);
      await pool.execute('DELETE FROM maintenance_tickets WHERE property_id = ? AND room_id = ?', [propertyId, testRoom.id]);
      if (testRoom.status !== 'CLEAN') {
        await changeRoomStatus('CLEAN', 'Housekeeping integration test cleanup', Number(testRoom.id));
      }
      await pool.execute(
        'UPDATE rooms SET is_active = 0 WHERE property_id = ? AND id = ?',
        [propertyId, testRoom.id],
      );
    }
    const [testChecklists] = await pool.execute(
      `SELECT id FROM housekeeping_checklists
       WHERE property_id = ? AND name LIKE 'Phase 9 turnover %'`,
      [propertyId],
    );
    for (const checklist of testChecklists) {
      await pool.execute(
        'DELETE FROM housekeeping_checklist_items WHERE property_id = ? AND checklist_id = ?',
        [propertyId, checklist.id],
      );
      await pool.execute(
        'DELETE FROM housekeeping_checklists WHERE property_id = ? AND id = ?',
        [propertyId, checklist.id],
      );
    }
  });

  it('snapshots checklists, enforces assigned work and inspection before room assignment', async () => {
    const template = await authorized(ownerToken, 'post', '/api/housekeeping/checklists')
      .send({
        name: `Phase 9 turnover ${Date.now()}`,
        roomTypeId,
        items: [
          { label: 'Clean bedroom', required: true },
          { label: 'Sanitize bathroom', required: true },
          { label: 'Optional amenity restock', required: false },
        ],
      });
    expect(template.status).toBe(201);

    const created = await authorized(ownerToken, 'post', '/api/housekeeping/tasks')
      .send({
        roomId,
        type: 'checkout_clean',
        priority: 4,
        dueAt: new Date(Date.now() - 60_000).toISOString(),
        assignedTo: staffId,
      });
    expect(created.status).toBe(201);
    taskId = created.body.data.id;
    expect(created.body.data.checklist.map((item) => item.label)).toEqual([
      'Clean bedroom',
      'Sanitize bathroom',
      'Optional amenity restock',
    ]);
    expect(created.body.data.checklist[2].required).toBe(false);
    expect(created.body.data.isOverdue).toBe(true);

    const staffList = await authorized(staffToken, 'get', '/api/housekeeping/tasks');
    expect(staffList.status).toBe(200);
    expect(staffList.body.data.map((task) => task.id)).toContain(taskId);
    expect(staffList.body.data.every((task) => task.assignedTo === staffId)).toBe(true);
    const staffRooms = await authorized(staffToken, 'get', '/api/housekeeping/rooms');
    expect(staffRooms.body.data.find((room) => room.id === roomId).status).toBe('CLEAN');

    await changeRoomStatus('AWAITING_CLEANING', 'Phase 9 state-machine integration test');
    const directMutation = pool.execute(
      'UPDATE rooms SET status = ? WHERE property_id = ? AND id = ?',
      ['CLEAN', propertyId, roomId],
    );
    await expect(directMutation).rejects.toThrow(/housekeeping workflow/i);

    const start = await authorized(staffToken, 'post', `/api/housekeeping/tasks/${taskId}/start`).send({});
    expect(start.status).toBe(200);
    expect(start.body.data.status).toBe('in_progress');
    const [roomDuringWork] = await pool.execute('SELECT status FROM rooms WHERE property_id = ? AND id = ?', [propertyId, roomId]);
    expect(roomDuringWork[0].status).toBe('BEING_CLEANED');

    const secondStart = await authorized(staffToken, 'post', `/api/housekeeping/tasks/${taskId}/start`).send({});
    expect(secondStart.status).toBe(409);
    const incomplete = await authorized(staffToken, 'post', `/api/housekeeping/tasks/${taskId}/submit`).send({});
    expect(incomplete.status).toBe(409);
    expect(incomplete.body.error.code).toBe('CHECKLIST_INCOMPLETE');

    for (const item of start.body.data.checklist.filter((entry) => entry.required)) {
      const response = await authorized(staffToken, 'patch', `/api/housekeeping/tasks/${taskId}/items/${item.id}`)
        .send({ complete: true });
      expect(response.status).toBe(200);
    }
    const issue = await authorized(staffToken, 'post', `/api/housekeeping/tasks/${taskId}/issue`)
      .send({ category: 'Fixtures', description: 'Loose towel rail needs repair', priority: 'normal' });
    expect(issue.status).toBe(201);
    const [tickets] = await pool.execute(
      'SELECT status, blocks_room FROM maintenance_tickets WHERE property_id = ? AND id = ?',
      [propertyId, issue.body.data.ticketId],
    );
    expect(tickets[0]).toMatchObject({ status: 'open', blocks_room: 0 });

    const submitted = await authorized(staffToken, 'post', `/api/housekeeping/tasks/${taskId}/submit`).send({});
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe('awaiting_inspection');
    const [awaitingInspection] = await pool.execute('SELECT status FROM rooms WHERE property_id = ? AND id = ?', [propertyId, roomId]);
    expect(awaitingInspection[0].status).toBe('AWAITING_INSPECTION');

    const rejected = await authorized(supervisorToken, 'post', `/api/housekeeping/tasks/${taskId}/inspection`)
      .send({ decision: 'reject', reason: 'Retest the bathroom floor' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.status).toBe('rejected');
    const [reworkRoom] = await pool.execute('SELECT status FROM rooms WHERE property_id = ? AND id = ?', [propertyId, roomId]);
    expect(reworkRoom[0].status).toBe('BEING_CLEANED');

    const restart = await authorized(staffToken, 'post', `/api/housekeeping/tasks/${taskId}/start`).send({});
    expect(restart.status).toBe(200);
    const resubmitted = await authorized(staffToken, 'post', `/api/housekeeping/tasks/${taskId}/submit`).send({});
    expect(resubmitted.status).toBe(200);
    const blockingTicket = await authorized(ownerToken, 'post', '/api/maintenance/tickets')
      .send({
        roomId,
        category: 'Fixtures',
        priority: 'high',
        description: 'Test if a pending repair blocks room readiness',
        blocksRoom: true,
      });
    expect(blockingTicket.status).toBe(201);
    const approved = await authorized(supervisorToken, 'post', `/api/housekeeping/tasks/${taskId}/inspection`)
      .send({ decision: 'approve' });
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('approved');
    const [readyRoom] = await pool.execute('SELECT status FROM rooms WHERE property_id = ? AND id = ?', [propertyId, roomId]);
    expect(readyRoom[0].status).toBe('BLOCKED_MAINTENANCE');
    const maintenanceTicketId = blockingTicket.body.data.id;
    const startedRepair = await authorized(ownerToken, 'patch', `/api/maintenance/tickets/${maintenanceTicketId}/status`)
      .send({ status: 'in_progress' });
    expect(startedRepair.status).toBe(200);
    const resolvedRepair = await authorized(ownerToken, 'patch', `/api/maintenance/tickets/${maintenanceTicketId}/status`)
      .send({ status: 'resolved', resolutionNotes: 'Completed readiness guard integration test' });
    expect(resolvedRepair.status).toBe(200);
    const clearedRepair = await authorized(ownerToken, 'patch', `/api/maintenance/tickets/${maintenanceTicketId}/status`)
      .send({ status: 'closed', clearanceNotes: 'Maintenance test issue cleared' });
    expect(clearedRepair.status).toBe(200);
    expect(clearedRepair.body.data.roomStatus).toBe('CLEAN');

    const rack = await authorized(ownerToken, 'get', '/api/housekeeping/rooms');
    expect(rack.body.data.find((room) => room.id === roomId).status).toBe('CLEAN');
    const reports = await authorized(ownerToken, 'get', '/api/housekeeping/reports');
    expect(reports.status).toBe(200);
    expect(reports.body.data.readyRooms).toBeGreaterThan(0);
    expect(reports.body.data).toHaveProperty('byEmployee');
  }, 30000);

  it('supports supervisor bulk assignment and prevents staff from acting on unassigned tasks', async () => {
    const created = await authorized(ownerToken, 'post', '/api/housekeeping/tasks')
      .send({ roomId, type: 'daily_clean', priority: 3 });
    expect(created.status).toBe(201);
    const bulk = await authorized(ownerToken, 'post', '/api/housekeeping/tasks/bulk-assignment')
      .send({ taskIds: [created.body.data.id], assignedTo: staffId });
    expect(bulk.status).toBe(200);
    expect(bulk.body.data.assigned).toBe(1);
    const staffTaskList = await authorized(staffToken, 'get', '/api/housekeeping/tasks');
    expect(staffTaskList.body.data.map((task) => task.id)).toContain(created.body.data.id);

    const unassigned = await authorized(ownerToken, 'post', '/api/housekeeping/tasks')
      .send({ roomId, type: 'turndown', priority: 3 });
    expect(unassigned.status).toBe(201);
    const forbiddenStart = await authorized(staffToken, 'post', `/api/housekeeping/tasks/${unassigned.body.data.id}/start`).send({});
    expect(forbiddenStart.status).toBe(403);
    const [allStaffTasks] = await pool.execute(
      'SELECT id FROM housekeeping_tasks WHERE property_id = ? AND assigned_to = ?',
      [propertyId, staffId],
    );
    expect(allStaffTasks.some((task) => Number(task.id) === unassigned.body.data.id)).toBe(false);
  }, 30000);
});
