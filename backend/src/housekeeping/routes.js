import { Router } from 'express';
import { z } from 'zod';
import { auditable } from '../auth/audit.js';
import { authenticate, propertyScope, requireAnyPermission, requirePermission } from '../auth/middleware.js';
import { getRolePermissions } from '../auth/permissions.js';
import { logger } from '../config/logger.js';
import { publishRoomStatus } from '../realtime.js';
import { createHousekeepingTask } from './tasks.js';

const idSchema = z.coerce.number().int().positive();
const taskTypes = ['checkout_clean', 'daily_clean', 'deep_clean', 'inspection', 'turndown'];
const taskSchema = z.object({
  roomId: idSchema,
  type: z.enum(taskTypes),
  priority: z.number().int().min(1).max(5).default(3),
  dueAt: z.string().datetime().nullable().optional(),
  assignedTo: idSchema.nullable().optional(),
  departmentId: idSchema.nullable().optional(),
});
const assignmentSchema = z.object({
  assignedTo: idSchema.nullable().optional(),
  departmentId: idSchema.nullable().optional(),
});
const bulkAssignmentSchema = z.object({
  taskIds: z.array(idSchema).min(1).max(100),
  assignedTo: idSchema,
});
const itemSchema = z.object({ complete: z.boolean() });
const inspectionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().min(3).max(500).optional(),
});
const issueSchema = z.object({
  category: z.string().trim().min(1).max(100),
  description: z.string().trim().min(3).max(5000),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
});
const checklistSchema = z.object({
  name: z.string().trim().min(2).max(120),
  roomTypeId: idSchema.nullable().optional(),
  items: z.array(z.object({
    label: z.string().trim().min(1).max(255),
    required: z.boolean().default(true),
  })).min(1).max(60),
});
const settingsSchema = z.object({
  skipInspection: z.boolean(),
  sameDayArrivalPriority: z.boolean(),
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

function mapTask(row) {
  return {
    id: Number(row.id),
    roomId: Number(row.room_id),
    roomNumber: row.room_number,
    roomType: row.room_type,
    type: row.type,
    priority: Number(row.priority),
    priorityReason: row.priority_reason,
    status: row.status,
    dueAt: row.due_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    assignedTo: row.assigned_to === null ? null : Number(row.assigned_to),
    assigneeName: row.assignee_name,
    departmentId: row.assigned_department_id === null ? null : Number(row.assigned_department_id),
    departmentName: row.department_name,
    isReadinessTask: Boolean(row.is_readiness_task),
    isOverdue: Boolean(row.is_overdue),
    checklist: row.checklist ?? [],
  };
}

async function taskDetail(connection, propertyId, taskId) {
  const [rows] = await connection.execute(
    `SELECT task.*, room.room_number, type.name AS room_type,
            assignee.name AS assignee_name, department.name AS department_name,
            (task.due_at IS NOT NULL AND task.due_at < UTC_TIMESTAMP()
              AND task.status NOT IN ('approved', 'rejected')) AS is_overdue
     FROM housekeeping_tasks task
     JOIN rooms room ON room.id = task.room_id AND room.property_id = task.property_id
     JOIN room_types type ON type.id = room.room_type_id AND type.property_id = room.property_id
     LEFT JOIN users assignee ON assignee.id = task.assigned_to
     LEFT JOIN departments department ON department.id = task.assigned_department_id
     WHERE task.property_id = ? AND task.id = ? LIMIT 1`,
    [propertyId, taskId],
  );
  if (!rows[0]) return null;
  const [items] = await connection.execute(
    `SELECT id, label, is_required, is_complete, completed_by, completed_at
     FROM task_checklist_items WHERE property_id = ? AND task_id = ? ORDER BY id`,
    [propertyId, taskId],
  );
  return mapTask({ ...rows[0], checklist: items.map((item) => ({
    id: Number(item.id),
    label: item.label,
    required: Boolean(item.is_required),
    complete: Boolean(item.is_complete),
    completedBy: item.completed_by === null ? null : Number(item.completed_by),
    completedAt: item.completed_at,
  })) });
}

async function setRoomStatus(connection, { propertyId, roomId, fromStatus, toStatus, actorId, reason }) {
  if (fromStatus === toStatus) return;
  await connection.execute(
    `INSERT INTO room_status_history
      (property_id, room_id, from_status, to_status, reason, changed_by, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
    [propertyId, roomId, fromStatus, toStatus, reason, actorId],
  );
  await connection.execute('SET @shms_housekeeping_transition = 1');
  try {
    await connection.execute(
      'UPDATE rooms SET status = ? WHERE property_id = ? AND id = ?',
      [toStatus, propertyId, roomId],
    );
  } finally {
    await connection.execute('SET @shms_housekeeping_transition = 0');
  }
}

function failureResponse(error, _req, res, next) {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) {
    logger.error({ err: error }, 'Housekeeping API request failed');
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'The housekeeping request could not be completed' },
    });
  }
  return res.status(status).json({
    error: {
      code: error.code ?? 'HOUSEKEEPING_ERROR',
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  });
}

export function createHousekeepingRouter(db) {
  const router = Router();
  router.use(authenticate(db), propertyScope(db));
  const viewOrWork = requireAnyPermission(db, ['housekeeping.view', 'housekeeping.work', 'checkin.perform']);

  router.get('/housekeeping/rooms', viewOrWork, async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT room.id, room.room_number, room.room_type_id, room.status, room.housekeeping_priority,
                type.name AS room_type, floor.name AS floor_name
         FROM rooms room
         JOIN room_types type ON type.id = room.room_type_id AND type.property_id = room.property_id
         LEFT JOIN floors floor ON floor.id = room.floor_id AND floor.property_id = room.property_id
         WHERE room.property_id = ? AND room.is_active = 1 AND room.deleted_at IS NULL
         ORDER BY floor.name, room.room_number`,
        [req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id),
        roomNumber: row.room_number,
        roomTypeId: Number(row.room_type_id),
        status: row.status,
        priority: Number(row.housekeeping_priority),
        roomType: row.room_type,
        floor: row.floor_name,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/housekeeping/settings', requirePermission(db, 'housekeeping.view'), async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT housekeeping_skip_inspection, housekeeping_same_day_priority
         FROM properties WHERE id = ? LIMIT 1`,
        [req.propertyId],
      );
      if (!rows[0]) throw httpError(404, 'PROPERTY_NOT_FOUND', 'Property not found');
      return res.json({ data: {
        skipInspection: Boolean(rows[0].housekeeping_skip_inspection),
        sameDayArrivalPriority: Boolean(rows[0].housekeeping_same_day_priority),
      } });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/housekeeping/settings', requirePermission(db, 'housekeeping.assign'), async (req, res, next) => {
    try {
      const data = parse(settingsSchema, req.body);
      if (data.skipInspection) {
        const permissions = await getRolePermissions(db, req.auth.roleId);
        if (!permissions.includes('housekeeping.skip_inspection')) {
          throw httpError(403, 'FORBIDDEN', 'Only an authorized property administrator can bypass inspection');
        }
      }
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const [properties] = await connection.execute(
          `SELECT housekeeping_skip_inspection, housekeeping_same_day_priority
           FROM properties WHERE id = ? FOR UPDATE`,
          [req.propertyId],
        );
        if (!properties[0]) throw httpError(404, 'PROPERTY_NOT_FOUND', 'Property not found');
        await connection.execute(
          `UPDATE properties SET housekeeping_skip_inspection = ?, housekeeping_same_day_priority = ?
           WHERE id = ?`,
          [data.skipInspection, data.sameDayArrivalPriority, req.propertyId],
        );
        await auditable(connection, {
          organizationId: req.auth.orgId,
          propertyId: req.propertyId,
          actorId: req.auth.sub,
          ip: req.ip,
          action: 'housekeeping.policy_updated',
          entity: 'property',
          entityId: req.propertyId,
          before: {
            skipInspection: Boolean(properties[0].housekeeping_skip_inspection),
            sameDayArrivalPriority: Boolean(properties[0].housekeeping_same_day_priority),
          },
          after: data,
        });
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      return res.json({ data });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/housekeeping/checklists', viewOrWork, async (req, res, next) => {
    try {
      const [templates] = await db.execute(
        `SELECT checklist.id, checklist.name, checklist.room_type_id, type.name AS room_type
         FROM housekeeping_checklists checklist
         LEFT JOIN room_types type ON type.id = checklist.room_type_id AND type.property_id = checklist.property_id
         WHERE checklist.property_id = ? AND checklist.is_active = 1 ORDER BY checklist.name`,
        [req.propertyId],
      );
      const data = [];
      for (const template of templates) {
        const [items] = await db.execute(
          `SELECT label, is_required FROM housekeeping_checklist_items
           WHERE property_id = ? AND checklist_id = ? ORDER BY sort_order, id`,
          [req.propertyId, template.id],
        );
        data.push({
          id: Number(template.id),
          name: template.name,
          roomTypeId: template.room_type_id === null ? null : Number(template.room_type_id),
          roomType: template.room_type,
          items: items.map((item) => ({ label: item.label, required: Boolean(item.is_required) })),
        });
      }
      return res.json({ data });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/housekeeping/checklists', requirePermission(db, 'housekeeping.checklist.manage'), async (req, res, next) => {
    let connection;
    try {
      const data = parse(checklistSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      if (data.roomTypeId) {
        const [roomTypes] = await connection.execute(
          'SELECT id FROM room_types WHERE property_id = ? AND id = ? AND deleted_at IS NULL',
          [req.propertyId, data.roomTypeId],
        );
        if (!roomTypes.length) throw httpError(404, 'ROOM_TYPE_NOT_FOUND', 'Room type not found');
      }
      const [insert] = await connection.execute(
        `INSERT INTO housekeeping_checklists (property_id, room_type_id, name, is_active)
         VALUES (?, ?, ?, 1)`,
        [req.propertyId, data.roomTypeId ?? null, data.name],
      );
      for (const [sortOrder, item] of data.items.entries()) {
        await connection.execute(
          `INSERT INTO housekeeping_checklist_items
            (property_id, checklist_id, label, sort_order, is_required)
           VALUES (?, ?, ?, ?, ?)`,
          [req.propertyId, insert.insertId, item.label, sortOrder, item.required],
        );
      }
      await auditable(connection, {
        organizationId: req.auth.orgId,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'housekeeping.checklist_created',
        entity: 'housekeeping_checklist',
        entityId: insert.insertId,
        after: data,
      });
      await connection.commit();
      return res.status(201).json({ data: { id: Number(insert.insertId) } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.get('/housekeeping/staff', requirePermission(db, 'housekeeping.assign'), async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT user.id, user.name, role.name AS role_name
         FROM user_properties membership
         JOIN users user ON user.id = membership.user_id AND user.is_active = 1
         JOIN roles role ON role.id = user.role_id
         WHERE membership.property_id = ? AND role.name IN ('housekeeping_staff', 'housekeeping_supervisor')
         ORDER BY role.name, user.name`,
        [req.propertyId],
      );
      const [departments] = await db.execute(
        `SELECT id, name FROM departments
         WHERE property_id = ? AND deleted_at IS NULL ORDER BY name`,
        [req.propertyId],
      );
      return res.json({ data: {
        staff: rows.map((row) => ({ id: Number(row.id), name: row.name, role: row.role_name })),
        departments: departments.map((row) => ({ id: Number(row.id), name: row.name })),
      } });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/housekeeping/tasks', viewOrWork, async (req, res, next) => {
    try {
      const permissions = await getRolePermissions(db, req.auth.roleId);
      const ownTasksOnly = permissions.includes('housekeeping.work')
        && !permissions.includes('housekeeping.assign')
        && !permissions.includes('housekeeping.inspect');
      const status = req.query.status ? String(req.query.status) : null;
      if (status && !['pending', 'assigned', 'in_progress', 'awaiting_inspection', 'approved', 'rejected'].includes(status)) {
        throw httpError(400, 'INVALID_STATUS', 'Unknown housekeeping task status');
      }
      const filters = ['task.property_id = ?'];
      const params = [req.propertyId];
      if (ownTasksOnly) {
        filters.push('task.assigned_to = ?');
        params.push(req.auth.sub);
      }
      if (status) {
        filters.push('task.status = ?');
        params.push(status);
      }
      const [rows] = await db.execute(
        `SELECT task.*, room.room_number, type.name AS room_type,
                assignee.name AS assignee_name, department.name AS department_name,
                (task.due_at IS NOT NULL AND task.due_at < UTC_TIMESTAMP()
                  AND task.status NOT IN ('approved', 'rejected')) AS is_overdue
         FROM housekeeping_tasks task
         JOIN rooms room ON room.id = task.room_id AND room.property_id = task.property_id
         JOIN room_types type ON type.id = room.room_type_id AND type.property_id = room.property_id
         LEFT JOIN users assignee ON assignee.id = task.assigned_to
         LEFT JOIN departments department ON department.id = task.assigned_department_id
         WHERE ${filters.join(' AND ')}
         ORDER BY task.priority, task.due_at IS NULL, task.due_at, task.id DESC LIMIT 300`,
        params,
      );
      const tasks = [];
      for (const row of rows) {
        const [checklist] = await db.execute(
          `SELECT id, label, is_required, is_complete, completed_by, completed_at
           FROM task_checklist_items WHERE property_id = ? AND task_id = ? ORDER BY id`,
          [req.propertyId, row.id],
        );
        tasks.push(mapTask({ ...row, checklist: checklist.map((item) => ({
          id: Number(item.id),
          label: item.label,
          required: Boolean(item.is_required),
          complete: Boolean(item.is_complete),
          completedBy: item.completed_by === null ? null : Number(item.completed_by),
          completedAt: item.completed_at,
        })) }));
      }
      return res.json({ data: tasks });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/housekeeping/reports', requirePermission(db, 'housekeeping.view'), async (req, res, next) => {
    try {
      const [permissions] = await db.execute(
        'SELECT permission_key FROM role_permissions WHERE role_id = ?',
        [req.auth.roleId],
      );
      const supervisor = permissions.some((row) => row.permission_key === 'housekeeping.assign');
      const [summary] = await db.execute(
        `SELECT COUNT(*) AS total,
                SUM(status NOT IN ('approved', 'rejected') AND due_at < UTC_TIMESTAMP()) AS overdue,
                SUM(status = 'approved') AS approved,
                AVG(CASE WHEN type IN ('checkout_clean', 'daily_clean', 'deep_clean', 'turndown')
                    AND started_at IS NOT NULL AND completed_at IS NOT NULL
                    THEN TIMESTAMPDIFF(MINUTE, started_at, completed_at) END) AS average_minutes
         FROM housekeeping_tasks
         WHERE property_id = ? ${supervisor ? '' : 'AND assigned_to = ?'}`,
        supervisor ? [req.propertyId] : [req.propertyId, req.auth.sub],
      );
      const [byRoomType] = await db.execute(
        `SELECT type.name AS roomType, AVG(TIMESTAMPDIFF(MINUTE, task.started_at, task.completed_at)) AS averageMinutes
         FROM housekeeping_tasks task
         JOIN rooms room ON room.id = task.room_id AND room.property_id = task.property_id
         JOIN room_types type ON type.id = room.room_type_id AND type.property_id = room.property_id
         WHERE task.property_id = ? AND task.type IN ('checkout_clean', 'daily_clean', 'deep_clean', 'turndown')
           AND task.started_at IS NOT NULL AND task.completed_at IS NOT NULL
           ${supervisor ? '' : 'AND task.assigned_to = ?'}
         GROUP BY type.id, type.name ORDER BY type.name`,
        supervisor ? [req.propertyId] : [req.propertyId, req.auth.sub],
      );
      const [byEmployee] = await db.execute(
        `SELECT assignee.id AS employeeId, assignee.name AS employeeName,
                AVG(TIMESTAMPDIFF(MINUTE, task.started_at, task.completed_at)) AS averageMinutes
         FROM housekeeping_tasks task
         JOIN users assignee ON assignee.id = task.assigned_to
         WHERE task.property_id = ? AND task.type IN ('checkout_clean', 'daily_clean', 'deep_clean', 'turndown')
           AND task.started_at IS NOT NULL AND task.completed_at IS NOT NULL
           ${supervisor ? '' : 'AND task.assigned_to = ?'}
         GROUP BY assignee.id, assignee.name ORDER BY assignee.name`,
        supervisor ? [req.propertyId] : [req.propertyId, req.auth.sub],
      );
      const [readinessRows] = await db.execute(
        `SELECT SUM(status = 'CLEAN') AS ready_rooms,
                SUM(status IN ('AWAITING_CLEANING', 'BEING_CLEANED', 'AWAITING_INSPECTION')) AS in_progress_rooms
         FROM rooms WHERE property_id = ? AND is_active = 1 AND deleted_at IS NULL`,
        [req.propertyId],
      );
      return res.json({ data: {
        total: Number(summary[0].total ?? 0),
        overdue: Number(summary[0].overdue ?? 0),
        approved: Number(summary[0].approved ?? 0),
        averageMinutes: summary[0].average_minutes === null ? null : Number(summary[0].average_minutes),
        byRoomType: byRoomType.map((row) => ({ roomType: row.roomType, averageMinutes: Number(row.averageMinutes) })),
        byEmployee: byEmployee.map((row) => ({
          employeeId: Number(row.employeeId),
          employeeName: row.employeeName,
          averageMinutes: Number(row.averageMinutes),
        })),
        readyRooms: Number(readinessRows[0].ready_rooms ?? 0),
        inProgressRooms: Number(readinessRows[0].in_progress_rooms ?? 0),
      } });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/housekeeping/tasks', requirePermission(db, 'housekeeping.assign'), async (req, res, next) => {
    let connection;
    try {
      const data = parse(taskSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [rooms] = await connection.execute(
        `SELECT id, status FROM rooms WHERE property_id = ? AND id = ? AND is_active = 1 AND deleted_at IS NULL FOR UPDATE`,
        [req.propertyId, data.roomId],
      );
      if (!rooms[0]) throw httpError(404, 'ROOM_NOT_FOUND', 'Room not found');
      if (data.assignedTo) {
        const [staff] = await connection.execute(
          `SELECT u.id FROM users u
           JOIN user_properties membership ON membership.user_id = u.id
           JOIN roles role ON role.id = u.role_id
           WHERE u.id = ? AND u.is_active = 1 AND membership.property_id = ?
             AND role.name IN ('housekeeping_staff', 'housekeeping_supervisor') LIMIT 1`,
          [data.assignedTo, req.propertyId],
        );
        if (!staff.length) throw httpError(400, 'INVALID_HOUSEKEEPER', 'Choose an active housekeeping staff member assigned to this property');
      }
      if (data.departmentId) {
        const [departments] = await connection.execute(
          'SELECT id FROM departments WHERE property_id = ? AND id = ? AND deleted_at IS NULL',
          [req.propertyId, data.departmentId],
        );
        if (!departments.length) throw httpError(400, 'INVALID_DEPARTMENT', 'Department does not belong to this property');
      }
      const taskId = await createHousekeepingTask(connection, {
        propertyId: req.propertyId,
        roomId: data.roomId,
        type: data.type,
        dueAt: data.dueAt ?? null,
        priority: data.priority,
        sourceRule: 'supervisor',
        priorityReason: 'Supervisor-scheduled priority',
      });
      await connection.execute(
        `UPDATE housekeeping_tasks SET assigned_to = ?, assigned_department_id = ?, status = ?
         WHERE property_id = ? AND id = ?`,
        [
          data.assignedTo ?? null, data.departmentId ?? null,
          data.assignedTo || data.departmentId ? 'assigned' : 'pending',
          req.propertyId, taskId,
        ],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'housekeeping.task_created',
        entity: 'housekeeping_task',
        entityId: taskId,
        after: data,
      });
      await connection.commit();
      return res.status(201).json({ data: await taskDetail(db, req.propertyId, taskId) });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.patch('/housekeeping/tasks/:id/assignment', requirePermission(db, 'housekeeping.assign'), async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      const data = parse(assignmentSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT status, assigned_to, assigned_department_id FROM housekeeping_tasks WHERE property_id = ? AND id = ? FOR UPDATE',
        [req.propertyId, id],
      );
      if (!rows[0]) throw httpError(404, 'TASK_NOT_FOUND', 'Housekeeping task not found');
      if (!['pending', 'assigned', 'rejected'].includes(rows[0].status)) {
        throw httpError(409, 'TASK_NOT_ASSIGNABLE', 'This task cannot be reassigned in its current state');
      }
      if (data.assignedTo) {
        const [staff] = await connection.execute(
          `SELECT user.id FROM users user
           JOIN user_properties membership ON membership.user_id = user.id
           JOIN roles role ON role.id = user.role_id
           WHERE user.id = ? AND user.is_active = 1 AND membership.property_id = ?
             AND role.name IN ('housekeeping_staff', 'housekeeping_supervisor') LIMIT 1`,
          [data.assignedTo, req.propertyId],
        );
        if (!staff.length) throw httpError(400, 'INVALID_HOUSEKEEPER', 'Choose an active housekeeping staff member assigned to this property');
      }
      if (data.departmentId) {
        const [departments] = await connection.execute(
          'SELECT id FROM departments WHERE property_id = ? AND id = ? AND deleted_at IS NULL',
          [req.propertyId, data.departmentId],
        );
        if (!departments.length) throw httpError(400, 'INVALID_DEPARTMENT', 'Department does not belong to this property');
      }
      const assignedTo = data.assignedTo === undefined ? rows[0].assigned_to : data.assignedTo;
      const departmentId = data.departmentId === undefined ? rows[0].assigned_department_id : data.departmentId;
      const status = ['pending', 'assigned', 'rejected'].includes(rows[0].status)
        ? (assignedTo || departmentId ? 'assigned' : 'pending')
        : rows[0].status;
      await connection.execute(
        'UPDATE housekeeping_tasks SET assigned_to = ?, assigned_department_id = ?, status = ? WHERE property_id = ? AND id = ?',
        [assignedTo, departmentId, status, req.propertyId, id],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'housekeeping.task_assigned',
        entity: 'housekeeping_task',
        entityId: id,
        before: rows[0],
        after: { assignedTo, departmentId, status },
      });
      await connection.commit();
      return res.json({ data: await taskDetail(db, req.propertyId, id) });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/housekeeping/tasks/bulk-assignment', requirePermission(db, 'housekeeping.assign'), async (req, res, next) => {
    let connection;
    try {
      const data = parse(bulkAssignmentSchema, req.body);
      const taskIds = [...new Set(data.taskIds)].sort((left, right) => left - right);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [staff] = await connection.execute(
        `SELECT u.id FROM users u
         JOIN user_properties membership ON membership.user_id = u.id
         JOIN roles role ON role.id = u.role_id
         WHERE u.id = ? AND u.is_active = 1 AND membership.property_id = ?
           AND role.name IN ('housekeeping_staff', 'housekeeping_supervisor') LIMIT 1`,
        [data.assignedTo, req.propertyId],
      );
      if (!staff.length) throw httpError(400, 'INVALID_HOUSEKEEPER', 'Choose an active housekeeping staff member assigned to this property');
      const [tasks] = await connection.execute(
        `SELECT id, status, assigned_to FROM housekeeping_tasks
         WHERE property_id = ? AND id IN (${taskIds.map(() => '?').join(',')})
         ORDER BY id FOR UPDATE`,
        [req.propertyId, ...taskIds],
      );
      if (tasks.length !== taskIds.length) throw httpError(404, 'TASK_NOT_FOUND', 'One or more tasks were not found in this property');
      if (tasks.some((task) => !['pending', 'assigned', 'rejected'].includes(task.status))) {
        throw httpError(409, 'TASK_NOT_ASSIGNABLE', 'Only pending or rejected tasks can be bulk assigned');
      }
      await connection.execute(
        `UPDATE housekeeping_tasks SET assigned_to = ?, status = 'assigned'
         WHERE property_id = ? AND id IN (${taskIds.map(() => '?').join(',')})`,
        [data.assignedTo, req.propertyId, ...taskIds],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'housekeeping.tasks_bulk_assigned',
        entity: 'housekeeping_task',
        entityId: taskIds.join(','),
        before: tasks.map((task) => ({ id: Number(task.id), status: task.status, assignedTo: task.assigned_to })),
        after: { taskIds, assignedTo: data.assignedTo },
      });
      await connection.commit();
      return res.json({ data: { assigned: taskIds.length, taskIds, assignedTo: data.assignedTo } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/housekeeping/tasks/:id/start', requirePermission(db, 'housekeeping.work'), async (req, res, next) => {
    let connection;
    let broadcast;
    try {
      const id = parse(idSchema, req.params.id);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT task.status, task.assigned_to, task.room_id, task.is_readiness_task,
                room.status AS room_status
         FROM housekeeping_tasks task
         JOIN rooms room ON room.id = task.room_id AND room.property_id = task.property_id
         WHERE task.property_id = ? AND task.id = ? FOR UPDATE`,
        [req.propertyId, id],
      );
      const task = rows[0];
      if (!task) throw httpError(404, 'TASK_NOT_FOUND', 'Housekeeping task not found');
      const permissions = await getRolePermissions(db, req.auth.roleId);
      const supervisor = permissions.includes('housekeeping.assign');
      if ((task.assigned_to === null && !supervisor)
          || (task.assigned_to !== null && Number(task.assigned_to) !== req.auth.sub)) {
        throw httpError(403, 'TASK_NOT_ASSIGNED', 'This task is assigned to another housekeeper');
      }
      if (!['pending', 'assigned', 'rejected'].includes(task.status)) {
        throw httpError(409, 'TASK_ALREADY_STARTED', 'Another housekeeper has already started or completed this task');
      }
      const [property] = await connection.execute(
        'SELECT housekeeping_skip_inspection FROM properties WHERE id = ?',
        [req.propertyId],
      );
      if (task.is_readiness_task && ['AWAITING_CLEANING', 'BEING_CLEANED'].includes(task.room_status)) {
        const nextStatus = task.room_status === 'AWAITING_CLEANING' ? 'BEING_CLEANED' : task.room_status;
        if (nextStatus !== task.room_status) {
          await setRoomStatus(connection, {
            propertyId: req.propertyId,
            roomId: Number(task.room_id),
            fromStatus: task.room_status,
            toStatus: nextStatus,
            actorId: req.auth.sub,
            reason: 'Housekeeping task started',
          });
          broadcast = { roomId: Number(task.room_id), status: nextStatus };
        }
      } else if (task.is_readiness_task && !property[0].housekeeping_skip_inspection) {
        throw httpError(409, 'ROOM_NOT_AWAITING_CLEANING', 'Readiness tasks can only start for a room awaiting cleaning or rework');
      }
      await connection.execute(
        `UPDATE housekeeping_tasks
         SET status = 'in_progress', assigned_to = COALESCE(assigned_to, ?),
             started_at = COALESCE(started_at, UTC_TIMESTAMP()), completed_at = NULL
         WHERE property_id = ? AND id = ?`,
        [req.auth.sub, req.propertyId, id],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'housekeeping.task_started',
        entity: 'housekeeping_task',
        entityId: id,
        before: { status: task.status, roomStatus: task.room_status },
        after: { status: 'in_progress', roomStatus: broadcast?.status ?? task.room_status },
      });
      await connection.commit();
      if (broadcast) publishRoomStatus(req.propertyId, broadcast);
      return res.json({ data: await taskDetail(db, req.propertyId, id) });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.patch('/housekeeping/tasks/:id/items/:itemId', requirePermission(db, 'housekeeping.work'), async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      const itemId = parse(idSchema, req.params.itemId);
      const data = parse(itemSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [tasks] = await connection.execute(
        'SELECT status, assigned_to FROM housekeeping_tasks WHERE property_id = ? AND id = ? FOR UPDATE',
        [req.propertyId, id],
      );
      if (!tasks[0]) throw httpError(404, 'TASK_NOT_FOUND', 'Housekeeping task not found');
      if (tasks[0].status !== 'in_progress') throw httpError(409, 'TASK_NOT_IN_PROGRESS', 'Start the task before updating its checklist');
      const permissions = await getRolePermissions(db, req.auth.roleId);
      if ((tasks[0].assigned_to === null && !permissions.includes('housekeeping.assign'))
          || (tasks[0].assigned_to !== null && Number(tasks[0].assigned_to) !== req.auth.sub)) {
        throw httpError(403, 'TASK_NOT_ASSIGNED', 'Only the assigned housekeeper can update this checklist');
      }
      const [items] = await connection.execute(
        'SELECT id FROM task_checklist_items WHERE property_id = ? AND task_id = ? AND id = ?',
        [req.propertyId, id, itemId],
      );
      if (!items.length) throw httpError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'Checklist item not found');
      await connection.execute(
        `UPDATE task_checklist_items
         SET is_complete = ?, completed_by = ?, completed_at = IF(?, UTC_TIMESTAMP(), NULL)
         WHERE property_id = ? AND task_id = ? AND id = ?`,
        [data.complete, data.complete ? req.auth.sub : null, data.complete, req.propertyId, id, itemId],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'housekeeping.checklist_item_updated',
        entity: 'housekeeping_task',
        entityId: id,
        after: { itemId, complete: data.complete },
      });
      await connection.commit();
      return res.json({ data: await taskDetail(db, req.propertyId, id) });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/housekeeping/tasks/:id/issue', requirePermission(db, 'housekeeping.work'), async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      const data = parse(issueSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [tasks] = await connection.execute(
        `SELECT task.status, task.assigned_to, task.room_id, room.status AS room_status
         FROM housekeeping_tasks task JOIN rooms room
           ON room.id = task.room_id AND room.property_id = task.property_id
         WHERE task.property_id = ? AND task.id = ? FOR UPDATE`,
        [req.propertyId, id],
      );
      if (!tasks[0]) throw httpError(404, 'TASK_NOT_FOUND', 'Housekeeping task not found');
      if (tasks[0].status !== 'in_progress') throw httpError(409, 'TASK_NOT_IN_PROGRESS', 'Start the task before reporting an issue');
      const permissions = await getRolePermissions(db, req.auth.roleId);
      if ((tasks[0].assigned_to === null && !permissions.includes('housekeeping.assign'))
          || (tasks[0].assigned_to !== null && Number(tasks[0].assigned_to) !== req.auth.sub)) {
        throw httpError(403, 'TASK_NOT_ASSIGNED', 'Only the assigned housekeeper can report an issue');
      }
      const [ticket] = await connection.execute(
        `INSERT INTO maintenance_tickets
          (property_id, room_id, category, priority, description, status, blocks_room, reported_by, opened_at)
         VALUES (?, ?, ?, ?, ?, 'open', 0, ?, UTC_TIMESTAMP())`,
        [req.propertyId, tasks[0].room_id, data.category, data.priority, data.description, req.auth.sub],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'housekeeping.issue_reported',
        entity: 'maintenance_ticket',
        entityId: ticket.insertId,
        after: { taskId: id, roomId: Number(tasks[0].room_id), ...data },
      });
      await connection.commit();
      return res.status(201).json({ data: { ticketId: Number(ticket.insertId), status: 'open' } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/housekeeping/tasks/:id/submit', requirePermission(db, 'housekeeping.work'), async (req, res, next) => {
    let connection;
    let broadcast;
    try {
      const id = parse(idSchema, req.params.id);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [tasks] = await connection.execute(
        `SELECT task.status, task.assigned_to, task.room_id, task.is_readiness_task, room.status AS room_status
         FROM housekeeping_tasks task JOIN rooms room
           ON room.id = task.room_id AND room.property_id = task.property_id
         WHERE task.property_id = ? AND task.id = ? FOR UPDATE`,
        [req.propertyId, id],
      );
      const task = tasks[0];
      if (!task) throw httpError(404, 'TASK_NOT_FOUND', 'Housekeeping task not found');
      if (task.status !== 'in_progress') throw httpError(409, 'TASK_NOT_IN_PROGRESS', 'Only an active task can be submitted');
      const permissions = await getRolePermissions(db, req.auth.roleId);
      if ((task.assigned_to === null && !permissions.includes('housekeeping.assign'))
          || (task.assigned_to !== null && Number(task.assigned_to) !== req.auth.sub)) {
        throw httpError(403, 'TASK_NOT_ASSIGNED', 'Only the assigned housekeeper can submit this task');
      }
      const [incomplete] = await connection.execute(
        `SELECT COUNT(*) AS count FROM task_checklist_items
         WHERE property_id = ? AND task_id = ? AND is_required = 1 AND is_complete = 0`,
        [req.propertyId, id],
      );
      if (Number(incomplete[0].count) > 0) throw httpError(409, 'CHECKLIST_INCOMPLETE', 'Complete every required checklist item before submitting');
      const [property] = await connection.execute(
        'SELECT housekeeping_skip_inspection FROM properties WHERE id = ?',
        [req.propertyId],
      );
      if (task.is_readiness_task && task.room_status !== 'BEING_CLEANED') {
        throw httpError(409, 'ROOM_NOT_BEING_CLEANED', 'Room must be in cleaning before it can be inspected');
      }
      const [blockingTickets] = task.is_readiness_task ? await connection.execute(
        `SELECT id FROM maintenance_tickets
         WHERE property_id = ? AND room_id = ? AND blocks_room = 1 AND status <> 'closed'
         LIMIT 1`,
        [req.propertyId, task.room_id],
      ) : [[]];
      const nextStatus = task.is_readiness_task && !property[0].housekeeping_skip_inspection
        ? 'awaiting_inspection'
        : 'approved';
      if (nextStatus === 'awaiting_inspection') {
        await setRoomStatus(connection, {
          propertyId: req.propertyId,
          roomId: Number(task.room_id),
          fromStatus: 'BEING_CLEANED',
          toStatus: 'AWAITING_INSPECTION',
          actorId: req.auth.sub,
          reason: 'Housekeeping task submitted for inspection',
        });
        broadcast = { roomId: Number(task.room_id), status: 'AWAITING_INSPECTION' };
      } else if (task.is_readiness_task && task.room_status !== 'CLEAN') {
        const readyStatus = blockingTickets.length ? 'BLOCKED_MAINTENANCE' : 'CLEAN';
        await setRoomStatus(connection, {
          propertyId: req.propertyId,
          roomId: Number(task.room_id),
          fromStatus: task.room_status,
          toStatus: readyStatus,
          actorId: req.auth.sub,
          reason: blockingTickets.length
            ? 'Cleaning complete but room remains blocked by an open maintenance ticket'
            : 'Inspection skipped by property policy',
        });
        broadcast = { roomId: Number(task.room_id), status: readyStatus };
      }
      await connection.execute(
        `UPDATE housekeeping_tasks SET status = ?, completed_at = UTC_TIMESTAMP()
         WHERE property_id = ? AND id = ?`,
        [nextStatus, req.propertyId, id],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'housekeeping.task_submitted',
        entity: 'housekeeping_task',
        entityId: id,
        before: { status: task.status, roomStatus: task.room_status },
        after: { status: nextStatus, roomStatus: broadcast?.status ?? task.room_status },
      });
      await connection.commit();
      if (broadcast) publishRoomStatus(req.propertyId, broadcast);
      return res.json({ data: await taskDetail(db, req.propertyId, id) });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/housekeeping/tasks/:id/inspection', requirePermission(db, 'housekeeping.inspect'), async (req, res, next) => {
    let connection;
    let broadcast;
    try {
      const id = parse(idSchema, req.params.id);
      const data = parse(inspectionSchema, req.body);
      if (data.decision === 'reject' && !data.reason) {
        throw httpError(400, 'REASON_REQUIRED', 'A rejection reason is required');
      }
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [tasks] = await connection.execute(
        `SELECT task.status, task.room_id, task.is_readiness_task, room.status AS room_status
         FROM housekeeping_tasks task JOIN rooms room
           ON room.id = task.room_id AND room.property_id = task.property_id
         WHERE task.property_id = ? AND task.id = ? FOR UPDATE`,
        [req.propertyId, id],
      );
      const task = tasks[0];
      if (!task) throw httpError(404, 'TASK_NOT_FOUND', 'Housekeeping task not found');
      if (task.status !== 'awaiting_inspection') throw httpError(409, 'INSPECTION_NOT_PENDING', 'This task is not awaiting inspection');
      const approved = data.decision === 'approve';
      const [blockingTickets] = approved && task.is_readiness_task ? await connection.execute(
        `SELECT id FROM maintenance_tickets
         WHERE property_id = ? AND room_id = ? AND blocks_room = 1 AND status <> 'closed'
         LIMIT 1`,
        [req.propertyId, task.room_id],
      ) : [[]];
      const toStatus = approved
        ? (blockingTickets.length ? 'BLOCKED_MAINTENANCE' : 'CLEAN')
        : 'BEING_CLEANED';
      if (task.is_readiness_task) {
        if (task.room_status !== 'AWAITING_INSPECTION') {
          throw httpError(409, 'ROOM_NOT_AWAITING_INSPECTION', 'Room status changed before inspection');
        }
        await setRoomStatus(connection, {
          propertyId: req.propertyId,
          roomId: Number(task.room_id),
          fromStatus: 'AWAITING_INSPECTION',
          toStatus,
          actorId: req.auth.sub,
          reason: approved
            ? (blockingTickets.length
              ? 'Inspection approved but room remains blocked by an open maintenance ticket'
              : 'Housekeeping inspection approved')
            : data.reason,
        });
        broadcast = { roomId: Number(task.room_id), status: toStatus };
      }
      await connection.execute(
        `UPDATE housekeeping_tasks SET status = ?, inspected_by = ?, inspected_at = UTC_TIMESTAMP()
         WHERE property_id = ? AND id = ?`,
        [approved ? 'approved' : 'rejected', req.auth.sub, req.propertyId, id],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: `housekeeping.task_inspection_${data.decision}`,
        entity: 'housekeeping_task',
        entityId: id,
        before: { status: task.status, roomStatus: task.room_status },
        after: { status: approved ? 'approved' : 'rejected', roomStatus: toStatus, reason: data.reason ?? null },
      });
      await connection.commit();
      if (broadcast) publishRoomStatus(req.propertyId, broadcast);
      return res.json({ data: await taskDetail(db, req.propertyId, id) });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.use(failureResponse);
  return router;
}
