import { Router } from 'express';
import { z } from 'zod';
import { auditable } from '../auth/audit.js';
import { authenticate, propertyScope, requirePermission } from '../auth/middleware.js';
import { logger } from '../config/logger.js';
import { publishMaintenanceUpdate, publishRoomStatus } from '../realtime.js';

const idSchema = z.coerce.number().int().positive();
const assetSchema = z.object({
  name: z.string().trim().min(1).max(160),
  assetTag: z.string().trim().max(100).nullable().optional(),
  category: z.string().trim().max(100).nullable().optional(),
  roomId: idSchema.nullable().optional(),
  status: z.enum(['active', 'needs_service', 'out_of_service']).default('active'),
});
const ticketSchema = z.object({
  roomId: idSchema.nullable().optional(),
  assetId: idSchema.nullable().optional(),
  category: z.string().trim().min(1).max(100),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  description: z.string().trim().min(3).max(5000),
  blocksRoom: z.boolean().default(false),
  assignedTo: idSchema.nullable().optional(),
});
const assignmentSchema = z.object({ assignedTo: idSchema.nullable() });
const statusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('in_progress') }),
  z.object({ status: z.literal('resolved'), resolutionNotes: z.string().trim().min(3).max(2000) }),
  z.object({
    status: z.literal('closed'),
    clearanceNotes: z.string().trim().min(3).max(2000),
  }),
]);

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

async function assertAssignee(connection, propertyId, userId) {
  if (userId === null) return;
  const [rows] = await connection.execute(
    `SELECT user.id FROM users user
     JOIN user_properties membership ON membership.user_id = user.id AND membership.property_id = ?
     JOIN role_permissions permission ON permission.role_id = user.role_id
       AND permission.permission_key = 'maintenance.manage'
     WHERE user.id = ? AND user.is_active = 1 LIMIT 1`,
    [propertyId, userId],
  );
  if (!rows[0]) throw httpError(400, 'INVALID_ASSIGNEE', 'Choose an active maintenance team member assigned to this property');
}

async function setRoomStatus(connection, { propertyId, roomId, fromStatus, toStatus, actorId, reason }) {
  if (fromStatus === toStatus) return;
  await connection.execute(
    `INSERT INTO room_status_history
      (property_id, room_id, from_status, to_status, reason, changed_by, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [propertyId, roomId, fromStatus, toStatus, reason, actorId],
  );
  await connection.execute('SET @shms_maintenance_transition = 1');
  try {
    await connection.execute(
      'UPDATE rooms SET status = ? WHERE property_id = ? AND id = ?',
      [toStatus, propertyId, roomId],
    );
  } finally {
    await connection.execute('SET @shms_maintenance_transition = 0');
  }
}

async function ticketConflicts(connection, propertyId, roomId) {
  if (!roomId) return [];
  const [rows] = await connection.execute(
    `SELECT DISTINCT reservation.confirmation_no, reservation.check_in_date,
            reservation.check_out_date, reservation.status
     FROM room_nights night
     JOIN reservations reservation ON reservation.id = night.reservation_id
       AND reservation.property_id = night.property_id
     JOIN properties property ON property.id = reservation.property_id
     WHERE night.property_id = ? AND night.room_id = ? AND night.night >= property.business_date
       AND reservation.status IN ('tentative', 'confirmed', 'checked_in')
     ORDER BY reservation.check_in_date`,
    [propertyId, roomId],
  );
  return rows.map((row) => ({
    confirmationNo: row.confirmation_no,
    checkInDate: String(row.check_in_date).slice(0, 10),
    checkOutDate: String(row.check_out_date).slice(0, 10),
    reservationStatus: row.status,
  }));
}

async function ticketDetail(connection, propertyId, ticketId) {
  const [rows] = await connection.execute(
    `SELECT ticket.id, ticket.room_id, room.room_number, room.status AS room_status,
            ticket.asset_id, asset.name AS asset_name, asset.asset_tag,
            ticket.category, ticket.priority, ticket.description, ticket.status,
            ticket.blocks_room, ticket.assigned_to, assignee.name AS assignee_name,
            ticket.reported_by, reporter.name AS reporter_name, ticket.resolution_notes,
            ticket.resolved_at, ticket.cleared_by, clearer.name AS clearer_name,
            ticket.cleared_at, ticket.clearance_notes, ticket.opened_at, ticket.updated_at
     FROM maintenance_tickets ticket
     LEFT JOIN rooms room ON room.id = ticket.room_id AND room.property_id = ticket.property_id
     LEFT JOIN assets asset ON asset.id = ticket.asset_id AND asset.property_id = ticket.property_id
     LEFT JOIN users assignee ON assignee.id = ticket.assigned_to
     LEFT JOIN users reporter ON reporter.id = ticket.reported_by
     LEFT JOIN users clearer ON clearer.id = ticket.cleared_by
     WHERE ticket.property_id = ? AND ticket.id = ? LIMIT 1`,
    [propertyId, ticketId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    roomId: row.room_id === null ? null : Number(row.room_id),
    roomNumber: row.room_number,
    roomStatus: row.room_status,
    assetId: row.asset_id === null ? null : Number(row.asset_id),
    assetName: row.asset_name,
    assetTag: row.asset_tag,
    category: row.category,
    priority: row.priority,
    description: row.description,
    status: row.status,
    blocksRoom: Boolean(row.blocks_room),
    assignedTo: row.assigned_to === null ? null : Number(row.assigned_to),
    assigneeName: row.assignee_name,
    reportedBy: row.reported_by === null ? null : Number(row.reported_by),
    reporterName: row.reporter_name,
    resolutionNotes: row.resolution_notes,
    resolvedAt: row.resolved_at,
    clearedBy: row.cleared_by === null ? null : Number(row.cleared_by),
    clearerName: row.clearer_name,
    clearedAt: row.cleared_at,
    clearanceNotes: row.clearance_notes,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
  };
}

function failureResponse(error, _req, res, next) {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) {
    logger.error({ err: error }, 'Maintenance API request failed');
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'The maintenance request could not be completed' },
    });
  }
  return res.status(status).json({
    error: {
      code: error.code ?? 'MAINTENANCE_ERROR',
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  });
}

export function createMaintenanceRouter(db) {
  const router = Router();
  router.use(authenticate(db), propertyScope(db), requirePermission(db, 'maintenance.manage'));

  router.get('/maintenance/rooms', async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT room.id, room.room_number, room.status, room.room_type_id,
                type.name AS room_type, floor.name AS floor_name,
                COUNT(DISTINCT CASE WHEN ticket.blocks_room = 1
                  AND ticket.status <> 'closed' THEN ticket.id END) AS blocking_tickets
         FROM rooms room
         JOIN room_types type ON type.id = room.room_type_id AND type.property_id = room.property_id
         LEFT JOIN floors floor ON floor.id = room.floor_id AND floor.property_id = room.property_id
         LEFT JOIN maintenance_tickets ticket ON ticket.room_id = room.id AND ticket.property_id = room.property_id
           AND ticket.blocks_room = 1 AND ticket.status <> 'closed'
         WHERE room.property_id = ? AND room.deleted_at IS NULL
         GROUP BY room.id, room.room_number, room.status, room.room_type_id, type.name, floor.name
         ORDER BY floor.name, room.room_number`,
        [req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id),
        roomNumber: row.room_number,
        status: row.status,
        roomTypeId: Number(row.room_type_id),
        roomType: row.room_type,
        floor: row.floor_name,
        blockingTickets: Number(row.blocking_tickets),
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/maintenance/staff', async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT user.id, user.name, role.name AS role_name
         FROM users user
         JOIN roles role ON role.id = user.role_id
         JOIN user_properties membership ON membership.user_id = user.id
         JOIN role_permissions permission ON permission.role_id = role.id
           AND permission.permission_key = 'maintenance.manage'
         WHERE membership.property_id = ? AND user.is_active = 1
         ORDER BY user.name`,
        [req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id), name: row.name, role: row.role_name,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/maintenance/assets', async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT asset.id, asset.name, asset.asset_tag, asset.category, asset.status,
                asset.room_id, room.room_number, asset.created_at,
                COUNT(DISTINCT CASE WHEN ticket.status <> 'closed' THEN ticket.id END) AS open_tickets
         FROM assets asset
         LEFT JOIN rooms room ON room.id = asset.room_id AND room.property_id = asset.property_id
         LEFT JOIN maintenance_tickets ticket ON ticket.asset_id = asset.id AND ticket.property_id = asset.property_id
         WHERE asset.property_id = ? AND asset.deleted_at IS NULL
         GROUP BY asset.id, asset.name, asset.asset_tag, asset.category, asset.status,
                  asset.room_id, room.room_number, asset.created_at
         ORDER BY asset.name, asset.asset_tag`,
        [req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        assetTag: row.asset_tag,
        category: row.category,
        status: row.status,
        roomId: row.room_id === null ? null : Number(row.room_id),
        roomNumber: row.room_number,
        openTickets: Number(row.open_tickets),
        createdAt: row.created_at,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/maintenance/assets', async (req, res, next) => {
    let connection;
    try {
      const data = parse(assetSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      if (data.roomId) {
        const [rooms] = await connection.execute(
          'SELECT id FROM rooms WHERE property_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1',
          [req.propertyId, data.roomId],
        );
        if (!rooms[0]) throw httpError(400, 'INVALID_ROOM', 'Choose a room in the active property');
      }
      const [insert] = await connection.execute(
        `INSERT INTO assets (property_id, room_id, name, asset_tag, category, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.propertyId, data.roomId ?? null, data.name, data.assetTag || null, data.category || null, data.status],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'maintenance.asset_created',
        entity: 'asset',
        entityId: insert.insertId,
        after: data,
      });
      await connection.commit();
      return res.status(201).json({ data: { id: Number(insert.insertId) } });
    } catch (error) {
      if (connection) await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') return next(httpError(409, 'ASSET_TAG_EXISTS', 'This asset tag is already used in the property'));
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.put('/maintenance/assets/:id', async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      const data = parse(assetSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [assets] = await connection.execute(
        'SELECT id, room_id, name, asset_tag, category, status FROM assets WHERE property_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE',
        [req.propertyId, id],
      );
      if (!assets[0]) throw httpError(404, 'ASSET_NOT_FOUND', 'Asset not found');
      if (data.roomId) {
        const [rooms] = await connection.execute(
          'SELECT id FROM rooms WHERE property_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1',
          [req.propertyId, data.roomId],
        );
        if (!rooms[0]) throw httpError(400, 'INVALID_ROOM', 'Choose a room in the active property');
      }
      const [openTickets] = await connection.execute(
        `SELECT id FROM maintenance_tickets
         WHERE property_id = ? AND asset_id = ? AND status <> 'closed' LIMIT 1`,
        [req.propertyId, id],
      );
      if (openTickets[0] && assets[0].room_id !== (data.roomId ?? null)) {
        throw httpError(409, 'ASSET_HAS_OPEN_TICKETS', 'Resolve and clear the asset tickets before moving it');
      }
      await connection.execute(
        `UPDATE assets SET room_id = ?, name = ?, asset_tag = ?, category = ?, status = ?
         WHERE property_id = ? AND id = ?`,
        [data.roomId ?? null, data.name, data.assetTag || null, data.category || null, data.status, req.propertyId, id],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'maintenance.asset_updated',
        entity: 'asset',
        entityId: id,
        before: assets[0],
        after: data,
      });
      await connection.commit();
      return res.json({ data: { id } });
    } catch (error) {
      if (connection) await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') return next(httpError(409, 'ASSET_TAG_EXISTS', 'This asset tag is already used in the property'));
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.delete('/maintenance/assets/:id', async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [assets] = await connection.execute(
        'SELECT id, name, asset_tag FROM assets WHERE property_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE',
        [req.propertyId, id],
      );
      if (!assets[0]) throw httpError(404, 'ASSET_NOT_FOUND', 'Asset not found');
      const [openTickets] = await connection.execute(
        `SELECT id FROM maintenance_tickets WHERE property_id = ? AND asset_id = ? AND status <> 'closed' LIMIT 1`,
        [req.propertyId, id],
      );
      if (openTickets[0]) throw httpError(409, 'ASSET_HAS_OPEN_TICKETS', 'Resolve and clear the asset tickets before archiving it');
      await connection.execute(
        'UPDATE assets SET deleted_at = UTC_TIMESTAMP() WHERE property_id = ? AND id = ?',
        [req.propertyId, id],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'maintenance.asset_archived',
        entity: 'asset',
        entityId: id,
        before: assets[0],
        after: { deleted: true },
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

  router.get('/maintenance/tickets', async (req, res, next) => {
    try {
      const status = req.query.status ? String(req.query.status) : null;
      const priority = req.query.priority ? String(req.query.priority) : null;
      const roomId = req.query.roomId ? parse(idSchema, req.query.roomId) : null;
      if (status && !['open', 'assigned', 'in_progress', 'resolved', 'closed'].includes(status)) {
        throw httpError(400, 'INVALID_STATUS', 'Choose a valid ticket status');
      }
      if (priority && !['low', 'normal', 'high', 'urgent'].includes(priority)) {
        throw httpError(400, 'INVALID_PRIORITY', 'Choose a valid ticket priority');
      }
      const [rows] = await db.execute(
        `SELECT ticket.id FROM maintenance_tickets ticket
         WHERE ticket.property_id = ?
           AND (? IS NULL OR ticket.status = ?)
           AND (? IS NULL OR ticket.priority = ?)
           AND (? IS NULL OR ticket.room_id = ?)
         ORDER BY FIELD(ticket.priority, 'urgent', 'high', 'normal', 'low'),
                  FIELD(ticket.status, 'open', 'assigned', 'in_progress', 'resolved', 'closed'),
                  ticket.opened_at DESC, ticket.id DESC`,
        [req.propertyId, status, status, priority, priority, roomId, roomId],
      );
      const data = [];
      for (const row of rows) data.push(await ticketDetail(db, req.propertyId, Number(row.id)));
      return res.json({ data });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/maintenance/tickets', async (req, res, next) => {
    let connection;
    try {
      const data = parse(ticketSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      let roomId = data.roomId ?? null;
      if (data.assetId) {
        const [assets] = await connection.execute(
          `SELECT id, room_id, name FROM assets
           WHERE property_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE`,
          [req.propertyId, data.assetId],
        );
        if (!assets[0]) throw httpError(400, 'INVALID_ASSET', 'Choose an active asset in the property');
        if (roomId && assets[0].room_id !== roomId) {
          throw httpError(400, 'ASSET_ROOM_MISMATCH', 'The selected asset is not assigned to the selected room');
        }
        roomId ??= assets[0].room_id === null ? null : Number(assets[0].room_id);
      }
      if (!roomId && !data.assetId) throw httpError(400, 'TICKET_TARGET_REQUIRED', 'Choose a room or an asset for the ticket');
      if (data.blocksRoom && !roomId) throw httpError(400, 'ROOM_REQUIRED_FOR_BLOCK', 'A room is required for a room-blocking ticket');
      if (roomId) {
        const [rooms] = await connection.execute(
          'SELECT id, status FROM rooms WHERE property_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE',
          [req.propertyId, roomId],
        );
        if (!rooms[0]) throw httpError(400, 'INVALID_ROOM', 'Choose a room in the active property');
      }
      await assertAssignee(connection, req.propertyId, data.assignedTo ?? null);
      const conflicts = data.blocksRoom ? await ticketConflicts(connection, req.propertyId, roomId) : [];
      const [insert] = await connection.execute(
        `INSERT INTO maintenance_tickets
          (property_id, room_id, asset_id, category, priority, description, status,
           blocks_room, assigned_to, reported_by, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
        [
          req.propertyId, roomId, data.assetId ?? null, data.category, data.priority,
          data.description, data.assignedTo ? 'assigned' : 'open', data.blocksRoom,
          data.assignedTo ?? null, req.auth.sub,
        ],
      );
      let roomStatus = null;
      if (data.blocksRoom) {
        const [rooms] = await connection.execute(
          'SELECT status FROM rooms WHERE property_id = ? AND id = ? FOR UPDATE',
          [req.propertyId, roomId],
        );
        if (rooms[0].status === 'CLEAN') {
          roomStatus = 'BLOCKED_MAINTENANCE';
          await setRoomStatus(connection, {
            propertyId: req.propertyId,
            roomId,
            fromStatus: rooms[0].status,
            toStatus: roomStatus,
            actorId: req.auth.sub,
            reason: `Blocked by maintenance ticket #${insert.insertId}`,
          });
        }
      }
      await auditable(connection, {
        organizationId: req.auth.orgId,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'maintenance.ticket_created',
        entity: 'maintenance_ticket',
        entityId: insert.insertId,
        after: { ...data, roomId, status: data.assignedTo ? 'assigned' : 'open', conflicts },
      });
      await connection.commit();
      if (roomStatus) publishRoomStatus(req.propertyId, { roomId, status: roomStatus });
      publishMaintenanceUpdate(req.propertyId, { ticketId: Number(insert.insertId), status: data.assignedTo ? 'assigned' : 'open' });
      return res.status(201).json({
        data: { id: Number(insert.insertId), roomId, conflicts, roomStatus },
      });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.patch('/maintenance/tickets/:id/assignment', async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      const data = parse(assignmentSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [tickets] = await connection.execute(
        `SELECT status, assigned_to FROM maintenance_tickets
         WHERE property_id = ? AND id = ? FOR UPDATE`,
        [req.propertyId, id],
      );
      if (!tickets[0]) throw httpError(404, 'TICKET_NOT_FOUND', 'Maintenance ticket not found');
      if (tickets[0].status === 'closed') throw httpError(409, 'TICKET_CLOSED', 'A cleared ticket cannot be reassigned');
      await assertAssignee(connection, req.propertyId, data.assignedTo);
      const status = data.assignedTo
        ? (tickets[0].status === 'open' ? 'assigned' : tickets[0].status)
        : (tickets[0].status === 'assigned' ? 'open' : tickets[0].status);
      await connection.execute(
        'UPDATE maintenance_tickets SET assigned_to = ?, status = ? WHERE property_id = ? AND id = ?',
        [data.assignedTo, status, req.propertyId, id],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'maintenance.ticket_assigned',
        entity: 'maintenance_ticket',
        entityId: id,
        before: { assignedTo: tickets[0].assigned_to === null ? null : Number(tickets[0].assigned_to), status: tickets[0].status },
        after: { assignedTo: data.assignedTo, status },
      });
      await connection.commit();
      publishMaintenanceUpdate(req.propertyId, { ticketId: id, status, assignedTo: data.assignedTo });
      return res.json({ data: await ticketDetail(db, req.propertyId, id) });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.patch('/maintenance/tickets/:id/status', async (req, res, next) => {
    let connection;
    let roomStatus = null;
    try {
      const id = parse(idSchema, req.params.id);
      const data = parse(statusSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [tickets] = await connection.execute(
        `SELECT ticket.status, ticket.room_id, ticket.blocks_room, ticket.resolution_notes,
                room.status AS room_status
         FROM maintenance_tickets ticket
         LEFT JOIN rooms room ON room.id = ticket.room_id AND room.property_id = ticket.property_id
         WHERE ticket.property_id = ? AND ticket.id = ? FOR UPDATE`,
        [req.propertyId, id],
      );
      const ticket = tickets[0];
      if (!ticket) throw httpError(404, 'TICKET_NOT_FOUND', 'Maintenance ticket not found');
      const validTransition = (
        (data.status === 'in_progress' && ['open', 'assigned'].includes(ticket.status))
        || (data.status === 'resolved' && ticket.status === 'in_progress')
        || (data.status === 'closed' && ticket.status === 'resolved')
      );
      if (!validTransition) {
        throw httpError(409, 'INVALID_TICKET_TRANSITION', `Cannot move a ${ticket.status} ticket to ${data.status}`);
      }
      if (data.status === 'in_progress') {
        await connection.execute(
          `UPDATE maintenance_tickets SET status = 'in_progress'
           WHERE property_id = ? AND id = ?`,
          [req.propertyId, id],
        );
      } else if (data.status === 'resolved') {
        await connection.execute(
          `UPDATE maintenance_tickets SET status = 'resolved', resolution_notes = ?, resolved_at = UTC_TIMESTAMP()
           WHERE property_id = ? AND id = ?`,
          [data.resolutionNotes, req.propertyId, id],
        );
      } else {
        await connection.execute(
          `UPDATE maintenance_tickets SET status = 'closed', cleared_by = ?, cleared_at = UTC_TIMESTAMP(),
                  clearance_notes = ?
           WHERE property_id = ? AND id = ?`,
          [req.auth.sub, data.clearanceNotes, req.propertyId, id],
        );
        if (ticket.blocks_room && ticket.room_id && ticket.room_status === 'BLOCKED_MAINTENANCE') {
          const [blocking] = await connection.execute(
            `SELECT id FROM maintenance_tickets
             WHERE property_id = ? AND room_id = ? AND blocks_room = 1
               AND status <> 'closed' AND id <> ? LIMIT 1`,
            [req.propertyId, ticket.room_id, id],
          );
          if (!blocking[0]) {
            roomStatus = 'CLEAN';
            await setRoomStatus(connection, {
              propertyId: req.propertyId,
              roomId: Number(ticket.room_id),
              fromStatus: 'BLOCKED_MAINTENANCE',
              toStatus: roomStatus,
              actorId: req.auth.sub,
              reason: `Maintenance ticket #${id} cleared: ${data.clearanceNotes}`,
            });
          }
        }
      }
      await auditable(connection, {
        organizationId: req.auth.orgId,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: data.status === 'closed' ? 'maintenance.ticket_cleared' : `maintenance.ticket_${data.status}`,
        entity: 'maintenance_ticket',
        entityId: id,
        before: { status: ticket.status, roomStatus: ticket.room_status },
        after: {
          status: data.status,
          ...(data.resolutionNotes ? { resolutionNotes: data.resolutionNotes } : {}),
          ...(data.clearanceNotes ? { clearanceNotes: data.clearanceNotes, clearedBy: req.auth.sub } : {}),
          roomStatus: roomStatus ?? ticket.room_status,
        },
      });
      await connection.commit();
      if (roomStatus) publishRoomStatus(req.propertyId, { roomId: Number(ticket.room_id), status: roomStatus });
      publishMaintenanceUpdate(req.propertyId, { ticketId: id, status: data.status, roomStatus });
      return res.json({ data: await ticketDetail(db, req.propertyId, id) });
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
