import { performance } from 'node:perf_hooks';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';
import { loadPropertyReport } from '../src/reports/metrics.js';

const reservationCount = 50_000;
const batchSize = 500;
const reportDays = 366;
const prefix = `PH14${Date.now().toString(36).toUpperCase()}`;

if (env.NODE_ENV === 'production' || !env.DB_NAME.startsWith('shms_phase14_')) {
  throw new Error('Report benchmark requires a non-production DB_NAME beginning with "shms_phase14_"');
}

function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function placeholders(count) {
  return Array.from({ length: count }, () => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
}

try {
  const [fixtures] = await pool.execute(
    `SELECT property.id AS property_id, property.business_date, guest.id AS guest_id,
            room_type.id AS room_type_id, user.id AS user_id
     FROM properties property
     JOIN guests guest ON guest.property_id = property.id
     JOIN rooms room ON room.property_id = property.id AND room.is_active = 1
     JOIN room_types room_type ON room_type.id = room.room_type_id AND room_type.property_id = property.id
     JOIN users user ON user.organization_id = property.organization_id
     WHERE property.is_active = 1
     ORDER BY property.id, guest.id, room.id, user.id
     LIMIT 1`,
  );
  if (!fixtures[0]) throw new Error('Benchmark database must contain a seeded property, room, guest, and user');

  const property = fixtures[0];
  const to = String(property.business_date).slice(0, 10);
  const from = shiftDate(to, -(reportDays - 1));
  const [beforeRows] = await pool.execute(
    'SELECT COUNT(*) AS count FROM reservations WHERE property_id = ? AND created_at >= ? AND created_at < ?',
    [property.property_id, `${from} 00:00:00`, `${shiftDate(to, 1)} 00:00:00`],
  );

  for (let start = 0; start < reservationCount; start += batchSize) {
    const size = Math.min(batchSize, reservationCount - start);
    const values = [];
    for (let offset = 0; offset < size; offset += 1) {
      const index = start + offset;
      const createdDate = shiftDate(from, index % reportDays);
      values.push(
        property.property_id,
        `${prefix}${String(index).padStart(5, '0')}`,
        property.guest_id,
        'phone',
        'cancelled',
        createdDate,
        shiftDate(createdDate, 1),
        1,
        0,
        property.room_type_id,
        null,
        null,
        0,
        property.user_id,
        `${createdDate} 12:00:00`,
        `${createdDate} 12:00:00`,
      );
    }
    await pool.execute(
      `INSERT INTO reservations
       (property_id, confirmation_no, primary_guest_id, source, status, check_in_date,
        check_out_date, adults, children, room_type_id, assigned_room_id, rate_plan_id,
        total_estimate, created_by, created_at, updated_at)
       VALUES ${placeholders(size)}`,
      values,
    );
  }
  const [afterRows] = await pool.execute(
    'SELECT COUNT(*) AS count FROM reservations WHERE property_id = ? AND confirmation_no LIKE ?',
    [property.property_id, `${prefix}%`],
  );
  if (Number(afterRows[0].count) !== reservationCount) {
    throw new Error(`Expected ${reservationCount} benchmark reservations; found ${afterRows[0].count}`);
  }

  const samples = [];
  let queryTimings = [];
  let result;
  for (let run = 0; run < 4; run += 1) {
    const currentQueryTimings = [];
    const timedDb = {
      execute: async (sql, parameters) => {
        const startedAt = performance.now();
        try {
          return await pool.execute(sql, parameters);
        } finally {
          currentQueryTimings.push({
            sql: sql.replace(/\s+/g, ' ').trim().slice(0, 140),
            elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
          });
        }
      },
    };
    const start = performance.now();
    result = await loadPropertyReport(timedDb, Number(property.property_id), from, to, true);
    const elapsedMs = performance.now() - start;
    if (run > 0) {
      samples.push(Number(elapsedMs.toFixed(1)));
      queryTimings = currentQueryTimings;
    }
  }
  const expectedReservations = Number(beforeRows[0].count) + reservationCount;
  if (result.reservations.created !== expectedReservations) {
    throw new Error(`Report counted ${result.reservations.created} reservations; expected ${expectedReservations}`);
  }

  console.log(JSON.stringify({
    database: env.DB_NAME,
    engine: (await pool.query('SELECT VERSION() AS version'))[0][0].version,
    propertyId: Number(property.property_id),
    range: { from, to, days: reportDays },
    generatedReservations: reservationCount,
    totalReservationsInReport: result.reservations.created,
    warmupRuns: 1,
    measuredRunsMs: samples,
    medianMs: Number([...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)].toFixed(1)),
    queryTimings: queryTimings.sort((left, right) => right.elapsedMs - left.elapsedMs),
    targetMs: 2000,
    withinTarget: samples.every((elapsedMs) => elapsedMs < 2000),
  }, null, 2));
} finally {
  await pool.execute(
    'DELETE FROM reservations WHERE confirmation_no LIKE ?',
    [`${prefix}%`],
  );
  await pool.end();
}
