import { z } from 'zod';

const moneySchema = z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/);
const positiveMoneySchema = moneySchema.refine((value) => {
  const [whole, fraction = ''] = value.split('.');
  return (BigInt(whole) * 100n) + BigInt((fraction + '00').slice(0, 2)) > 0n;
});
const dayCount = z.number().int().min(0).max(30);
const ruleDefinitions = {
  arrival_reminder: {
    title: 'Upcoming arrival',
    description: 'Notify the front desk about confirmed arrivals on the configured date.',
    audience: 'front_desk',
    actionUrl: '/reservations',
    schema: z.object({ daysAhead: dayCount.default(1) }).strict(),
  },
  departure_reminder: {
    title: 'Upcoming departure',
    description: 'Notify the front desk about in-house guests departing on the configured date.',
    audience: 'front_desk',
    actionUrl: '/front-desk',
    schema: z.object({ daysAhead: dayCount.default(1) }).strict(),
  },
  overdue_tasks: {
    title: 'Overdue housekeeping task',
    description: 'Notify the housekeeping supervisor when an actionable task passes its due time.',
    audience: 'housekeeping_supervisor',
    actionUrl: '/housekeeping',
    schema: z.object({ overdueMinutes: z.number().int().min(0).max(43200).default(0) }).strict(),
  },
  blocking_ticket: {
    title: 'Room-blocking maintenance ticket',
    description: 'Notify maintenance about open tickets that block a guest room.',
    audience: 'maintenance_staff',
    actionUrl: '/maintenance',
    schema: z.object({}).strict(),
  },
  outstanding_balance: {
    title: 'Outstanding guest balance',
    description: 'Notify the cashier about open folios at or above the configured balance.',
    audience: 'cashier_accountant',
    actionUrl: '/finance',
    schema: z.object({ minimumBalance: positiveMoneySchema.default('0.01') }).strict(),
  },
  unusual_adjustment: {
    title: 'Unusual folio adjustment',
    description: 'Notify the owner about adjustment requests at or above the configured amount.',
    audience: 'owner_gm',
    actionUrl: '/finance',
    schema: z.object({ minimumAmount: positiveMoneySchema.default('1000.00') }).strict(),
  },
  no_show_candidates: {
    title: 'Reservation may be a no-show',
    description: 'Notify the front desk about confirmed reservations whose arrival date passed without check-in.',
    audience: 'front_desk',
    actionUrl: '/reservations',
    schema: z.object({}).strict(),
  },
  low_stock: {
    title: 'Inventory at or below reorder level',
    description: 'Notify the cashier about active inventory items at or below their reorder level.',
    audience: 'cashier_accountant',
    actionUrl: '/operations',
    schema: z.object({}).strict(),
  },
  checkout_housekeeping: {
    title: 'Create checkout housekeeping task',
    description: 'Checkout creates a cleaning task transactionally; this rule is event-driven, not scheduled.',
    audience: null,
    actionUrl: '/housekeeping',
    mode: 'event',
    schema: z.object({}).strict(),
  },
};

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function parseJson(value, code, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw Object.assign(httpError(500, code, `${label} contains invalid JSON`), { cause: error });
  }
}

function addDays(date, days) {
  const value = new Date(`${String(date).slice(0, 10)}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function findMatches(connection, propertyId, businessDate, ruleKey, config) {
  if (ruleKey === 'arrival_reminder') {
    const date = addDays(businessDate, config.daysAhead);
    const [rows] = await connection.execute(
      `SELECT reservation.id, reservation.confirmation_no, reservation.check_in_date,
              CONCAT_WS(' ', guest.first_name, guest.last_name) AS guest_name
       FROM reservations reservation
       LEFT JOIN guests guest ON guest.id = reservation.primary_guest_id
         AND guest.property_id = reservation.property_id
       WHERE reservation.property_id = ? AND reservation.status = 'confirmed'
         AND reservation.check_in_date = ? ORDER BY reservation.id`,
      [propertyId, date],
    );
    return rows.map((row) => ({
      entity: 'reservation', entityId: String(row.id), cycle: date,
      observed: { confirmationNo: row.confirmation_no, arrivalDate: date, guestName: row.guest_name },
      reason: `Confirmed reservation ${row.confirmation_no} arrives on ${date}.`,
      criteria: { status: 'confirmed', arrivalDate: date },
    }));
  }
  if (ruleKey === 'departure_reminder') {
    const date = addDays(businessDate, config.daysAhead);
    const [rows] = await connection.execute(
      `SELECT stay.id, reservation.confirmation_no, reservation.check_out_date,
              room.room_number, CONCAT_WS(' ', guest.first_name, guest.last_name) AS guest_name
       FROM stays stay
       JOIN reservations reservation ON reservation.id = stay.reservation_id
         AND reservation.property_id = stay.property_id
       JOIN rooms room ON room.id = stay.room_id AND room.property_id = stay.property_id
       LEFT JOIN guests guest ON guest.id = reservation.primary_guest_id
         AND guest.property_id = reservation.property_id
       WHERE stay.property_id = ? AND stay.status = 'in_house'
         AND reservation.check_out_date = ? ORDER BY stay.id`,
      [propertyId, date],
    );
    return rows.map((row) => ({
      entity: 'stay', entityId: String(row.id), cycle: date,
      observed: { confirmationNo: row.confirmation_no, departureDate: date, roomNumber: row.room_number, guestName: row.guest_name },
      reason: `Guest in room ${row.room_number} is scheduled to depart on ${date}.`,
      criteria: { stayStatus: 'in_house', departureDate: date },
    }));
  }
  if (ruleKey === 'overdue_tasks') {
    const [rows] = await connection.execute(
      `SELECT task.id, task.type, task.status, task.due_at, room.room_number
       FROM housekeeping_tasks task
       JOIN rooms room ON room.id = task.room_id AND room.property_id = task.property_id
       WHERE task.property_id = ? AND task.due_at IS NOT NULL
         AND task.due_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${config.overdueMinutes} MINUTE)
         AND task.status IN ('pending', 'assigned', 'in_progress', 'awaiting_inspection', 'rejected')
       ORDER BY task.due_at, task.id`,
      [propertyId],
    );
    return rows.map((row) => ({
      entity: 'housekeeping_task', entityId: String(row.id), cycle: businessDate,
      observed: { taskType: row.type, status: row.status, dueAt: row.due_at, roomNumber: row.room_number },
      reason: `Task ${row.id} for room ${row.room_number} is ${row.status} and was due at ${row.due_at}.`,
      criteria: { dueBefore: `now minus ${config.overdueMinutes} minutes`, actionableStatuses: ['pending', 'assigned', 'in_progress', 'awaiting_inspection', 'rejected'] },
    }));
  }
  if (ruleKey === 'blocking_ticket') {
    const [rows] = await connection.execute(
      `SELECT ticket.id, ticket.category, ticket.priority, ticket.status, ticket.description,
              room.room_number
       FROM maintenance_tickets ticket
       LEFT JOIN rooms room ON room.id = ticket.room_id AND room.property_id = ticket.property_id
       WHERE ticket.property_id = ? AND ticket.blocks_room = 1
         AND ticket.status IN ('open', 'assigned', 'in_progress')
       ORDER BY ticket.opened_at, ticket.id`,
      [propertyId],
    );
    return rows.map((row) => ({
      entity: 'maintenance_ticket', entityId: String(row.id), cycle: businessDate,
      observed: { category: row.category, priority: row.priority, status: row.status, roomNumber: row.room_number },
      reason: `Ticket ${row.id} is ${row.status} and blocks room ${row.room_number ?? 'inventory'}.`,
      criteria: { blocksRoom: true, activeStatuses: ['open', 'assigned', 'in_progress'] },
    }));
  }
  if (ruleKey === 'outstanding_balance') {
    const [rows] = await connection.execute(
      `SELECT folio.id, folio.guest_id, folio.stay_id,
              CAST(COALESCE(charges.total, 0) - COALESCE(payments.total, 0)
                + COALESCE(adjustments.total, 0) AS DECIMAL(12, 2)) AS balance,
              CONCAT_WS(' ', guest.first_name, guest.last_name) AS guest_name
       FROM folios folio
       LEFT JOIN guests guest ON guest.id = folio.guest_id AND guest.property_id = folio.property_id
       LEFT JOIN (
         SELECT property_id, folio_id, SUM(amount) AS total FROM folio_charges GROUP BY property_id, folio_id
       ) charges ON charges.property_id = folio.property_id AND charges.folio_id = folio.id
       LEFT JOIN (
         SELECT property_id, folio_id, SUM(amount) AS total FROM folio_payments GROUP BY property_id, folio_id
       ) payments ON payments.property_id = folio.property_id AND payments.folio_id = folio.id
       LEFT JOIN (
         SELECT property_id, folio_id,
                SUM(CASE type WHEN 'discount' THEN -amount WHEN 'write_off' THEN -amount
                    WHEN 'correction' THEN amount ELSE 0 END) AS total
         FROM adjustments WHERE status = 'approved' GROUP BY property_id, folio_id
       ) adjustments ON adjustments.property_id = folio.property_id AND adjustments.folio_id = folio.id
       WHERE folio.property_id = ? AND folio.status = 'open'
       HAVING balance >= ? ORDER BY folio.id`,
      [propertyId, config.minimumBalance],
    );
    return rows.map((row) => ({
      entity: 'folio', entityId: String(row.id), cycle: businessDate,
      observed: { balance: String(row.balance), guestName: row.guest_name },
      reason: `Open folio ${row.id} has an outstanding balance of ${row.balance}.`,
      criteria: { status: 'open', minimumBalance: config.minimumBalance },
    }));
  }
  if (ruleKey === 'unusual_adjustment') {
    const [rows] = await connection.execute(
      `SELECT adjustment.id, adjustment.folio_id, adjustment.type, adjustment.amount,
              adjustment.status, adjustment.reason
       FROM adjustment_requests adjustment
       WHERE adjustment.property_id = ? AND adjustment.status IN ('pending', 'approved')
         AND adjustment.amount >= ? ORDER BY adjustment.id`,
      [propertyId, config.minimumAmount],
    );
    return rows.map((row) => ({
      entity: 'adjustment_request', entityId: String(row.id), cycle: businessDate,
      observed: { folioId: Number(row.folio_id), type: row.type, amount: String(row.amount), status: row.status, reason: row.reason },
      reason: `Adjustment request ${row.id} for folio ${row.folio_id} is ${row.status} at ${row.amount}.`,
      criteria: { status: ['pending', 'approved'], minimumAmount: config.minimumAmount },
    }));
  }
  if (ruleKey === 'no_show_candidates') {
    const [rows] = await connection.execute(
      `SELECT reservation.id, reservation.confirmation_no, reservation.check_in_date,
              reservation.check_out_date,
              CONCAT_WS(' ', guest.first_name, guest.last_name) AS guest_name
       FROM reservations reservation
       LEFT JOIN guests guest ON guest.id = reservation.primary_guest_id
         AND guest.property_id = reservation.property_id
       WHERE reservation.property_id = ? AND reservation.status = 'confirmed'
         AND reservation.check_in_date < ? AND reservation.check_out_date > ?
       ORDER BY reservation.check_in_date, reservation.id`,
      [propertyId, businessDate, businessDate],
    );
    return rows.map((row) => ({
      entity: 'reservation', entityId: String(row.id), cycle: businessDate,
      observed: { confirmationNo: row.confirmation_no, arrivalDate: String(row.check_in_date).slice(0, 10), guestName: row.guest_name },
      reason: `Reservation ${row.confirmation_no} has not checked in after its arrival date.`,
      criteria: { status: 'confirmed', arrivalDateBefore: businessDate, departureDateAfter: businessDate },
    }));
  }
  if (ruleKey === 'low_stock') {
    const [rows] = await connection.execute(
      `SELECT id, name, unit, quantity, reorder_level
       FROM inventory_items
       WHERE property_id = ? AND deleted_at IS NULL AND quantity <= reorder_level
       ORDER BY name, id`,
      [propertyId],
    );
    return rows.map((row) => ({
      entity: 'inventory_item', entityId: String(row.id), cycle: businessDate,
      observed: { name: row.name, unit: row.unit, quantity: String(row.quantity), reorderLevel: String(row.reorder_level) },
      reason: `${row.name} stock is ${row.quantity} ${row.unit}; reorder level is ${row.reorder_level}.`,
      criteria: { quantityAtOrBelowReorderLevel: true },
    }));
  }
  return [];
}

export function getAutomationRuleDefinitions() {
  return ruleDefinitions;
}

export async function runPropertyAutomation(db, propertyId) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [properties] = await connection.execute(
      'SELECT business_date FROM properties WHERE id = ? AND is_active = 1 FOR UPDATE',
      [propertyId],
    );
    if (!properties[0]) throw httpError(404, 'PROPERTY_NOT_FOUND', 'Property not found');
    const businessDate = String(properties[0].business_date).slice(0, 10);
    const [rules] = await connection.execute(
      'SELECT `key`, enabled, config FROM automation_rules WHERE property_id = ? ORDER BY `key` FOR UPDATE',
      [propertyId],
    );
    const ruleRows = new Map(rules.map((rule) => [rule.key, rule]));
    const results = [];

    for (const [ruleKey, definition] of Object.entries(ruleDefinitions)) {
      if (definition.mode === 'event') {
        results.push({ ruleKey, mode: 'event', matched: 0, notificationsCreated: 0, duplicatesSuppressed: 0 });
        continue;
      }
      const rule = ruleRows.get(ruleKey);
      if (!rule) {
        results.push({ ruleKey, mode: 'scheduled', status: 'not_configured', matched: 0, notificationsCreated: 0, duplicatesSuppressed: 0 });
        continue;
      }
      if (rule.enabled === 0 || rule.enabled === false) {
        results.push({ ruleKey, mode: 'scheduled', status: 'disabled', matched: 0, notificationsCreated: 0, duplicatesSuppressed: 0 });
        continue;
      }

      const configResult = definition.schema.safeParse(parseJson(rule.config, 'INVALID_RULE_CONFIG', ruleKey));
      if (!configResult.success) {
        throw Object.assign(httpError(400, 'INVALID_RULE_CONFIG', `Configuration for ${ruleKey} is invalid`), {
          details: configResult.error.issues,
        });
      }
      const config = configResult.data;
      const matches = await findMatches(connection, propertyId, businessDate, ruleKey, config);
      let notificationsCreated = 0;
      let duplicatesSuppressed = 0;

      for (const match of matches) {
        const dedupeKey = `${ruleKey}:${match.entity}:${match.entityId}:${match.cycle}`;
        const [existing] = await connection.execute(
          'SELECT id FROM automation_log WHERE property_id = ? AND dedupe_key = ? LIMIT 1',
          [propertyId, dedupeKey],
        );
        if (existing[0]) {
          duplicatesSuppressed += 1;
          continue;
        }
        const message = match.reason;
        const explanation = {
          title: definition.title,
          message,
          reason: match.reason,
          criteria: match.criteria,
          observed: match.observed,
          actionUrl: definition.actionUrl,
          audienceRole: definition.audience,
          businessDate,
        };
        await connection.execute(
          `INSERT INTO notifications (property_id, user_id, role, type, payload, read_at, dedupe_key)
           VALUES (?, NULL, ?, ?, ?, NULL, ?)`,
          [propertyId, definition.audience, ruleKey, JSON.stringify(explanation), dedupeKey],
        );
        await connection.execute(
          `INSERT INTO automation_log (property_id, rule_key, entity, entity_id, result, dedupe_key)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [propertyId, ruleKey, match.entity, match.entityId, JSON.stringify(explanation), dedupeKey],
        );
        notificationsCreated += 1;
      }
      results.push({
        ruleKey, mode: 'scheduled', status: 'completed', matched: matches.length,
        notificationsCreated, duplicatesSuppressed,
      });
    }

    await connection.commit();
    return { businessDate, results };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
