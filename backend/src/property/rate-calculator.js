const MAX_STAY_NIGHTS = 365;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function dateValue(value, label) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw Object.assign(new Error(`${label} must be an ISO date`), { code: 'INVALID_DATE', status: 400 });
  }
  const [year, month, day] = value.split('-').map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (date.toISOString().slice(0, 10) !== value) {
    throw Object.assign(new Error(`${label} must be a valid calendar date`), { code: 'INVALID_DATE', status: 400 });
  }
  return timestamp;
}

function cents(value, label) {
  const text = String(value);
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) {
    throw Object.assign(new Error(`${label} must be a non-negative amount with at most two decimal places`), {
      code: 'INVALID_RATE',
      status: 400,
    });
  }
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

function basisPoints(value, label) {
  const text = String(value ?? 0);
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(text) || Number(text) > 100) {
    throw Object.assign(new Error(`${label} must be between 0 and 100 percent`), {
      code: 'INVALID_TAX_SETTING',
      status: 400,
    });
  }
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

function roundRatio(numerator, denominator) {
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

function formatCents(amount) {
  const whole = Math.floor(amount / 100);
  const remainder = amount % 100;
  return `${whole}.${String(remainder).padStart(2, '0')}`;
}

function activeRate(rates, roomTypeId, ratePlanId, night, weekday) {
  return rates
    .filter((rate) => Number(rate.room_type_id) === Number(roomTypeId)
      && Number(rate.rate_plan_id) === Number(ratePlanId)
      && String(rate.date_from).slice(0, 10) <= night
      && String(rate.date_to).slice(0, 10) >= night
      && ((rate.weekday_mask === null || rate.weekday_mask === undefined)
        || (Number(rate.weekday_mask) & (1 << weekday)) !== 0))
    .sort((left, right) => String(right.date_from).localeCompare(String(left.date_from))
      || String(right.created_at ?? '').localeCompare(String(left.created_at ?? ''))
      || Number(right.id ?? 0) - Number(left.id ?? 0))[0];
}

function calculateNight(grossOrBaseCents, taxRates, pricesTaxInclusive) {
  const totalBasisPoints = taxRates.reduce((total, [, rate]) => total + rate, 0);
  let baseCents = pricesTaxInclusive
    ? roundRatio(grossOrBaseCents * 10000, 10000 + totalBasisPoints)
    : grossOrBaseCents;
  const components = taxRates.map(([name, rate]) => ({
    name,
    cents: roundRatio(baseCents * rate, 10000),
  }));
  if (pricesTaxInclusive && totalBasisPoints > 0) {
    const finalTax = [...components].reverse().find((component, index) => taxRates[taxRates.length - 1 - index][1] > 0);
    const totalComponentCents = components.reduce((sum, component) => sum + component.cents, 0);
    if (finalTax) finalTax.cents += grossOrBaseCents - baseCents - totalComponentCents;
  }
  const totalCents = pricesTaxInclusive
    ? grossOrBaseCents
    : baseCents + components.reduce((sum, component) => sum + component.cents, 0);
  return {
    baseCents,
    components,
    totalCents,
  };
}

export function quote({ roomTypeId, ratePlanId, checkIn, checkOut, adults, children }, {
  roomTypes,
  ratePlans,
  rates,
  taxSettings,
}) {
  const start = dateValue(checkIn, 'checkIn');
  const end = dateValue(checkOut, 'checkOut');
  const nights = (end - start) / 86_400_000;
  if (nights < 1 || nights > MAX_STAY_NIGHTS) {
    throw Object.assign(new Error(`Stay must be between 1 and ${MAX_STAY_NIGHTS} nights`), {
      code: 'INVALID_STAY_LENGTH',
      status: 400,
    });
  }
  if (!Number.isInteger(adults) || adults < 1 || !Number.isInteger(children) || children < 0) {
    throw Object.assign(new Error('Guest counts are invalid'), { code: 'INVALID_GUEST_COUNTS', status: 400 });
  }

  const roomType = roomTypes.find((item) => Number(item.id) === Number(roomTypeId) && item.is_active);
  const ratePlan = ratePlans.find((item) => Number(item.id) === Number(ratePlanId) && item.is_active);
  if (!roomType || !ratePlan || Number(roomType.property_id) !== Number(ratePlan.property_id)) {
    throw Object.assign(new Error('Room type or rate plan is unavailable'), { code: 'CONFIGURATION_NOT_FOUND', status: 404 });
  }
  if (adults > Number(roomType.max_adults) || children > Number(roomType.max_children)) {
    throw Object.assign(new Error('Guest count exceeds room type capacity'), { code: 'CAPACITY_EXCEEDED', status: 400 });
  }

  const taxRates = [
    ['vat', basisPoints(taxSettings.vatPercent, 'VAT')],
    ['serviceCharge', basisPoints(taxSettings.serviceChargePercent, 'Service charge')],
    ['tourismLevy', basisPoints(taxSettings.tourismLevyPercent, 'Tourism levy')],
  ];
  const pricesTaxInclusive = Boolean(taxSettings.pricesTaxInclusive);
  const nightlyRates = [];
  let minimumStay = 1;

  for (let timestamp = start; timestamp < end; timestamp += 86_400_000) {
    const date = new Date(timestamp);
    const night = date.toISOString().slice(0, 10);
    const rule = activeRate(rates, roomTypeId, ratePlanId, night, date.getUTCDay());
    if (rule) minimumStay = Math.max(minimumStay, Number(rule.min_stay) || 1);
    const sourceAmount = rule?.amount ?? roomType.base_rate;
    const amountCents = cents(sourceAmount, 'Nightly rate');
    const calculation = calculateNight(amountCents, taxRates, pricesTaxInclusive);
    const breakdown = Object.fromEntries(
      calculation.components.map(({ name, cents: amount }) => [name, formatCents(amount)]),
    );
    nightlyRates.push({
      date: night,
      rate: formatCents(calculation.baseCents),
      ...breakdown,
      total: formatCents(calculation.totalCents),
      rateRuleId: rule ? Number(rule.id) : null,
    });
  }
  if (nights < minimumStay) {
    throw Object.assign(new Error(`This rate requires a minimum stay of ${minimumStay} nights`), {
      code: 'MIN_STAY_NOT_MET',
      status: 422,
      minimumStay,
    });
  }

  const total = nightlyRates.reduce((sums, night) => {
    for (const [key, value] of Object.entries(night)) {
      if (key === 'date' || key === 'rateRuleId') continue;
      sums[key] = (sums[key] ?? 0) + cents(value, key);
    }
    return sums;
  }, {});
  return {
    currency: 'ETB',
    roomTypeId: Number(roomType.id),
    ratePlanId: Number(ratePlan.id),
    checkIn,
    checkOut,
    nights,
    nightlyRates,
    totals: Object.fromEntries(Object.entries(total).map(([key, value]) => [key, formatCents(value)])),
  };
}
