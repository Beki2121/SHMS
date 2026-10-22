const dateFormatterCache = new Map();
const boundaryFormatterCache = new Map();

function dateFormatter(timeZone) {
  if (!dateFormatterCache.has(timeZone)) {
    dateFormatterCache.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }));
  }
  return dateFormatterCache.get(timeZone);
}

function dateText(value, timeZone = 'UTC') {
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const timestamp = new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  const parts = dateFormatter(timeZone).formatToParts(timestamp);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function localMidnightUtc(date, timeZone) {
  const target = new Date(`${date}T00:00:00.000Z`).getTime();
  if (!boundaryFormatterCache.has(timeZone)) {
    boundaryFormatterCache.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }));
  }
  const formatter = boundaryFormatterCache.get(timeZone);
  let timestamp = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp))
      .map((part) => [part.type, part.value]));
    const localAsUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
    timestamp = target - (localAsUtc - timestamp);
  }
  return new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ');
}

function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dateRangeDays(from, to) {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  return Math.round((end - start) / 86400000) + 1;
}

function bucketStart(date, unit) {
  if (unit === 'month') return `${date.slice(0, 7)}-01`;
  const value = new Date(`${date}T00:00:00.000Z`);
  const weekday = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - weekday);
  return value.toISOString().slice(0, 10);
}

function percentage(numerator, denominator) {
  return denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(2));
}

function amount(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
}

function quantity(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(3)) : 0;
}

function moneyCents(value) {
  const text = String(value ?? '0');
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const cents = (BigInt(whole || '0') * 100n) + BigInt((fraction + '00').slice(0, 2));
  return negative ? -cents : cents;
}

function fromCents(value) {
  const cents = BigInt(value);
  const sign = cents < 0n ? '-' : '';
  const absolute = cents < 0n ? -cents : cents;
  return Number(`${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`);
}

function dateSetAdd(set, roomId, date) {
  set.add(`${roomId}:${date}`);
}

export function calculateOccupancy(roomRows, tickets, stays, from, to, businessDate, timeZone = 'UTC') {
  const days = dateRangeDays(from, to);
  const toExclusive = shiftDate(to, 1);
  const roomIds = new Set(roomRows.map((room) => Number(room.id)));
  const blockedNights = new Set();
  for (const ticket of tickets) {
    if (!roomIds.has(Number(ticket.room_id))) continue;
    const openedAt = dateText(ticket.opened_at, timeZone);
    const start = openedAt < from ? from : openedAt;
    const ticketEnd = ticket.cleared_at ? dateText(ticket.cleared_at, timeZone) : toExclusive;
    const end = ticketEnd < toExclusive ? ticketEnd : toExclusive;
    for (let date = start; date < end; date = shiftDate(date, 1)) {
      dateSetAdd(blockedNights, Number(ticket.room_id), date);
    }
  }
  const occupiedNights = new Set();
  for (const stay of stays) {
    if (!roomIds.has(Number(stay.room_id))) continue;
    const checkedIn = dateText(stay.checked_in_at, timeZone);
    const start = checkedIn < from ? from : checkedIn;
    const checkedOut = stay.checked_out_at ? dateText(stay.checked_out_at, timeZone) : toExclusive;
    const end = checkedOut < toExclusive ? checkedOut : toExclusive;
    for (let date = start; date < end; date = shiftDate(date, 1)) {
      dateSetAdd(occupiedNights, Number(stay.room_id), date);
    }
  }
  for (const night of blockedNights) occupiedNights.delete(night);
  const availableRoomNights = Math.max(0, (roomRows.length * days) - blockedNights.size);
  const occupiedRoomNights = Math.min(occupiedNights.size, availableRoomNights);
  const currentBlocked = new Set([...blockedNights]
    .filter((entry) => entry.endsWith(`:${businessDate}`))
    .map((entry) => Number(entry.split(':')[0])));
  for (const room of roomRows) {
    if (room.status === 'BLOCKED_MAINTENANCE') currentBlocked.add(Number(room.id));
  }
  return {
    blockedNights,
    occupiedRoomNights,
    availableRoomNights,
    currentBlocked,
    days,
  };
}

export function buildReportSections(data) {
  const financial = data.financial;
  return [
    ['Current rooms', [
      ['Occupied rooms', data.current.rooms.occupied],
      ['Available rooms', data.current.rooms.available],
      ['Out-of-service rooms', data.current.rooms.outOfService],
      ['Current occupancy %', data.current.occupancyPercent],
      ['Arrivals today', data.current.arrivals],
      ['Departures today', data.current.departures],
    ]],
    ['Date-range occupancy', [
      ['Occupied room-nights', data.occupancy.occupiedRoomNights],
      ['Available room-nights', data.occupancy.availableRoomNights],
      ['Occupancy %', data.occupancy.occupancyPercent],
      ['ADR', data.occupancy.adr],
      ['RevPAR', data.occupancy.revpar],
    ]],
    ['Reservations', [
      ['Reservations created', data.reservations.created],
      ['Cancellations', data.reservations.cancelled],
      ['Cancellation rate %', data.reservations.cancellationRatePercent],
      ['Average lead time days', data.reservations.averageLeadTimeDays],
      ['Arrivals in range', data.reservations.arrivals],
      ['Departures in range', data.reservations.departures],
    ]],
    ...(financial ? [
      ['Revenue and payments', [
        ['Folio charges', financial.revenue.total],
        ['Room revenue', financial.revenue.room],
        ['Payments received', financial.payments.total],
        ['Outstanding open balances', financial.outstanding.total],
      ]],
      ['Revenue by day', financial.revenue.byDay.map((row) => [row.date, row.total])],
      ['Revenue by week', financial.revenue.byWeek.map((row) => [row.period, row.total])],
      ['Revenue by month', financial.revenue.byMonth.map((row) => [row.period, row.total])],
      ['Revenue by room type', financial.revenue.byRoomType.map((row) => [row.roomType, row.total])],
      ['Revenue by charge type', financial.revenue.byChargeType.map((row) => [row.chargeType, row.total])],
      ['Payments by method', financial.payments.byMethod.map((row) => [row.method, row.total])],
      ['Outstanding ageing', financial.outstanding.ageing.map((row) => [row.ageBucket, row.balance])],
      ['Cashier reconciliation', [
        ['Closed shifts', financial.cashier.totalShifts],
        ['Total variance', financial.cashier.totalVariance],
        ...financial.cashier.shifts.map((shift) => [
          `${shift.cashierName} · ${shift.closedAt ?? 'open'} · ${shift.status}`,
          shift.variance,
        ]),
      ]],
      ['Expenses', [
        ['Total expenses', financial.expenses.total],
        ...financial.expenses.byCategory.map((row) => [row.category, row.total]),
      ]],
      ['Inventory movements', financial.inventory.movements
        .map((row) => [row.movementType, `${row.count} movements · ${row.quantity} units`])],
    ] : []),
    ['Housekeeping', [
      ['Tasks completed', data.housekeeping.completed],
      ['Average cleaning minutes', data.housekeeping.averageCleaningMinutes],
    ]],
    ['Maintenance', [
      ['Open tickets', data.maintenance.open],
      ['Overdue tickets', data.maintenance.overdue],
      ['Mean time to resolve hours', data.maintenance.meanResolutionHours],
    ]],
    ['Staff coverage', [
      ['Scheduled shifts', data.staff.scheduledShifts],
      ['Covered shifts', data.staff.coveredShifts],
      ['Coverage %', data.staff.coveragePercent],
      ['Attendance records', data.staff.attendanceRecords],
      ['Overtime minutes', data.staff.overtimeMinutes],
    ]],
  ];
}

export async function loadPropertyReport(db, propertyId, from, to, includeFinancial) {
  const days = dateRangeDays(from, to);
  const toExclusive = shiftDate(to, 1);
  const [properties] = await db.execute(
    'SELECT name, business_date, currency, timezone FROM properties WHERE id = ? AND is_active = 1 LIMIT 1',
    [propertyId],
  );
  if (!properties[0]) {
    const error = Object.assign(new Error('Property not found'), { status: 404, code: 'PROPERTY_NOT_FOUND' });
    throw error;
  }
  const timeZone = properties[0].timezone;
  const businessDate = dateText(properties[0].business_date);
  const fromTimestamp = localMidnightUtc(from, timeZone);
  const toTimestamp = localMidnightUtc(toExclusive, timeZone);
  const [
    [roomRows],
    [blockingTickets],
    [stayRows],
    [reservationLeadRows],
    [arrivalStats],
    [departureStats],
    [todayArrivalStats],
    [todayDepartureStats],
    [housekeepingStats],
    [maintenanceStats],
    [staffStats],
    [attendanceStats],
  ] = await Promise.all([
    db.execute(
      `SELECT id, status FROM rooms
       WHERE property_id = ? AND is_active = 1 AND deleted_at IS NULL`,
      [propertyId],
    ),
    db.execute(
      `SELECT room_id, opened_at, cleared_at FROM maintenance_tickets
       WHERE property_id = ? AND room_id IS NOT NULL AND blocks_room = 1
         AND opened_at < ? AND (cleared_at IS NULL OR cleared_at >= ?)`,
      [propertyId, toTimestamp, fromTimestamp],
    ),
    db.execute(
      `SELECT stay.room_id, stay.checked_in_at, stay.checked_out_at
       FROM stays stay
      WHERE stay.property_id = ? AND stay.checked_in_at < ?
        AND (stay.checked_out_at IS NULL OR stay.checked_out_at >= ?)`,
      [propertyId, toTimestamp, fromTimestamp],
    ),
    db.execute(
      `SELECT check_in_date, created_at, status FROM reservations
       WHERE property_id = ? AND created_at >= ? AND created_at < ?`,
      [propertyId, fromTimestamp, toTimestamp],
    ),
    db.execute(
      `SELECT COUNT(*) AS total FROM reservations
       WHERE property_id = ? AND check_in_date BETWEEN ? AND ?
         AND status IN ('tentative', 'confirmed', 'checked_in')`,
      [propertyId, from, to],
    ),
    db.execute(
      `SELECT COUNT(*) AS total FROM reservations
       WHERE property_id = ? AND check_out_date BETWEEN ? AND ?
         AND status IN ('confirmed', 'checked_in', 'checked_out')`,
      [propertyId, from, to],
    ),
    db.execute(
      `SELECT COUNT(*) AS total FROM reservations
       WHERE property_id = ? AND check_in_date = ?
         AND status IN ('tentative', 'confirmed')`,
      [propertyId, businessDate],
    ),
    db.execute(
      `SELECT COUNT(*) AS total FROM reservations
       WHERE property_id = ? AND check_out_date = ?
         AND status IN ('confirmed', 'checked_in')`,
      [propertyId, businessDate],
    ),
    db.execute(
      `SELECT COUNT(*) AS created,
              SUM(completed_at IS NOT NULL) AS completed,
              AVG(CASE WHEN started_at IS NOT NULL AND completed_at >= started_at
                THEN TIMESTAMPDIFF(SECOND, started_at, completed_at) / 60 END) AS average_cleaning_minutes
       FROM housekeeping_tasks
       WHERE property_id = ? AND created_at >= ? AND created_at < ?`,
      [propertyId, fromTimestamp, toTimestamp],
    ),
    db.execute(
      `SELECT SUM(status IN ('open', 'assigned', 'in_progress')) AS open_count,
              SUM(status IN ('open', 'assigned', 'in_progress')
                AND opened_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)) AS overdue_count,
              AVG(CASE WHEN resolved_at IS NOT NULL AND resolved_at >= opened_at
                    AND opened_at >= ? AND opened_at < ?
                THEN TIMESTAMPDIFF(SECOND, opened_at, resolved_at) / 3600 END) AS mean_resolution_hours
       FROM maintenance_tickets
       WHERE property_id = ?`,
      [fromTimestamp, toTimestamp, propertyId],
    ),
    db.execute(
      `SELECT COUNT(DISTINCT assignment.id) AS scheduled_shifts,
              COUNT(DISTINCT attendance.id) AS covered_shifts
       FROM shift_assignments assignment
       LEFT JOIN attendance ON attendance.property_id = assignment.property_id
         AND attendance.employee_id = assignment.employee_id AND attendance.date = assignment.date
       WHERE assignment.property_id = ? AND assignment.date BETWEEN ? AND ?`,
      [propertyId, from, to],
    ),
    db.execute(
      `SELECT COUNT(*) AS attendance_records, COALESCE(SUM(overtime_minutes), 0) AS overtime_minutes
       FROM attendance WHERE property_id = ? AND date BETWEEN ? AND ?`,
      [propertyId, from, to],
    ),
  ]);

  const roomNights = calculateOccupancy(roomRows, blockingTickets, stayRows, from, to, businessDate, timeZone);
  const { availableRoomNights, occupiedRoomNights, currentBlocked } = roomNights;
  const [currentStayRows] = await db.execute(
    `SELECT COUNT(DISTINCT room_id) AS count FROM stays
     WHERE property_id = ? AND status = 'in_house'`,
    [propertyId],
  );
  const currentOccupied = Number(currentStayRows[0].count);
  const currentAvailable = roomRows.filter((room) => ['CLEAN', 'AVAILABLE_CLEAN'].includes(room.status)
    && !currentBlocked.has(Number(room.id))).length;
  const currentOutOfService = currentBlocked.size;
  const currentDenominator = Math.max(0, roomRows.length - currentOutOfService);

  const totalLeadDays = reservationLeadRows.reduce((total, row) => {
    const createdDate = dateText(row.created_at, timeZone);
    const leadDays = dateRangeDays(createdDate, dateText(row.check_in_date)) - 1;
    return total + Math.max(0, leadDays);
  }, 0);
  const reservations = {
    created: reservationLeadRows.length,
    cancelled: reservationLeadRows.filter((row) => row.status === 'cancelled').length,
    averageLeadTimeDays: reservationLeadRows.length
      ? Number((totalLeadDays / reservationLeadRows.length).toFixed(1)) : 0,
    arrivals: Number(arrivalStats[0].total ?? 0),
    departures: Number(departureStats[0].total ?? 0),
  };
  reservations.cancellationRatePercent = percentage(reservations.cancelled, reservations.created);
  const housekeeping = {
    created: Number(housekeepingStats[0].created ?? 0),
    completed: Number(housekeepingStats[0].completed ?? 0),
    completionPercent: percentage(Number(housekeepingStats[0].completed ?? 0), Number(housekeepingStats[0].created ?? 0)),
    averageCleaningMinutes: housekeepingStats[0].average_cleaning_minutes === null
      ? 0 : Number(Number(housekeepingStats[0].average_cleaning_minutes).toFixed(1)),
  };
  const staff = {
    scheduledShifts: Number(staffStats[0].scheduled_shifts ?? 0),
    coveredShifts: Number(staffStats[0].covered_shifts ?? 0),
    attendanceRecords: Number(attendanceStats[0].attendance_records ?? 0),
    overtimeMinutes: Number(attendanceStats[0].overtime_minutes ?? 0),
  };
  staff.coveragePercent = percentage(staff.coveredShifts, staff.scheduledShifts);
  const maintenance = {
    open: Number(maintenanceStats[0].open_count ?? 0),
    overdue: Number(maintenanceStats[0].overdue_count ?? 0),
    meanResolutionHours: maintenanceStats[0].mean_resolution_hours === null
      ? 0 : Number(Number(maintenanceStats[0].mean_resolution_hours).toFixed(1)),
  };

  let financial = null;
  if (includeFinancial) {
    const [
      [chargeRows],
      [roomTypeRows],
      [paymentRows],
      [balanceRows],
      [shiftRows],
      [shiftSummaryRows],
      [expenseRows],
      [inventoryRows],
    ] = await Promise.all([
      db.execute(
        `SELECT business_date, charge_type, SUM(amount) AS amount
         FROM folio_charges WHERE property_id = ? AND business_date BETWEEN ? AND ?
         GROUP BY business_date, charge_type ORDER BY business_date`,
        [propertyId, from, to],
      ),
      db.execute(
        `SELECT COALESCE(room_type.name, 'Unassigned') AS room_type, SUM(charge.amount) AS amount
         FROM folio_charges charge
         JOIN folios folio ON folio.id = charge.folio_id AND folio.property_id = charge.property_id
         LEFT JOIN stays stay ON stay.id = folio.stay_id AND stay.property_id = folio.property_id
         LEFT JOIN rooms room ON room.id = stay.room_id AND room.property_id = stay.property_id
         LEFT JOIN room_types room_type ON room_type.id = room.room_type_id AND room_type.property_id = room.property_id
         WHERE charge.property_id = ? AND charge.business_date BETWEEN ? AND ?
           AND charge.charge_type = 'room'
         GROUP BY room_type.name ORDER BY amount DESC`,
        [propertyId, from, to],
      ),
      db.execute(
        `SELECT method, SUM(amount) AS amount, COUNT(*) AS count
         FROM folio_payments WHERE property_id = ? AND created_at >= ? AND created_at < ?
         GROUP BY method ORDER BY method`,
        [propertyId, fromTimestamp, toTimestamp],
      ),
      db.execute(
        `SELECT CASE
            WHEN DATEDIFF(?, folio.opened_at) <= 30 THEN '0-30 days'
            WHEN DATEDIFF(?, folio.opened_at) <= 60 THEN '31-60 days'
            WHEN DATEDIFF(?, folio.opened_at) <= 90 THEN '61-90 days'
            ELSE '90+ days' END AS age_bucket,
          SUM(COALESCE(charges.amount, 0) - COALESCE(payments.amount, 0)
            + COALESCE(adjustments.amount, 0)) AS balance,
          COUNT(*) AS folios
         FROM folios folio
         LEFT JOIN (SELECT property_id, folio_id, SUM(amount) AS amount
                    FROM folio_charges GROUP BY property_id, folio_id) charges
           ON charges.property_id = folio.property_id AND charges.folio_id = folio.id
         LEFT JOIN (SELECT property_id, folio_id, SUM(amount) AS amount
                    FROM folio_payments GROUP BY property_id, folio_id) payments
           ON payments.property_id = folio.property_id AND payments.folio_id = folio.id
         LEFT JOIN (SELECT property_id, folio_id,
                      SUM(CASE type WHEN 'discount' THEN -amount WHEN 'write_off' THEN -amount
                        WHEN 'correction' THEN amount ELSE 0 END) AS amount
                    FROM adjustments WHERE status = 'approved' GROUP BY property_id, folio_id) adjustments
           ON adjustments.property_id = folio.property_id AND adjustments.folio_id = folio.id
         WHERE folio.property_id = ? AND folio.status = 'open'
         GROUP BY age_bucket
         HAVING SUM(COALESCE(charges.amount, 0) - COALESCE(payments.amount, 0)
           + COALESCE(adjustments.amount, 0)) > 0
         ORDER BY MIN(folio.opened_at)`,
        [businessDate, businessDate, businessDate, propertyId],
      ),
      db.execute(
        `SELECT shift.id, shift.cashier_id, user.name AS cashier_name, shift.status,
                shift.variance, shift.opened_at, shift.closed_at
         FROM cashier_shifts shift
         JOIN users user ON user.id = shift.cashier_id
         WHERE shift.property_id = ? AND shift.closed_at >= ? AND shift.closed_at < ?
         ORDER BY shift.closed_at DESC, shift.id DESC LIMIT 500`,
        [propertyId, fromTimestamp, toTimestamp],
      ),
      db.execute(
        `SELECT COUNT(*) AS total_shifts, COALESCE(SUM(variance), 0) AS total_variance
         FROM cashier_shifts
         WHERE property_id = ? AND closed_at >= ? AND closed_at < ?`,
        [propertyId, fromTimestamp, toTimestamp],
      ),
      db.execute(
        `SELECT category.name AS category, SUM(expense.amount) AS amount, COUNT(*) AS count
         FROM expenses expense
         LEFT JOIN expense_categories category ON category.id = expense.category_id
           AND category.property_id = expense.property_id
         WHERE expense.property_id = ? AND expense.deleted_at IS NULL
           AND expense.expense_date BETWEEN ? AND ?
         GROUP BY category.name ORDER BY amount DESC`,
        [propertyId, from, to],
      ),
      db.execute(
        `SELECT movement.movement_type, COUNT(*) AS count, SUM(movement.quantity) AS quantity
         FROM inventory_movements movement
         WHERE movement.property_id = ? AND movement.created_at >= ? AND movement.created_at < ?
         GROUP BY movement.movement_type ORDER BY movement.movement_type`,
        [propertyId, fromTimestamp, toTimestamp],
      ),
    ]);
    const dailyTotals = new Map();
    const revenueByType = new Map();
    for (const row of chargeRows) {
      const day = dateText(row.business_date);
      const value = moneyCents(row.amount);
      dailyTotals.set(day, (dailyTotals.get(day) ?? 0n) + value);
      revenueByType.set(row.charge_type, (revenueByType.get(row.charge_type) ?? 0n) + value);
    }
    const revenueByDay = [...dailyTotals.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([date, total]) => ({ date, total: fromCents(total) }));
    const bucketRevenue = (unit) => {
      const values = new Map();
      for (const [date, total] of dailyTotals) {
        const bucket = bucketStart(date, unit);
        values.set(bucket, (values.get(bucket) ?? 0n) + total);
      }
      return [...values.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([period, total]) => ({ period, total: fromCents(total) }));
    };
    const revenueTotal = [...revenueByType.values()].reduce((sum, value) => sum + value, 0n);
    const roomRevenueCents = revenueByType.get('room') ?? 0n;
    const paymentsTotal = paymentRows.reduce((sum, row) => sum + moneyCents(row.amount), 0n);
    const outstanding = balanceRows.map((row) => ({
      ageBucket: row.age_bucket, balance: fromCents(moneyCents(row.balance)), folios: Number(row.folios),
    }));
    const shifts = shiftRows.map((row) => ({
      id: Number(row.id), cashierId: Number(row.cashier_id), cashierName: row.cashier_name,
      status: row.status, variance: fromCents(moneyCents(row.variance)), openedAt: row.opened_at, closedAt: row.closed_at,
    }));
    financial = {
      revenue: {
        total: fromCents(revenueTotal),
        room: fromCents(roomRevenueCents),
        byChargeType: [...revenueByType.entries()].map(([chargeType, total]) => ({ chargeType, total: fromCents(total) })),
        byDay: revenueByDay,
        byWeek: bucketRevenue('week'),
        byMonth: bucketRevenue('month'),
        byRoomType: roomTypeRows.map((row) => ({ roomType: row.room_type, total: amount(row.amount) })),
      },
      payments: {
        total: fromCents(paymentsTotal),
        byMethod: paymentRows.map((row) => ({ method: row.method, total: fromCents(moneyCents(row.amount)), count: Number(row.count) })),
      },
      outstanding: {
        total: fromCents(outstanding.reduce((sum, row) => sum + moneyCents(row.balance), 0n)),
        ageing: outstanding,
      },
      cashier: {
        totalShifts: Number(shiftSummaryRows[0].total_shifts ?? 0),
        totalVariance: fromCents(moneyCents(shiftSummaryRows[0].total_variance)),
        shifts,
      },
      expenses: {
        total: fromCents(expenseRows.reduce((sum, row) => sum + moneyCents(row.amount), 0n)),
        byCategory: expenseRows.map((row) => ({
          category: row.category ?? 'Uncategorized', total: fromCents(moneyCents(row.amount)), count: Number(row.count),
        })),
      },
      inventory: {
        movements: inventoryRows.map((row) => ({
          movementType: row.movement_type, count: Number(row.count), quantity: quantity(row.quantity),
        })),
      },
    };
  }

  const occupiedEffective = occupiedRoomNights;
  const roomRevenue = financial?.revenue.room ?? 0;
  return {
    property: { id: propertyId, name: properties[0].name, currency: properties[0].currency },
    range: { from, to, days },
    dashboardRole: 'management',
    current: {
      businessDate,
      rooms: {
        occupied: currentOccupied,
        available: currentAvailable,
        outOfService: currentOutOfService,
        total: roomRows.length,
      },
      occupancyPercent: percentage(currentOccupied, currentDenominator),
      arrivals: Number(todayArrivalStats[0].total ?? 0),
      departures: Number(todayDepartureStats[0].total ?? 0),
    },
    occupancy: {
      occupiedRoomNights: occupiedEffective,
      availableRoomNights,
      occupancyPercent: percentage(occupiedEffective, availableRoomNights),
      adr: financial ? (occupiedEffective ? amount(roomRevenue / occupiedEffective) : 0) : null,
      revpar: financial ? (availableRoomNights ? amount(roomRevenue / availableRoomNights) : 0) : null,
      roomRevenue: financial ? amount(roomRevenue) : null,
    },
    reservations,
    housekeeping,
    maintenance,
    staff,
    financial,
  };
}
