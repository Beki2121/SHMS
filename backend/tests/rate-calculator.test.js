import { describe, expect, it } from 'vitest';
import { quote } from '../src/property/rate-calculator.js';

const roomTypes = [{
  id: 1,
  property_id: 7,
  max_adults: 2,
  max_children: 1,
  base_rate: '100.00',
  is_active: 1,
}];
const ratePlans = [{ id: 2, property_id: 7, is_active: 1 }];

function quoteStay(overrides = {}, settings = {}) {
  const request = {
    roomTypeId: 1,
    ratePlanId: 2,
    checkIn: '2026-10-23',
    checkOut: '2026-10-26',
    adults: 2,
    children: 0,
    ...overrides,
  };
  return quote(request, {
    roomTypes,
    ratePlans,
    rates: [],
    taxSettings: {
      vatPercent: 0,
      serviceChargePercent: 0,
      tourismLevyPercent: 0,
      pricesTaxInclusive: false,
      ...settings,
    },
  });
}

describe('property rate calculator', () => {
  it('uses weekday masks for weekend-only rules', () => {
    const result = quote({
      roomTypeId: 1,
      ratePlanId: 2,
      checkIn: '2026-10-23',
      checkOut: '2026-10-26',
      adults: 2,
      children: 0,
    }, {
      roomTypes,
      ratePlans,
      taxSettings: { vatPercent: 0, serviceChargePercent: 0, tourismLevyPercent: 0, pricesTaxInclusive: false },
      rates: [{
        id: 1,
        room_type_id: 1,
        rate_plan_id: 2,
        date_from: '2026-01-01',
        date_to: '2026-12-31',
        weekday_mask: 65,
        amount: '150.00',
        min_stay: 1,
      }],
    });
    expect(result.nightlyRates.map(({ rate, rateRuleId }) => [rate, rateRuleId])).toEqual([
      ['100.00', null],
      ['150.00', 1],
      ['150.00', 1],
    ]);
  });

  it('lets a later-starting seasonal rule override a general rule deterministically', () => {
    const result = quote({
      roomTypeId: 1,
      ratePlanId: 2,
      checkIn: '2026-12-20',
      checkOut: '2026-12-22',
      adults: 2,
      children: 0,
    }, {
      roomTypes,
      ratePlans,
      taxSettings: { vatPercent: 0, serviceChargePercent: 0, tourismLevyPercent: 0, pricesTaxInclusive: false },
      rates: [
        { id: 1, room_type_id: 1, rate_plan_id: 2, date_from: '2026-01-01', date_to: '2026-12-31', weekday_mask: 127, amount: '110.00', min_stay: 1 },
        { id: 2, room_type_id: 1, rate_plan_id: 2, date_from: '2026-12-01', date_to: '2026-12-24', weekday_mask: 127, amount: '200.00', min_stay: 1 },
      ],
    });
    expect(result.nightlyRates.map((night) => [night.rate, night.rateRuleId])).toEqual([
      ['200.00', 2],
      ['200.00', 2],
    ]);
  });

  it('rejects a stay shorter than the matched minimum-stay rule', () => {
    expect(() => quote({
      roomTypeId: 1,
      ratePlanId: 2,
      checkIn: '2026-10-24',
      checkOut: '2026-10-26',
      adults: 1,
      children: 0,
    }, {
      roomTypes,
      ratePlans,
      rates: [{ id: 1, room_type_id: 1, rate_plan_id: 2, date_from: '2026-01-01', date_to: '2026-12-31', weekday_mask: 127, amount: '100.00', min_stay: 3 }],
      taxSettings: { vatPercent: 0, serviceChargePercent: 0, tourismLevyPercent: 0, pricesTaxInclusive: false },
    })).toThrow(expect.objectContaining({ code: 'MIN_STAY_NOT_MET', minimumStay: 3 }));
  });

  it('calculates exclusive and inclusive VAT, service charge and levy in integer cents', () => {
    const exclusive = quoteStay(
      { checkIn: '2026-10-24', checkOut: '2026-10-25', adults: 1 },
      { vatPercent: 15, serviceChargePercent: 10, tourismLevyPercent: 2, pricesTaxInclusive: false },
    );
    expect(exclusive.nightlyRates[0]).toMatchObject({
      rate: '100.00',
      vat: '15.00',
      serviceCharge: '10.00',
      tourismLevy: '2.00',
      total: '127.00',
    });

    const inclusive = quoteStay(
      { checkIn: '2026-10-24', checkOut: '2026-10-25', adults: 1 },
      { vatPercent: 15, serviceChargePercent: 10, tourismLevyPercent: 2, pricesTaxInclusive: true },
    );
    expect(inclusive.nightlyRates[0]).toMatchObject({
      rate: '78.74',
      vat: '11.81',
      serviceCharge: '7.87',
      tourismLevy: '1.58',
      total: '100.00',
    });
  });

  it('rejects invalid dates and over-capacity guest counts', () => {
    expect(() => quoteStay({ checkIn: '2026-02-30' })).toThrow(expect.objectContaining({ code: 'INVALID_DATE' }));
    expect(() => quoteStay({ adults: 3 })).toThrow(expect.objectContaining({ code: 'CAPACITY_EXCEEDED' }));
  });
});
