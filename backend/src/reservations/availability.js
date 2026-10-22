const DAY_MS = 86_400_000;
const ACTIVE_STATUSES = ['tentative', 'confirmed', 'checked_in'];

export function parseStayDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw Object.assign(new Error(`${label} must be an ISO date`), { code: 'INVALID_DATE', status: 400 });
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw Object.assign(new Error(`${label} must be a valid date`), { code: 'INVALID_DATE', status: 400 });
  }
  return date;
}

export function stayNights(checkIn, checkOut, maximum = 365) {
  const start = parseStayDate(checkIn, 'checkIn');
  const end = parseStayDate(checkOut, 'checkOut');
  const count = (end.getTime() - start.getTime()) / DAY_MS;
  if (!Number.isInteger(count) || count < 1 || count > maximum) {
    throw Object.assign(
      new Error(`Stay must be between 1 and ${maximum} nights`),
      { code: 'INVALID_STAY_LENGTH', status: 400 },
    );
  }
  const nights = [];
  for (let timestamp = start.getTime(); timestamp < end.getTime(); timestamp += DAY_MS) {
    nights.push(new Date(timestamp).toISOString().slice(0, 10));
  }
  return nights;
}

export async function getAvailability(connection, propertyId, checkIn, checkOut, {
  roomTypeId = null,
  excludeReservationId = null,
} = {}) {
  const nights = stayNights(checkIn, checkOut);
  const typeParams = [propertyId];
  const typeFilter = roomTypeId ? ' AND rt.id = ?' : '';
  if (roomTypeId) typeParams.push(roomTypeId);
  const [roomTypes] = await connection.execute(
    `SELECT rt.id, rt.name, rt.max_adults, rt.max_children, rt.base_rate,
            COUNT(room.id) AS physical_rooms
     FROM room_types rt
     LEFT JOIN rooms room
       ON room.property_id = rt.property_id AND room.room_type_id = rt.id
      AND room.is_active = 1 AND room.deleted_at IS NULL
      AND room.status <> 'BLOCKED_MAINTENANCE'
      AND NOT EXISTS (
        SELECT 1 FROM maintenance_tickets ticket
        WHERE ticket.property_id = room.property_id AND ticket.room_id = room.id
          AND ticket.blocks_room = 1 AND ticket.status <> 'closed'
      )
     WHERE rt.property_id = ? AND rt.is_active = 1 AND rt.deleted_at IS NULL${typeFilter}
     GROUP BY rt.id, rt.name, rt.max_adults, rt.max_children, rt.base_rate
     ORDER BY rt.name`,
    typeParams,
  );
  if (!roomTypes.length) {
    return nights.map((night) => ({ date: night, roomTypes: [] }));
  }

  const start = nights[0];
  const end = checkOut;
  const params = [propertyId, ...ACTIVE_STATUSES, start, end];
  let exclusion = '';
  if (excludeReservationId !== null) {
    exclusion = ' AND reservation.id <> ?';
    params.push(excludeReservationId);
  }
  const [physicalRows] = await connection.execute(
    `SELECT DISTINCT room.room_type_id, room.id AS room_id, room_night.night
     FROM room_nights room_night
     JOIN reservations reservation ON reservation.id = room_night.reservation_id
       AND reservation.property_id = room_night.property_id
     JOIN rooms room ON room.id = room_night.room_id AND room.property_id = room_night.property_id
     WHERE room_night.property_id = ? AND reservation.status IN (?, ?, ?)
       AND room_night.night >= ? AND room_night.night < ?${exclusion}`,
    params,
  );

  const unassignedParams = [propertyId, ...ACTIVE_STATUSES, end, start];
  let unassignedExclusion = '';
  if (excludeReservationId !== null) {
    unassignedExclusion = ' AND reservation.id <> ?';
    unassignedParams.push(excludeReservationId);
  }
  const [unassignedRows] = await connection.execute(
    `SELECT reservation.id AS reservation_id, reservation.room_type_id,
            reservation.check_in_date, reservation.check_out_date,
            reservation.assigned_room_id, reservation.status,
            reservation_room.id AS reservation_room_id, reservation_room.room_id
     FROM reservations reservation
     LEFT JOIN reservation_rooms reservation_room
       ON reservation_room.property_id = reservation.property_id
      AND reservation_room.reservation_id = reservation.id
     WHERE reservation.property_id = ? AND reservation.status IN (?, ?, ?)
       AND reservation.check_in_date < ? AND reservation.check_out_date > ?${unassignedExclusion}`,
    unassignedParams,
  );

  const roomsByType = new Map(roomTypes.map((type) => [Number(type.id), Number(type.physical_rooms)]));
  const physicalBooked = new Map();
  for (const row of physicalRows) {
    const key = `${row.night}:${row.room_type_id}`;
    if (!physicalBooked.has(key)) physicalBooked.set(key, new Set());
    physicalBooked.get(key).add(Number(row.room_id));
  }

  const reservations = new Map();
  for (const row of unassignedRows) {
    if (!reservations.has(Number(row.reservation_id))) reservations.set(Number(row.reservation_id), []);
    reservations.get(Number(row.reservation_id)).push(row);
  }
  const unassignedByNight = new Map();
  for (const rows of reservations.values()) {
    const reservation = rows[0];
    const hasRoomLines = rows.some((row) => row.reservation_room_id !== null);
    let unassigned = hasRoomLines
      ? rows.filter((row) => row.reservation_room_id !== null && row.room_id === null).length
      : reservation.assigned_room_id === null ? 1 : 0;
    if (!unassigned) continue;
    const reservationNights = stayNights(
      String(reservation.check_in_date).slice(0, 10),
      String(reservation.check_out_date).slice(0, 10),
    );
    for (const night of reservationNights) {
      if (night < start || night >= end) continue;
      const key = `${night}:${reservation.room_type_id}`;
      unassignedByNight.set(key, (unassignedByNight.get(key) ?? 0) + unassigned);
    }
  }

  return nights.map((night) => ({
    date: night,
    roomTypes: roomTypes.map((type) => {
      const id = Number(type.id);
      const key = `${night}:${id}`;
      const occupied = physicalBooked.get(key)?.size ?? 0;
      const unassignedReservations = unassignedByNight.get(key) ?? 0;
      const totalRooms = roomsByType.get(id) ?? 0;
      return {
        id,
        name: type.name,
        maxAdults: Number(type.max_adults),
        maxChildren: Number(type.max_children),
        baseRate: String(type.base_rate),
        totalRooms,
        occupiedRooms: occupied,
        unassignedReservations,
        availableRooms: Math.max(0, totalRooms - occupied - unassignedReservations),
      };
    }),
  }));
}
