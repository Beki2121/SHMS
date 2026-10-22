import { Router } from 'express';
import { z } from 'zod';
import { auditable } from '../auth/audit.js';
import { authenticate, propertyScope, requireAnyPermission, requirePermission } from '../auth/middleware.js';
import { getRolePermissions } from '../auth/permissions.js';
import { logger } from '../config/logger.js';

const idSchema = z.coerce.number().int().positive();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const departmentSchema = z.object({ name: z.string().trim().min(2).max(120) });
const employeeSchema = z.object({
  userId: idSchema.nullable().optional(),
  departmentId: idSchema.nullable().optional(),
  fullName: z.string().trim().min(1).max(200),
  jobTitle: z.string().trim().max(120).nullable().optional(),
  employmentStatus: z.enum(['active', 'on_leave', 'terminated']).default('active'),
  hireDate: dateSchema.nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
});
const shiftSchema = z.object({
  name: z.string().trim().min(2).max(100),
  startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  endTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
});
const rosterSchema = z.object({
  employeeId: idSchema,
  shiftId: idSchema,
  date: dateSchema,
});
const leaveSchema = z.object({
  type: z.string().trim().min(2).max(60),
  dateFrom: dateSchema,
  dateTo: dateSchema,
  reason: z.string().trim().min(3).max(2000),
});
const leaveDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().max(2000).optional(),
});
const handoverSchema = z.object({
  departmentId: idSchema,
  title: z.string().trim().min(3).max(160),
  body: z.string().trim().min(3).max(10000),
});

function httpError(status, code, message, details) {
  return Object.assign(new Error(message), { status, code, details });
}

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw Object.assign(new Error('Request validation failed'), {
      status: 400,
      code: 'VALIDATION_ERROR',
      details: result.error.issues,
    });
  }
  return result.data;
}

function asDate(value) {
  if (!dateSchema.safeParse(value).success) throw httpError(400, 'INVALID_DATE', 'Dates must use YYYY-MM-DD');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw httpError(400, 'INVALID_DATE', 'Provide a valid calendar date');
  }
  return date;
}

function validateRange(from, to, maximumDays = 92) {
  const start = asDate(from);
  const end = asDate(to);
  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days < 1 || days > maximumDays) {
    throw httpError(400, 'INVALID_DATE_RANGE', `Date range must include 1 to ${maximumDays} days`);
  }
  return days;
}

function dateInPropertyTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function timeMinutes(value) {
  const [hour, minute] = String(value).split(':').map(Number);
  return (hour * 60) + minute;
}

function shiftDuration(startTime, endTime) {
  const start = timeMinutes(startTime);
  let end = timeMinutes(endTime);
  if (end <= start) end += 1440;
  return end - start;
}

function shiftInterval(date, startTime, endTime) {
  const dateValue = asDate(date);
  const start = dateValue.getTime() + timeMinutes(startTime) * 60_000;
  let end = dateValue.getTime() + timeMinutes(endTime) * 60_000;
  if (end <= start) end += 86_400_000;
  return [start, end];
}

function csvValue(value) {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function failureResponse(error, _req, res, next) {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) {
    logger.error({ err: error }, 'Staff API request failed');
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'The staff request could not be completed' },
    });
  }
  return res.status(status).json({
    error: {
      code: error.code ?? 'STAFF_ERROR',
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  });
}

async function employeeForUser(connection, propertyId, userId, lock = false) {
  const [rows] = await connection.execute(
    `SELECT employee.id, employee.department_id, employee.full_name, employee.employment_status
     FROM employees employee
     WHERE employee.property_id = ? AND employee.user_id = ? AND employee.deleted_at IS NULL
     LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [propertyId, userId],
  );
  return rows[0] ?? null;
}

async function verifyDepartment(connection, propertyId, departmentId) {
  if (!departmentId) return;
  const [rows] = await connection.execute(
    'SELECT id FROM departments WHERE property_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1',
    [propertyId, departmentId],
  );
  if (!rows[0]) throw httpError(400, 'INVALID_DEPARTMENT', 'Choose a department in the active property');
}

async function verifyEmployee(connection, propertyId, employeeId, { active = false } = {}) {
  const [rows] = await connection.execute(
    `SELECT id, full_name, user_id, department_id, employment_status
     FROM employees WHERE property_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1`,
    [propertyId, employeeId],
  );
  if (!rows[0]) throw httpError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
  if (active && rows[0].employment_status !== 'active') {
    throw httpError(409, 'EMPLOYEE_INACTIVE', 'Only active employees can be scheduled');
  }
  return rows[0];
}

async function findShiftConflict(connection, propertyId, employeeId, shiftId, date) {
  const [targetRows] = await connection.execute(
    'SELECT start_time, end_time FROM shifts WHERE property_id = ? AND id = ? LIMIT 1',
    [propertyId, shiftId],
  );
  if (!targetRows[0]) throw httpError(404, 'SHIFT_NOT_FOUND', 'Shift not found');
  const target = shiftInterval(date, targetRows[0].start_time, targetRows[0].end_time);
  const previousDate = new Date(asDate(date).getTime() - 86_400_000).toISOString().slice(0, 10);
  const nextDate = new Date(asDate(date).getTime() + 86_400_000).toISOString().slice(0, 10);
  const [assignments] = await connection.execute(
    `SELECT assignment.id, assignment.date, shift.name AS shift_name, shift.start_time, shift.end_time
     FROM shift_assignments assignment
     JOIN shifts shift ON shift.id = assignment.shift_id AND shift.property_id = assignment.property_id
     WHERE assignment.property_id = ? AND assignment.employee_id = ?
       AND assignment.date BETWEEN ? AND ?`,
    [propertyId, employeeId, previousDate, nextDate],
  );
  const conflict = assignments.find((assignment) => {
    const existing = shiftInterval(String(assignment.date).slice(0, 10), assignment.start_time, assignment.end_time);
    return target[0] < existing[1] && existing[0] < target[1];
  });
  return conflict ?? null;
}

export function createStaffRouter(db) {
  const router = Router();
  router.use(authenticate(db), propertyScope(db));
  const manager = requirePermission(db, 'staff.manage');
  const selfService = requireAnyPermission(db, ['staff.manage', 'staff.self_service']);

  router.get('/staff/me', selfService, async (req, res, next) => {
    try {
      const [employees] = await db.execute(
        `SELECT employee.id, employee.full_name, employee.job_title, employee.employment_status,
                employee.department_id, department.name AS department_name
         FROM employees employee
         LEFT JOIN departments department
           ON department.id = employee.department_id AND department.property_id = employee.property_id
         WHERE employee.property_id = ? AND employee.user_id = ? AND employee.deleted_at IS NULL LIMIT 1`,
        [req.propertyId, req.auth.sub],
      );
      if (!employees[0]) throw httpError(404, 'EMPLOYEE_PROFILE_NOT_FOUND', 'Ask a property manager to link your staff profile');
      const employee = employees[0];
      const [propertyRows] = await db.execute(
        'SELECT business_date, timezone FROM properties WHERE id = ? LIMIT 1',
        [req.propertyId],
      );
      const date = dateInPropertyTimezone(new Date(), propertyRows[0].timezone);
      const [roster] = await db.execute(
        `SELECT assignment.id, assignment.date, shift.id AS shift_id, shift.name AS shift_name,
                shift.start_time, shift.end_time
         FROM shift_assignments assignment
         JOIN shifts shift ON shift.id = assignment.shift_id AND shift.property_id = assignment.property_id
         WHERE assignment.property_id = ? AND assignment.employee_id = ?
           AND assignment.date BETWEEN ? AND DATE_ADD(?, INTERVAL 13 DAY)
         ORDER BY assignment.date, shift.start_time`,
        [req.propertyId, employee.id, date, date],
      );
      const [attendance] = await db.execute(
        `SELECT id, date, clock_in, clock_out, overtime_minutes, source
         FROM attendance WHERE property_id = ? AND employee_id = ? AND date = ? LIMIT 1`,
        [req.propertyId, employee.id, date],
      );
      const [leave] = await db.execute(
        `SELECT id, type, date_from, date_to, status, reason
         FROM leave_requests
         WHERE property_id = ? AND employee_id = ? AND status IN ('pending', 'approved')
           AND date_to >= ? ORDER BY date_from LIMIT 10`,
        [req.propertyId, employee.id, date],
      );
      return res.json({ data: {
        id: Number(employee.id),
        fullName: employee.full_name,
        jobTitle: employee.job_title,
        employmentStatus: employee.employment_status,
        departmentId: employee.department_id === null ? null : Number(employee.department_id),
        departmentName: employee.department_name,
        date,
        roster: roster.map((row) => ({
          id: Number(row.id),
          date: String(row.date).slice(0, 10),
          shiftId: Number(row.shift_id),
          shiftName: row.shift_name,
          startTime: row.start_time,
          endTime: row.end_time,
        })),
        attendance: attendance[0] ? {
          id: Number(attendance[0].id),
          clockIn: attendance[0].clock_in,
          clockOut: attendance[0].clock_out,
          overtimeMinutes: Number(attendance[0].overtime_minutes),
          source: attendance[0].source,
        } : null,
        leaveRequests: leave.map((row) => ({
          id: Number(row.id),
          type: row.type,
          dateFrom: String(row.date_from).slice(0, 10),
          dateTo: String(row.date_to).slice(0, 10),
          status: row.status,
          reason: row.reason,
        })),
      } });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/staff/departments', manager, async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT department.id, department.name, department.deleted_at,
                COUNT(employee.id) AS employee_count
         FROM departments department
         LEFT JOIN employees employee ON employee.department_id = department.id
           AND employee.property_id = department.property_id AND employee.deleted_at IS NULL
         WHERE department.property_id = ? AND department.deleted_at IS NULL
         GROUP BY department.id, department.name, department.deleted_at
         ORDER BY department.name`,
        [req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id), name: row.name, employeeCount: Number(row.employee_count),
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/staff/departments', manager, async (req, res, next) => {
    let connection;
    try {
      const data = parse(departmentSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [existing] = await connection.execute(
        'SELECT id FROM departments WHERE property_id = ? AND LOWER(name) = LOWER(?) AND deleted_at IS NULL LIMIT 1',
        [req.propertyId, data.name],
      );
      if (existing[0]) throw httpError(409, 'DEPARTMENT_EXISTS', 'A department with this name already exists');
      const [insert] = await connection.execute(
        'INSERT INTO departments (property_id, name) VALUES (?, ?)',
        [req.propertyId, data.name],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'staff.department_created', entity: 'department', entityId: insert.insertId, after: data,
      });
      await connection.commit();
      return res.status(201).json({ data: { id: Number(insert.insertId), ...data } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.put('/staff/departments/:id', manager, async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      const data = parse(departmentSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [departments] = await connection.execute(
        'SELECT id, name FROM departments WHERE property_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE',
        [req.propertyId, id],
      );
      if (!departments[0]) throw httpError(404, 'DEPARTMENT_NOT_FOUND', 'Department not found');
      const [duplicate] = await connection.execute(
        'SELECT id FROM departments WHERE property_id = ? AND id <> ? AND LOWER(name) = LOWER(?) AND deleted_at IS NULL LIMIT 1',
        [req.propertyId, id, data.name],
      );
      if (duplicate[0]) throw httpError(409, 'DEPARTMENT_EXISTS', 'A department with this name already exists');
      await connection.execute('UPDATE departments SET name = ? WHERE property_id = ? AND id = ?', [data.name, req.propertyId, id]);
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'staff.department_updated', entity: 'department', entityId: id, before: departments[0], after: data,
      });
      await connection.commit();
      return res.json({ data: { id, ...data } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.delete('/staff/departments/:id', manager, async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [departments] = await connection.execute(
        'SELECT id, name FROM departments WHERE property_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE',
        [req.propertyId, id],
      );
      if (!departments[0]) throw httpError(404, 'DEPARTMENT_NOT_FOUND', 'Department not found');
      const [employees] = await connection.execute(
        'SELECT id FROM employees WHERE property_id = ? AND department_id = ? AND deleted_at IS NULL LIMIT 1',
        [req.propertyId, id],
      );
      if (employees[0]) throw httpError(409, 'DEPARTMENT_IN_USE', 'Move or archive assigned employees before archiving this department');
      const [handovers] = await connection.execute(
        'SELECT id FROM handover_notes WHERE property_id = ? AND department_id = ? LIMIT 1',
        [req.propertyId, id],
      );
      if (handovers[0]) throw httpError(409, 'DEPARTMENT_HAS_HANDOVERS', 'Departments with handover history cannot be archived');
      await connection.execute(
        'UPDATE departments SET deleted_at = UTC_TIMESTAMP() WHERE property_id = ? AND id = ?',
        [req.propertyId, id],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'staff.department_archived', entity: 'department', entityId: id, before: departments[0], after: { archived: true },
      });
      await connection.commit();
      return res.status(204).end();
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.get('/staff/employees', manager, async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT employee.id, employee.user_id, employee.full_name, employee.department_id,
                department.name AS department_name, employee.job_title, employee.employment_status,
                employee.hire_date, employee.phone, user.email, employee.created_at
         FROM employees employee
         LEFT JOIN departments department
           ON department.id = employee.department_id AND department.property_id = employee.property_id
         LEFT JOIN users user ON user.id = employee.user_id
         WHERE employee.property_id = ? AND employee.deleted_at IS NULL
         ORDER BY employee.full_name, employee.id`,
        [req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id),
        userId: row.user_id === null ? null : Number(row.user_id),
        fullName: row.full_name,
        departmentId: row.department_id === null ? null : Number(row.department_id),
        departmentName: row.department_name,
        jobTitle: row.job_title,
        employmentStatus: row.employment_status,
        hireDate: row.hire_date === null ? null : String(row.hire_date).slice(0, 10),
        phone: row.phone,
        email: row.email,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/staff/employees', manager, async (req, res, next) => {
    let connection;
    try {
      const data = parse(employeeSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      await verifyDepartment(connection, req.propertyId, data.departmentId ?? null);
      if (data.userId) {
        const [memberships] = await connection.execute(
          `SELECT user.id FROM users user
           JOIN user_properties membership ON membership.user_id = user.id AND membership.property_id = ?
           WHERE user.id = ? AND user.is_active = 1 LIMIT 1`,
          [req.propertyId, data.userId],
        );
        if (!memberships[0]) throw httpError(400, 'INVALID_USER_LINK', 'Linked user must be active and assigned to this property');
        const [existing] = await connection.execute(
          'SELECT id FROM employees WHERE property_id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1',
          [req.propertyId, data.userId],
        );
        if (existing[0]) throw httpError(409, 'EMPLOYEE_USER_EXISTS', 'This user is already linked to a staff profile');
      }
      const [insert] = await connection.execute(
        `INSERT INTO employees
          (property_id, user_id, full_name, department_id, job_title, employment_status, hire_date, phone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.propertyId, data.userId ?? null, data.fullName, data.departmentId ?? null,
          data.jobTitle ?? null, data.employmentStatus, data.hireDate ?? null, data.phone ?? null,
        ],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'staff.employee_created', entity: 'employee', entityId: insert.insertId, after: data,
      });
      await connection.commit();
      return res.status(201).json({ data: { id: Number(insert.insertId), ...data } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.put('/staff/employees/:id', manager, async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      const data = parse(employeeSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [employees] = await connection.execute(
        `SELECT id, user_id, full_name, department_id, job_title, employment_status, hire_date, phone
         FROM employees WHERE property_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE`,
        [req.propertyId, id],
      );
      if (!employees[0]) throw httpError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
      await verifyDepartment(connection, req.propertyId, data.departmentId ?? null);
      if (data.userId) {
        const [memberships] = await connection.execute(
          `SELECT user.id FROM users user
           JOIN user_properties membership ON membership.user_id = user.id AND membership.property_id = ?
           WHERE user.id = ? AND user.is_active = 1 LIMIT 1`,
          [req.propertyId, data.userId],
        );
        if (!memberships[0]) throw httpError(400, 'INVALID_USER_LINK', 'Linked user must be active and assigned to this property');
        const [existing] = await connection.execute(
          'SELECT id FROM employees WHERE property_id = ? AND user_id = ? AND id <> ? AND deleted_at IS NULL LIMIT 1',
          [req.propertyId, data.userId, id],
        );
        if (existing[0]) throw httpError(409, 'EMPLOYEE_USER_EXISTS', 'This user is already linked to a staff profile');
      }
      if (data.employmentStatus === 'terminated') {
        const [future] = await connection.execute(
          'SELECT id FROM shift_assignments WHERE property_id = ? AND employee_id = ? AND date >= CURDATE() LIMIT 1',
          [req.propertyId, id],
        );
        if (future[0]) throw httpError(409, 'EMPLOYEE_HAS_FUTURE_SHIFTS', 'Remove future roster assignments before terminating this employee');
      }
      await connection.execute(
        `UPDATE employees SET user_id = ?, full_name = ?, department_id = ?, job_title = ?,
                employment_status = ?, hire_date = ?, phone = ?
         WHERE property_id = ? AND id = ?`,
        [
          data.userId ?? null, data.fullName, data.departmentId ?? null, data.jobTitle ?? null,
          data.employmentStatus, data.hireDate ?? null, data.phone ?? null, req.propertyId, id,
        ],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'staff.employee_updated', entity: 'employee', entityId: id, before: employees[0], after: data,
      });
      await connection.commit();
      return res.json({ data: { id, ...data } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.get('/staff/shifts', manager, async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        'SELECT id, name, start_time, end_time FROM shifts WHERE property_id = ? ORDER BY name',
        [req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id), name: row.name, startTime: row.start_time, endTime: row.end_time,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/staff/shifts', manager, async (req, res, next) => {
    let connection;
    try {
      const data = parse(shiftSchema, req.body);
      if (data.startTime === data.endTime) throw httpError(400, 'INVALID_SHIFT_DURATION', 'Shift start and end times cannot be equal');
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [existing] = await connection.execute(
        'SELECT id FROM shifts WHERE property_id = ? AND LOWER(name) = LOWER(?) LIMIT 1',
        [req.propertyId, data.name],
      );
      if (existing[0]) throw httpError(409, 'SHIFT_EXISTS', 'A shift with this name already exists');
      const [insert] = await connection.execute(
        'INSERT INTO shifts (property_id, name, start_time, end_time) VALUES (?, ?, ?, ?)',
        [req.propertyId, data.name, `${data.startTime}:00`, `${data.endTime}:00`],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'staff.shift_created', entity: 'shift', entityId: insert.insertId,
        after: { ...data, durationMinutes: shiftDuration(data.startTime, data.endTime) },
      });
      await connection.commit();
      return res.status(201).json({ data: { id: Number(insert.insertId), ...data } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.put('/staff/shifts/:id', manager, async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      const data = parse(shiftSchema, req.body);
      if (data.startTime === data.endTime) throw httpError(400, 'INVALID_SHIFT_DURATION', 'Shift start and end times cannot be equal');
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [shifts] = await connection.execute(
        'SELECT id, name, start_time, end_time FROM shifts WHERE property_id = ? AND id = ? FOR UPDATE',
        [req.propertyId, id],
      );
      if (!shifts[0]) throw httpError(404, 'SHIFT_NOT_FOUND', 'Shift not found');
      const [duplicate] = await connection.execute(
        'SELECT id FROM shifts WHERE property_id = ? AND id <> ? AND LOWER(name) = LOWER(?) LIMIT 1',
        [req.propertyId, id, data.name],
      );
      if (duplicate[0]) throw httpError(409, 'SHIFT_EXISTS', 'A shift with this name already exists');
      const [assignments] = await connection.execute(
        'SELECT id FROM shift_assignments WHERE property_id = ? AND shift_id = ? LIMIT 1',
        [req.propertyId, id],
      );
      if (assignments[0]) throw httpError(409, 'SHIFT_IN_USE', 'Shifts with roster assignments cannot be changed');
      await connection.execute(
        'UPDATE shifts SET name = ?, start_time = ?, end_time = ? WHERE property_id = ? AND id = ?',
        [data.name, `${data.startTime}:00`, `${data.endTime}:00`, req.propertyId, id],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'staff.shift_updated', entity: 'shift', entityId: id, before: shifts[0],
        after: { ...data, durationMinutes: shiftDuration(data.startTime, data.endTime) },
      });
      await connection.commit();
      return res.json({ data: { id, ...data } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.delete('/staff/shifts/:id', manager, async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [shifts] = await connection.execute(
        'SELECT id, name, start_time, end_time FROM shifts WHERE property_id = ? AND id = ? FOR UPDATE',
        [req.propertyId, id],
      );
      if (!shifts[0]) throw httpError(404, 'SHIFT_NOT_FOUND', 'Shift not found');
      const [assignments] = await connection.execute(
        'SELECT id FROM shift_assignments WHERE property_id = ? AND shift_id = ? LIMIT 1',
        [req.propertyId, id],
      );
      if (assignments[0]) throw httpError(409, 'SHIFT_IN_USE', 'Remove roster assignments before deleting this shift');
      await connection.execute('DELETE FROM shifts WHERE property_id = ? AND id = ?', [req.propertyId, id]);
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'staff.shift_deleted', entity: 'shift', entityId: id, before: shifts[0], after: { deleted: true },
      });
      await connection.commit();
      return res.status(204).end();
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.get('/staff/roster', manager, async (req, res, next) => {
    try {
      const from = String(req.query.from ?? '');
      const to = String(req.query.to ?? '');
      validateRange(from, to);
      const [rows] = await db.execute(
        `SELECT assignment.id, assignment.employee_id, employee.full_name,
                employee.department_id, department.name AS department_name,
                assignment.shift_id, shift.name AS shift_name, shift.start_time,
                shift.end_time, assignment.date
         FROM shift_assignments assignment
         JOIN employees employee ON employee.id = assignment.employee_id AND employee.property_id = assignment.property_id
         JOIN shifts shift ON shift.id = assignment.shift_id AND shift.property_id = assignment.property_id
         LEFT JOIN departments department ON department.id = employee.department_id
           AND department.property_id = employee.property_id
         WHERE assignment.property_id = ? AND assignment.date BETWEEN ? AND ?
         ORDER BY assignment.date, shift.start_time, employee.full_name`,
        [req.propertyId, from, to],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id), employeeId: Number(row.employee_id), employeeName: row.full_name,
        departmentId: row.department_id === null ? null : Number(row.department_id),
        departmentName: row.department_name, shiftId: Number(row.shift_id), shiftName: row.shift_name,
        startTime: row.start_time, endTime: row.end_time, date: String(row.date).slice(0, 10),
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/staff/roster', manager, async (req, res, next) => {
    let connection;
    try {
      const data = parse(rosterSchema, req.body);
      asDate(data.date);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [employees] = await connection.execute(
        `SELECT id, employment_status FROM employees
         WHERE property_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE`,
        [req.propertyId, data.employeeId],
      );
      if (!employees[0]) throw httpError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
      if (employees[0].employment_status !== 'active') throw httpError(409, 'EMPLOYEE_INACTIVE', 'Only active employees can be scheduled');
      const [shifts] = await connection.execute(
        'SELECT id, name FROM shifts WHERE property_id = ? AND id = ? LIMIT 1',
        [req.propertyId, data.shiftId],
      );
      if (!shifts[0]) throw httpError(404, 'SHIFT_NOT_FOUND', 'Shift not found');
      const [leave] = await connection.execute(
        `SELECT id FROM leave_requests
         WHERE property_id = ? AND employee_id = ? AND status = 'approved'
           AND date_from <= ? AND date_to >= ? LIMIT 1`,
        [req.propertyId, data.employeeId, data.date, data.date],
      );
      if (leave[0]) throw httpError(409, 'EMPLOYEE_ON_LEAVE', 'Employee has approved leave on this date');
      const conflict = await findShiftConflict(connection, req.propertyId, data.employeeId, data.shiftId, data.date);
      if (conflict) {
        throw httpError(409, 'SHIFT_CONFLICT', `This shift overlaps ${conflict.shift_name} on ${String(conflict.date).slice(0, 10)}`, {
          assignmentId: Number(conflict.id), date: String(conflict.date).slice(0, 10),
        });
      }
      const [insert] = await connection.execute(
        'INSERT INTO shift_assignments (property_id, employee_id, shift_id, date) VALUES (?, ?, ?, ?)',
        [req.propertyId, data.employeeId, data.shiftId, data.date],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'staff.roster_assigned', entity: 'shift_assignment', entityId: insert.insertId, after: data,
      });
      await connection.commit();
      return res.status(201).json({ data: { id: Number(insert.insertId), ...data } });
    } catch (error) {
      if (connection) await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') return next(httpError(409, 'SHIFT_CONFLICT', 'The employee already has a shift assigned on this date'));
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.delete('/staff/roster/:id', manager, async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [assignments] = await connection.execute(
        `SELECT assignment.id, assignment.employee_id, assignment.shift_id, assignment.date,
                employee.full_name, shift.name AS shift_name
         FROM shift_assignments assignment
         JOIN employees employee ON employee.id = assignment.employee_id AND employee.property_id = assignment.property_id
         JOIN shifts shift ON shift.id = assignment.shift_id AND shift.property_id = assignment.property_id
         WHERE assignment.property_id = ? AND assignment.id = ? FOR UPDATE`,
        [req.propertyId, id],
      );
      if (!assignments[0]) throw httpError(404, 'ROSTER_ASSIGNMENT_NOT_FOUND', 'Roster assignment not found');
      const [attendance] = await connection.execute(
        'SELECT id FROM attendance WHERE property_id = ? AND shift_assignment_id = ? LIMIT 1',
        [req.propertyId, id],
      );
      if (attendance[0]) throw httpError(409, 'ROSTER_HAS_ATTENDANCE', 'Keep roster entries with recorded attendance');
      await connection.execute('DELETE FROM shift_assignments WHERE property_id = ? AND id = ?', [req.propertyId, id]);
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'staff.roster_removed', entity: 'shift_assignment', entityId: id,
        before: assignments[0], after: { removed: true },
      });
      await connection.commit();
      return res.status(204).end();
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.get('/staff/attendance', manager, async (req, res, next) => {
    try {
      const from = String(req.query.from ?? '');
      const to = String(req.query.to ?? '');
      validateRange(from, to);
      const [rows] = await db.execute(
        `SELECT attendance.id, attendance.employee_id, employee.full_name,
                department.name AS department_name, attendance.date, attendance.clock_in,
                attendance.clock_out, attendance.overtime_minutes, attendance.source,
                shift.name AS shift_name, shift.start_time, shift.end_time
         FROM attendance
         JOIN employees employee ON employee.id = attendance.employee_id AND employee.property_id = attendance.property_id
         LEFT JOIN departments department ON department.id = employee.department_id
           AND department.property_id = employee.property_id
         LEFT JOIN shift_assignments assignment ON assignment.id = attendance.shift_assignment_id
           AND assignment.property_id = attendance.property_id
         LEFT JOIN shifts shift ON shift.id = assignment.shift_id AND shift.property_id = assignment.property_id
         WHERE attendance.property_id = ? AND attendance.date BETWEEN ? AND ?
         ORDER BY attendance.date DESC, employee.full_name`,
        [req.propertyId, from, to],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id), employeeId: Number(row.employee_id), employeeName: row.full_name,
        departmentName: row.department_name, date: String(row.date).slice(0, 10),
        clockIn: row.clock_in, clockOut: row.clock_out, overtimeMinutes: Number(row.overtime_minutes),
        source: row.source, shiftName: row.shift_name, shiftStart: row.start_time, shiftEnd: row.end_time,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/staff/attendance/clock-in', selfService, async (req, res, next) => {
    let connection;
    try {
      connection = await db.getConnection();
      await connection.beginTransaction();
      const employee = await employeeForUser(connection, req.propertyId, req.auth.sub, true);
      if (!employee) throw httpError(404, 'EMPLOYEE_PROFILE_NOT_FOUND', 'Ask a property manager to link your staff profile');
      if (employee.employment_status !== 'active') throw httpError(409, 'EMPLOYEE_INACTIVE', 'Only active employees can clock in');
      const [properties] = await connection.execute(
        'SELECT timezone FROM properties WHERE id = ? LIMIT 1',
        [req.propertyId],
      );
      const date = dateInPropertyTimezone(new Date(), properties[0].timezone);
      const previousDate = new Date(asDate(date).getTime() - 86_400_000).toISOString().slice(0, 10);
      const [existing] = await connection.execute(
        `SELECT id FROM attendance
         WHERE property_id = ? AND employee_id = ?
           AND (date = ? OR (date = ? AND clock_out IS NULL))
         FOR UPDATE`,
        [req.propertyId, employee.id, date, previousDate],
      );
      if (existing[0]) throw httpError(409, 'ALREADY_CLOCKED_IN', 'Attendance is already recorded for today');
      const [roster] = await connection.execute(
        `SELECT id FROM shift_assignments WHERE property_id = ? AND employee_id = ? AND date = ? LIMIT 1`,
        [req.propertyId, employee.id, date],
      );
      const [insert] = await connection.execute(
        `INSERT INTO attendance
          (property_id, employee_id, shift_assignment_id, date, clock_in, overtime_minutes, source)
         VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), 0, 'self_service')`,
        [req.propertyId, employee.id, roster[0]?.id ?? null, date],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'staff.attendance_clocked_in', entity: 'attendance', entityId: insert.insertId,
        after: { employeeId: Number(employee.id), date, shiftAssignmentId: roster[0] ? Number(roster[0].id) : null },
      });
      await connection.commit();
      return res.status(201).json({ data: { id: Number(insert.insertId), date, clockIn: new Date().toISOString() } });
    } catch (error) {
      if (connection) await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') return next(httpError(409, 'ALREADY_CLOCKED_IN', 'Attendance is already recorded for today'));
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/staff/attendance/clock-out', selfService, async (req, res, next) => {
    let connection;
    try {
      connection = await db.getConnection();
      await connection.beginTransaction();
      const employee = await employeeForUser(connection, req.propertyId, req.auth.sub, true);
      if (!employee) throw httpError(404, 'EMPLOYEE_PROFILE_NOT_FOUND', 'Ask a property manager to link your staff profile');
      const [properties] = await connection.execute(
        'SELECT timezone FROM properties WHERE id = ? LIMIT 1',
        [req.propertyId],
      );
      const date = dateInPropertyTimezone(new Date(), properties[0].timezone);
      const previousDate = new Date(asDate(date).getTime() - 86_400_000).toISOString().slice(0, 10);
      const [attendanceRows] = await connection.execute(
        `SELECT attendance.id, attendance.date, attendance.clock_in, attendance.clock_out,
                shift.start_time, shift.end_time
         FROM attendance
         LEFT JOIN shift_assignments assignment ON assignment.id = attendance.shift_assignment_id
           AND assignment.property_id = attendance.property_id
         LEFT JOIN shifts shift ON shift.id = assignment.shift_id AND shift.property_id = assignment.property_id
         WHERE attendance.property_id = ? AND attendance.employee_id = ?
           AND attendance.date BETWEEN ? AND ? AND attendance.clock_out IS NULL
         ORDER BY attendance.date DESC LIMIT 1 FOR UPDATE`,
        [req.propertyId, employee.id, previousDate, date],
      );
      const attendance = attendanceRows[0];
      if (!attendance) throw httpError(404, 'ATTENDANCE_NOT_FOUND', 'Clock in before clocking out');
      if (attendance.clock_out) throw httpError(409, 'ALREADY_CLOCKED_OUT', 'Attendance is already closed for today');
      const [elapsedRows] = await connection.execute(
        'SELECT GREATEST(0, TIMESTAMPDIFF(MINUTE, ?, UTC_TIMESTAMP())) AS elapsed_minutes',
        [attendance.clock_in],
      );
      const elapsedMinutes = Number(elapsedRows[0].elapsed_minutes);
      const overtimeMinutes = attendance.start_time && attendance.end_time
        ? Math.max(0, elapsedMinutes - shiftDuration(attendance.start_time, attendance.end_time))
        : 0;
      await connection.execute(
        `UPDATE attendance SET clock_out = UTC_TIMESTAMP(), overtime_minutes = ?
         WHERE property_id = ? AND id = ?`,
        [overtimeMinutes, req.propertyId, attendance.id],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'staff.attendance_clocked_out', entity: 'attendance', entityId: attendance.id,
        before: { clockOut: null },
        after: { employeeId: Number(employee.id), date, overtimeMinutes },
      });
      await connection.commit();
      return res.json({ data: { id: Number(attendance.id), date, overtimeMinutes, clockOut: new Date().toISOString() } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.get('/staff/leave', selfService, async (req, res, next) => {
    try {
      const managed = (await getRolePermissions(db, req.auth.roleId)).includes('staff.manage');
      const employee = managed ? null : await employeeForUser(db, req.propertyId, req.auth.sub);
      if (!managed && !employee) throw httpError(404, 'EMPLOYEE_PROFILE_NOT_FOUND', 'Ask a property manager to link your staff profile');
      const [rows] = await db.execute(
        `SELECT leave_request.id, leave_request.employee_id, employee.full_name,
                leave_request.type, leave_request.date_from, leave_request.date_to,
                leave_request.status, leave_request.reason, leave_request.approved_by,
                reviewer.name AS reviewer_name, leave_request.reviewed_at
         FROM leave_requests leave_request
         JOIN employees employee ON employee.id = leave_request.employee_id
           AND employee.property_id = leave_request.property_id
         LEFT JOIN users reviewer ON reviewer.id = leave_request.approved_by
         WHERE leave_request.property_id = ? AND (? IS NULL OR leave_request.employee_id = ?)
         ORDER BY leave_request.created_at DESC, leave_request.id DESC LIMIT 300`,
        [req.propertyId, managed ? null : employee.id, managed ? null : employee.id],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id), employeeId: Number(row.employee_id), employeeName: row.full_name,
        type: row.type, dateFrom: String(row.date_from).slice(0, 10), dateTo: String(row.date_to).slice(0, 10),
        status: row.status, reason: row.reason, reviewedBy: row.reviewer_name, reviewedAt: row.reviewed_at,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/staff/leave', selfService, async (req, res, next) => {
    let connection;
    try {
      const data = parse(leaveSchema, req.body);
      validateRange(data.dateFrom, data.dateTo, 366);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const employee = await employeeForUser(connection, req.propertyId, req.auth.sub, true);
      if (!employee) throw httpError(404, 'EMPLOYEE_PROFILE_NOT_FOUND', 'Ask a property manager to link your staff profile');
      if (employee.employment_status === 'terminated') throw httpError(409, 'EMPLOYEE_INACTIVE', 'Former employees cannot request leave');
      const [overlaps] = await connection.execute(
        `SELECT id FROM leave_requests
         WHERE property_id = ? AND employee_id = ? AND status IN ('pending', 'approved')
           AND date_from <= ? AND date_to >= ? LIMIT 1`,
        [req.propertyId, employee.id, data.dateTo, data.dateFrom],
      );
      if (overlaps[0]) throw httpError(409, 'LEAVE_OVERLAP', 'This request overlaps an existing pending or approved leave request');
      const [insert] = await connection.execute(
        `INSERT INTO leave_requests
          (property_id, employee_id, type, date_from, date_to, status, approved_by, reason)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?)`,
        [req.propertyId, employee.id, data.type, data.dateFrom, data.dateTo, data.reason],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'staff.leave_requested', entity: 'leave_request', entityId: insert.insertId,
        after: { employeeId: Number(employee.id), ...data },
      });
      await connection.commit();
      return res.status(201).json({ data: { id: Number(insert.insertId), status: 'pending' } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.patch('/staff/leave/:id/decision', manager, async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      const data = parse(leaveDecisionSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [leaveRows] = await connection.execute(
        `SELECT id, employee_id, type, date_from, date_to, status, reason
         FROM leave_requests WHERE property_id = ? AND id = ? FOR UPDATE`,
        [req.propertyId, id],
      );
      const leave = leaveRows[0];
      if (!leave) throw httpError(404, 'LEAVE_NOT_FOUND', 'Leave request not found');
      if (leave.status !== 'pending') throw httpError(409, 'LEAVE_ALREADY_REVIEWED', 'This leave request was already reviewed');
      if (data.decision === 'approved') {
        await verifyEmployee(connection, req.propertyId, leave.employee_id);
        await connection.execute(
          'SELECT id FROM employees WHERE property_id = ? AND id = ? FOR UPDATE',
          [req.propertyId, leave.employee_id],
        );
        const [assignments] = await connection.execute(
          `SELECT assignment.id FROM shift_assignments assignment
           WHERE assignment.property_id = ? AND assignment.employee_id = ?
             AND assignment.date BETWEEN ? AND ? LIMIT 1`,
          [req.propertyId, leave.employee_id, leave.date_from, leave.date_to],
        );
        if (assignments[0]) throw httpError(409, 'ROSTER_CONFLICT', 'Remove roster assignments before approving this leave');
      }
      await connection.execute(
        `UPDATE leave_requests SET status = ?, approved_by = ?, reviewed_at = UTC_TIMESTAMP()
         WHERE property_id = ? AND id = ?`,
        [data.decision, req.auth.sub, req.propertyId, id],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: `staff.leave_${data.decision}`, entity: 'leave_request', entityId: id,
        before: { status: leave.status },
        after: { status: data.decision, reason: data.reason ?? null },
      });
      await connection.commit();
      return res.json({ data: { id, status: data.decision } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.get('/staff/handovers', selfService, async (req, res, next) => {
    try {
      const departmentId = req.query.departmentId ? parse(idSchema, req.query.departmentId) : null;
      const managed = (await getRolePermissions(db, req.auth.roleId)).includes('staff.manage');
      const employee = managed ? null : await employeeForUser(db, req.propertyId, req.auth.sub);
      if (!managed && !employee) throw httpError(404, 'EMPLOYEE_PROFILE_NOT_FOUND', 'Ask a property manager to link your staff profile');
      const ownDepartmentId = employee?.department_id === null || employee?.department_id === undefined
        ? null
        : Number(employee.department_id);
      if (!managed && !ownDepartmentId) return res.json({ data: [] });
      if (!managed && departmentId && departmentId !== ownDepartmentId) {
        throw httpError(403, 'DEPARTMENT_FORBIDDEN', 'You can only view your own department handovers');
      }
      const effectiveDepartmentId = managed ? departmentId : ownDepartmentId;
      const [rows] = await db.execute(
        `SELECT note.id, note.department_id, department.name AS department_name,
                note.title, note.body, note.author_id, user.name AS author_name, note.created_at
         FROM handover_notes note
         JOIN departments department ON department.id = note.department_id
           AND department.property_id = note.property_id
         JOIN users user ON user.id = note.author_id
         WHERE note.property_id = ? AND (? IS NULL OR note.department_id = ?)
         ORDER BY note.created_at DESC, note.id DESC LIMIT 300`,
        [req.propertyId, effectiveDepartmentId, effectiveDepartmentId],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id), departmentId: Number(row.department_id), departmentName: row.department_name,
        title: row.title, body: row.body, authorId: Number(row.author_id),
        authorName: row.author_name, createdAt: row.created_at,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/staff/handovers', selfService, async (req, res, next) => {
    let connection;
    try {
      const data = parse(handoverSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const permissions = await getRolePermissions(db, req.auth.roleId);
      const managed = permissions.includes('staff.manage');
      if (!managed) {
        const employee = await employeeForUser(connection, req.propertyId, req.auth.sub, true);
        if (!employee) throw httpError(404, 'EMPLOYEE_PROFILE_NOT_FOUND', 'Ask a property manager to link your staff profile');
        if (Number(employee.department_id) !== data.departmentId) {
          throw httpError(403, 'DEPARTMENT_FORBIDDEN', 'You can only add handovers to your own department');
        }
      }
      await verifyDepartment(connection, req.propertyId, data.departmentId);
      const [insert] = await connection.execute(
        `INSERT INTO handover_notes (property_id, department_id, author_id, title, body)
         VALUES (?, ?, ?, ?, ?)`,
        [req.propertyId, data.departmentId, req.auth.sub, data.title, data.body],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'staff.handover_created', entity: 'handover_note', entityId: insert.insertId,
        after: { departmentId: data.departmentId, title: data.title },
      });
      await connection.commit();
      return res.status(201).json({ data: { id: Number(insert.insertId), ...data } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.get('/staff/export.csv', manager, async (req, res, next) => {
    try {
      const from = String(req.query.from ?? '');
      const to = String(req.query.to ?? '');
      validateRange(from, to, 92);
      const [rows] = await db.execute(
        `SELECT attendance.date, employee.full_name, department.name AS department_name,
                employee.job_title, shift.name AS shift_name, shift.start_time, shift.end_time,
                attendance.clock_in, attendance.clock_out, attendance.overtime_minutes, attendance.source
         FROM attendance
         JOIN employees employee ON employee.id = attendance.employee_id
           AND employee.property_id = attendance.property_id
         LEFT JOIN departments department ON department.id = employee.department_id
           AND department.property_id = employee.property_id
         LEFT JOIN shift_assignments assignment ON assignment.id = attendance.shift_assignment_id
           AND assignment.property_id = attendance.property_id
         LEFT JOIN shifts shift ON shift.id = assignment.shift_id AND shift.property_id = assignment.property_id
         WHERE attendance.property_id = ? AND attendance.date BETWEEN ? AND ?
         ORDER BY attendance.date, employee.full_name`,
        [req.propertyId, from, to],
      );
      const headers = [
        'date', 'employee', 'department', 'job_title', 'shift', 'shift_start',
        'shift_end', 'clock_in', 'clock_out', 'overtime_minutes', 'source',
      ];
      const csv = [
        headers.map(csvValue).join(','),
        ...rows.map((row) => [
          String(row.date).slice(0, 10), row.full_name, row.department_name, row.job_title,
          row.shift_name, row.start_time, row.end_time, row.clock_in, row.clock_out,
          Number(row.overtime_minutes), row.source,
        ].map(csvValue).join(',')),
      ].join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="staff-attendance-${from}-${to}.csv"`);
      return res.send(csv);
    } catch (error) {
      return next(error);
    }
  });

  router.all('/staff/*', (_req, res) => res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Staff route not found' },
  }));

  router.use(failureResponse);
  return router;
}
