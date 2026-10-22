import { describe, expect, it } from 'vitest';
import { calculateOccupancy, buildReportSections } from '../src/reports/metrics.js';

describe('report metric calculations', () => {
  it('excludes maintenance-blocked room-nights and checkout nights from occupancy', () => {
    const result = calculateOccupancy(
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      [{ room_id: 3, opened_at: '2026-10-01 09:00:00', cleared_at: '2026-10-02 10:00:00' }],
      [
        { room_id: 1, checked_in_at: '2026-09-30 15:00:00', checked_out_at: null },
        { room_id: 3, checked_in_at: '2026-10-01 12:00:00', checked_out_at: '2026-10-02 08:00:00' },
      ],
      '2026-10-01',
      '2026-10-02',
      '2026-10-01',
    );

    expect(result.availableRoomNights).toBe(5);
    expect(result.occupiedRoomNights).toBe(2);
    expect((result.occupiedRoomNights / result.availableRoomNights) * 100).toBe(40);
    expect(result.currentBlocked.has(3)).toBe(true);
  });

  it('omits financial sections unless financial data is supplied', () => {
    const report = {
      current: { rooms: { occupied: 1, available: 2, outOfService: 0 }, occupancyPercent: 33 },
      occupancy: { occupiedRoomNights: 1, availableRoomNights: 3, occupancyPercent: 33, adr: 0, revpar: 0 },
      reservations: { created: 0, cancelled: 0, cancellationRatePercent: 0, averageLeadTimeDays: 0, arrivals: 0, departures: 0 },
      housekeeping: { completed: 0, averageCleaningMinutes: 0 },
      maintenance: { open: 0, overdue: 0, meanResolutionHours: 0 },
      staff: { scheduledShifts: 0, coveredShifts: 0, coveragePercent: 0, attendanceRecords: 0, overtimeMinutes: 0 },
    };

    expect(buildReportSections(report).some(([section]) => section === 'Revenue and payments')).toBe(false);
  });

  it('uses the property timezone to assign UTC timestamps to local room nights', () => {
    const result = calculateOccupancy(
      [{ id: 1 }, { id: 2 }],
      [{ room_id: 2, opened_at: '2026-09-30 22:30:00', cleared_at: '2026-10-01 22:30:00' }],
      [{ room_id: 1, checked_in_at: '2026-09-30 22:00:00', checked_out_at: '2026-10-01 21:00:00' }],
      '2026-10-01',
      '2026-10-02',
      '2026-10-01',
      'Africa/Addis_Ababa',
    );

    expect(result.availableRoomNights).toBe(3);
    expect(result.occupiedRoomNights).toBe(1);
    expect(result.currentBlocked.has(2)).toBe(true);
  });
});
