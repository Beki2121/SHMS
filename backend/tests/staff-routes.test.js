import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';
import { clearPermissionCache } from '../src/auth/permissions.js';

describe('Phase 11 staff operations', () => {
  const app = createApp();
  let propertyId;
  let organizationId;
  let ownerId;
  let employeeUserId;
  let ownerToken;
  let employeeToken;
  let departmentId;
  let employeeId;
  let overnightShiftId;
  let earlyShiftId;
  let shortShiftId;
  const assignmentIds = [];
  const leaveIds = [];
  const handoverIds = [];

  function tokenFor(userId, role) {
    return jwt.sign({
      orgId: organizationId,
      role,
      propertyIds: [propertyId],
      activePropertyId: propertyId,
    }, env.JWT_ACCESS_SECRET, { subject: String(userId), expiresIn: '10m' });
  }

  function authorized(token, method, path) {
    return request(app)[method](path).set('Authorization', `Bearer ${token}`);
  }

  function propertyDate(timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${fields.year}-${fields.month}-${fields.day}`;
  }

  beforeAll(async () => {
    clearPermissionCache();
    const [owners] = await pool.execute(
      `SELECT user.id, user.organization_id, membership.property_id
       FROM users user
       JOIN user_properties membership ON membership.user_id = user.id
       JOIN roles role ON role.id = user.role_id AND role.name = 'owner_gm'
       WHERE user.email = 'owner@smarthotel.local' LIMIT 1`,
    );
    if (!owners.length) throw new Error('Staff tests require a seeded owner with property access');
    ownerId = Number(owners[0].id);
    organizationId = Number(owners[0].organization_id);
    propertyId = Number(owners[0].property_id);
    ownerToken = tokenFor(ownerId, 'owner_gm');

    const [users] = await pool.execute(
      `SELECT user.id
       FROM users user
       JOIN user_properties membership ON membership.user_id = user.id
       JOIN roles role ON role.id = user.role_id AND role.name = 'front_desk'
       WHERE membership.property_id = ? AND user.is_active = 1 LIMIT 1`,
      [propertyId],
    );
    if (!users.length) throw new Error('Staff tests require a seeded front-desk user');
    employeeUserId = Number(users[0].id);
    employeeToken = tokenFor(employeeUserId, 'front_desk');
  });

  afterAll(async () => {
    if (!propertyId) return;
    if (handoverIds.length) {
      await pool.execute(
        `DELETE FROM handover_notes WHERE property_id = ? AND id IN (${handoverIds.map(() => '?').join(',')})`,
        [propertyId, ...handoverIds],
      );
    }
    if (leaveIds.length) {
      await pool.execute(
        `DELETE FROM leave_requests WHERE property_id = ? AND id IN (${leaveIds.map(() => '?').join(',')})`,
        [propertyId, ...leaveIds],
      );
    }
    if (employeeId) {
      await pool.execute('DELETE FROM attendance WHERE property_id = ? AND employee_id = ?', [propertyId, employeeId]);
      await pool.execute('DELETE FROM shift_assignments WHERE property_id = ? AND employee_id = ?', [propertyId, employeeId]);
      await pool.execute('DELETE FROM employees WHERE property_id = ? AND id = ?', [propertyId, employeeId]);
    }
    if (assignmentIds.length) {
      await pool.execute(
        `DELETE FROM shift_assignments WHERE property_id = ? AND id IN (${assignmentIds.map(() => '?').join(',')})`,
        [propertyId, ...assignmentIds],
      );
    }
    for (const shiftId of [overnightShiftId, earlyShiftId, shortShiftId].filter(Boolean)) {
      await pool.execute('DELETE FROM shifts WHERE property_id = ? AND id = ?', [propertyId, shiftId]);
    }
    if (departmentId) {
      await pool.execute('DELETE FROM departments WHERE property_id = ? AND id = ?', [propertyId, departmentId]);
    }
  });

  it('manages rosters, leave, attendance, handovers, and safe exports within property permissions', async () => {
    const department = await authorized(ownerToken, 'post', '/api/staff/departments')
      .send({ name: `Staff test ${Date.now()}` });
    expect(department.status).toBe(201);
    departmentId = department.body.data.id;

    const createdEmployee = await authorized(ownerToken, 'post', '/api/staff/employees')
      .send({
        userId: employeeUserId,
        fullName: '=2+2',
        departmentId,
        jobTitle: 'Test attendant',
        employmentStatus: 'active',
      });
    expect(createdEmployee.status).toBe(201);
    employeeId = createdEmployee.body.data.id;

    const overnightShift = await authorized(ownerToken, 'post', '/api/staff/shifts')
      .send({ name: `Night test ${Date.now()}`, startTime: '22:00', endTime: '06:00' });
    expect(overnightShift.status).toBe(201);
    overnightShiftId = overnightShift.body.data.id;
    const earlyShift = await authorized(ownerToken, 'post', '/api/staff/shifts')
      .send({ name: `Early test ${Date.now()}`, startTime: '02:00', endTime: '10:00' });
    expect(earlyShift.status).toBe(201);
    earlyShiftId = earlyShift.body.data.id;
    const shortShift = await authorized(ownerToken, 'post', '/api/staff/shifts')
      .send({ name: `Short test ${Date.now()}`, startTime: '00:00', endTime: '00:01' });
    expect(shortShift.status).toBe(201);
    shortShiftId = shortShift.body.data.id;

    const overnight = await authorized(ownerToken, 'post', '/api/staff/roster')
      .send({ employeeId, shiftId: overnightShiftId, date: '2099-01-02' });
    expect(overnight.status).toBe(201);
    assignmentIds.push(overnight.body.data.id);
    const changeAssignedShift = await authorized(ownerToken, 'put', `/api/staff/shifts/${overnightShiftId}`)
      .send({ name: `Renamed night ${Date.now()}`, startTime: '21:00', endTime: '05:00' });
    expect(changeAssignedShift.status).toBe(409);
    expect(changeAssignedShift.body.error.code).toBe('SHIFT_IN_USE');
    const deleteAssignedShift = await authorized(ownerToken, 'delete', `/api/staff/shifts/${overnightShiftId}`);
    expect(deleteAssignedShift.status).toBe(409);
    const overlap = await authorized(ownerToken, 'post', '/api/staff/roster')
      .send({ employeeId, shiftId: earlyShiftId, date: '2099-01-03' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('SHIFT_CONFLICT');

    const leaveRoster = await authorized(ownerToken, 'post', '/api/staff/roster')
      .send({ employeeId, shiftId: earlyShiftId, date: '2099-02-10' });
    expect(leaveRoster.status).toBe(201);
    assignmentIds.push(leaveRoster.body.data.id);
    const leave = await authorized(employeeToken, 'post', '/api/staff/leave')
      .send({
        type: 'annual',
        dateFrom: '2099-02-10',
        dateTo: '2099-02-11',
        reason: 'Test leave request',
      });
    expect(leave.status, JSON.stringify(leave.body)).toBe(201);
    leaveIds.push(leave.body.data.id);
    const duplicateLeave = await authorized(employeeToken, 'post', '/api/staff/leave')
      .send({
        type: 'personal',
        dateFrom: '2099-02-11',
        dateTo: '2099-02-12',
        reason: 'Overlapping test leave request',
      });
    expect(duplicateLeave.status).toBe(409);
    expect(duplicateLeave.body.error.code).toBe('LEAVE_OVERLAP');
    const blockedApproval = await authorized(ownerToken, 'patch', `/api/staff/leave/${leave.body.data.id}/decision`)
      .send({ decision: 'approved' });
    expect(blockedApproval.status).toBe(409);
    expect(blockedApproval.body.error.code).toBe('ROSTER_CONFLICT');

    const removeRoster = await authorized(ownerToken, 'delete', `/api/staff/roster/${leaveRoster.body.data.id}`);
    expect(removeRoster.status).toBe(204);
    const approved = await authorized(ownerToken, 'patch', `/api/staff/leave/${leave.body.data.id}/decision`)
      .send({ decision: 'approved' });
    expect(approved.status).toBe(200);
    const scheduleDuringLeave = await authorized(ownerToken, 'post', '/api/staff/roster')
      .send({ employeeId, shiftId: earlyShiftId, date: '2099-02-11' });
    expect(scheduleDuringLeave.status).toBe(409);
    expect(scheduleDuringLeave.body.error.code).toBe('EMPLOYEE_ON_LEAVE');
    assignmentIds.splice(assignmentIds.indexOf(leaveRoster.body.data.id), 1);

    const [properties] = await pool.execute('SELECT timezone FROM properties WHERE id = ?', [propertyId]);
    const date = propertyDate(properties[0].timezone);
    const todayAssignment = await authorized(ownerToken, 'post', '/api/staff/roster')
      .send({ employeeId, shiftId: shortShiftId, date });
    expect(todayAssignment.status).toBe(201);
    assignmentIds.push(todayAssignment.body.data.id);

    const unauthorized = await authorized(employeeToken, 'get', '/api/staff/departments');
    expect(unauthorized.status).toBe(403);
    const clockIn = await authorized(employeeToken, 'post', '/api/staff/attendance/clock-in').send({});
    expect(clockIn.status).toBe(201);
    await pool.execute(
      'UPDATE attendance SET clock_in = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 HOUR) WHERE property_id = ? AND employee_id = ? AND date = ?',
      [propertyId, employeeId, date],
    );
    const clockOut = await authorized(employeeToken, 'post', '/api/staff/attendance/clock-out').send({});
    expect(clockOut.status).toBe(200);
    expect(clockOut.body.data.overtimeMinutes).toBeGreaterThanOrEqual(179);

    const profile = await authorized(employeeToken, 'get', '/api/staff/me');
    expect(profile.status).toBe(200);
    expect(profile.body.data.fullName).toBe('=2+2');
    const spoofedScope = await authorized(ownerToken, 'get', '/api/staff/employees?propertyId=2147483647');
    expect(spoofedScope.status).toBe(200);
    expect(spoofedScope.body.data.some((row) => row.id === employeeId)).toBe(true);
    const ownLeave = await authorized(employeeToken, 'get', '/api/staff/leave');
    expect(ownLeave.status).toBe(200);
    expect(ownLeave.body.data.every((row) => row.employeeId === employeeId)).toBe(true);

    const handover = await authorized(employeeToken, 'post', '/api/staff/handovers')
      .send({ departmentId, title: 'Test handover', body: 'Append-only handover test content' });
    expect(handover.status).toBe(201);
    handoverIds.push(handover.body.data.id);
    const handovers = await authorized(employeeToken, 'get', `/api/staff/handovers?departmentId=${departmentId}`);
    expect(handovers.status).toBe(200);
    expect(handovers.body.data.some((note) => note.id === handover.body.data.id)).toBe(true);
    const noMutationRoute = await authorized(employeeToken, 'delete', `/api/staff/handovers/${handover.body.data.id}`);
    expect(noMutationRoute.status).toBe(404);

    const exportResponse = await authorized(ownerToken, 'get', `/api/staff/export.csv?from=${date}&to=${date}`);
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers['content-type']).toContain('text/csv');
    expect(exportResponse.text).toContain(`"'=2+2"`);
    expect(exportResponse.text).toContain('overtime_minutes');

    const roster = await authorized(ownerToken, 'get', `/api/staff/roster?from=${date}&to=${date}`);
    expect(roster.status).toBe(200);
    expect(roster.body.data.some((row) => row.employeeId === employeeId)).toBe(true);
    const attendance = await authorized(ownerToken, 'get', `/api/staff/attendance?from=${date}&to=${date}`);
    expect(attendance.status).toBe(200);
    expect(attendance.body.data.some((row) => row.employeeId === employeeId && row.overtimeMinutes >= 179)).toBe(true);
  });
});
