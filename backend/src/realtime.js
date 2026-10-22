import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { env } from './config/env.js';

let io;

export function initializeRealtime(server, db) {
  io = new Server(server, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
    transports: ['websocket', 'polling'],
    allowEIO3: false,
  });
  io.use(async (socket, next) => {
    try {
      const claims = jwt.verify(socket.handshake.auth?.token ?? '', env.JWT_ACCESS_SECRET);
      const propertyId = Number(socket.handshake.auth?.propertyId);
      if (!Number.isInteger(propertyId) || propertyId < 1 || Number(claims.activePropertyId) !== propertyId) {
        return next(new Error('Invalid property session'));
      }
      const [rows] = await db.execute(
        `SELECT property.id, user.id AS user_id, user.role_id
         FROM user_properties membership
         JOIN users user ON user.id = membership.user_id AND user.is_active = 1
         JOIN properties property ON property.id = membership.property_id AND property.is_active = 1
         WHERE membership.user_id = ? AND membership.property_id = ?
           AND property.organization_id = ? LIMIT 1`,
        [claims.sub, propertyId, claims.orgId],
      );
      if (!rows.length) return next(new Error('Property access denied'));
      const [permissions] = await db.execute(
        'SELECT permission_key FROM role_permissions WHERE role_id = ?',
        [rows[0].role_id],
      );
      const keys = new Set(permissions.map((row) => row.permission_key));
      socket.data.propertyId = propertyId;
      if (['housekeeping.view', 'housekeeping.work', 'housekeeping.assign', 'housekeeping.inspect'].some((key) => keys.has(key))) {
        socket.join(`p:${propertyId}:housekeeping`);
      }
      if (['checkin.perform', 'reservations.view'].some((key) => keys.has(key))) {
        socket.join(`p:${propertyId}:frontdesk`);
      }
      if (keys.has('maintenance.manage')) socket.join(`p:${propertyId}:maintenance`);
      const disconnectAfter = Math.max(0, claims.exp * 1000 - Date.now());
      setTimeout(() => socket.disconnect(true), disconnectAfter).unref();
      return next();
    } catch {
      return next(new Error('Invalid or expired access token'));
    }
  });
  return io;
}

export function publishRoomStatus(propertyId, room) {
  if (!io) return;
  const payload = {
    propertyId: Number(propertyId),
    roomId: Number(room.roomId),
    status: room.status,
    updatedAt: new Date().toISOString(),
  };
  io.to(`p:${propertyId}:housekeeping`)
    .to(`p:${propertyId}:frontdesk`)
    .to(`p:${propertyId}:maintenance`)
    .emit('room:status', payload);
}

export function publishMaintenanceUpdate(propertyId, update) {
  if (!io) return;
  io.to(`p:${propertyId}:maintenance`).emit('maintenance:ticket', {
    propertyId: Number(propertyId),
    ...update,
    updatedAt: new Date().toISOString(),
  });
}
