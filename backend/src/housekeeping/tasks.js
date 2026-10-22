export async function createHousekeepingTask(connection, {
  propertyId,
  roomId,
  type,
  dueAt = null,
  priority = 3,
  sourceRule = null,
  isReadinessTask = ['checkout_clean', 'deep_clean'].includes(type),
  priorityReason = null,
}) {
  const [rooms] = await connection.execute(
    `SELECT room.room_type_id, property.business_date, property.housekeeping_same_day_priority
     FROM rooms room JOIN properties property ON property.id = room.property_id
     WHERE room.property_id = ? AND room.id = ?`,
    [propertyId, roomId],
  );
  if (!rooms[0]) throw new Error('Room not found while creating housekeeping task');
  const dueAtForDatabase = dueAt ? new Date(dueAt).toISOString().slice(0, 19).replace('T', ' ') : null;
  const businessDate = String(rooms[0].business_date).slice(0, 10);
  let effectivePriority = priority;
  let effectivePriorityReason = priorityReason;
  if (rooms[0].housekeeping_same_day_priority) {
    const [arrivals] = await connection.execute(
      `SELECT reservation.id FROM reservations reservation
       LEFT JOIN reservation_rooms line ON line.reservation_id = reservation.id
         AND line.property_id = reservation.property_id AND line.room_id = ?
       WHERE reservation.property_id = ? AND reservation.status IN ('tentative', 'confirmed')
         AND reservation.check_in_date = ?
         AND (reservation.assigned_room_id = ? OR line.room_id = ?) LIMIT 1`,
      [roomId, propertyId, businessDate, roomId, roomId],
    );
    if (arrivals.length) {
      effectivePriority = 1;
      effectivePriorityReason = `Same-day arrival: room assigned for ${businessDate}`;
    }
  }
  const [insert] = await connection.execute(
    `INSERT INTO housekeeping_tasks
      (property_id, room_id, type, priority, status, due_at, source_rule, is_readiness_task, priority_reason)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    [propertyId, roomId, type, effectivePriority, dueAtForDatabase, sourceRule, isReadinessTask, effectivePriorityReason],
  );
  const taskId = Number(insert.insertId);
  const [templates] = await connection.execute(
    `SELECT id FROM housekeeping_checklists
     WHERE property_id = ? AND is_active = 1 AND (room_type_id = ? OR room_type_id IS NULL)
     ORDER BY room_type_id IS NULL, id LIMIT 1`,
    [propertyId, rooms[0].room_type_id],
  );
  if (templates[0]) {
    await connection.execute(
      `INSERT INTO task_checklist_items
        (property_id, task_id, checklist_id, label, is_required, is_complete)
       SELECT property_id, ?, checklist_id, label, is_required, 0
       FROM housekeeping_checklist_items
       WHERE property_id = ? AND checklist_id = ?
       ORDER BY sort_order, id`,
      [taskId, propertyId, templates[0].id],
    );
  }
  return taskId;
}
