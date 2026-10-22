import { Router } from 'express';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { auditable } from '../auth/audit.js';
import { authenticate, propertyScope, requirePermission } from '../auth/middleware.js';
import { logger } from '../config/logger.js';
import { quote } from '../property/rate-calculator.js';

const positiveId = z.coerce.number().int().positive();
const amountSchema = z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/);
const chargeSchema = z.object({
  type: z.enum(['service', 'minibar', 'laundry', 'other']),
  description: z.string().trim().min(1).max(255),
  amount: amountSchema,
});
const catalogChargeSchema = z.object({
  serviceId: positiveId,
  quantity: z.coerce.number().int().min(1).max(1000).default(1),
});
const paymentSchema = z.object({
  method: z.enum(['cash', 'bank_transfer', 'card_manual', 'mobile_manual', 'deposit_transfer']),
  amount: amountSchema,
  reference: z.string().trim().max(190).nullable().optional(),
  isDeposit: z.boolean().default(false),
  idempotencyKey: z.string().trim().min(8).max(80),
  approveCredit: z.boolean().default(false),
  creditReason: z.string().trim().min(3).max(500).optional(),
});
const adjustmentSchema = z.object({
  type: z.enum(['discount', 'correction', 'refund', 'write_off']),
  amount: amountSchema,
  reason: z.string().trim().min(3).max(1000),
  paymentId: positiveId.optional(),
});
const decisionSchema = z.object({
  action: z.enum(['approve', 'reject']),
  reason: z.string().trim().min(3).max(500).optional(),
});
const shiftOpenSchema = z.object({ openingFloat: amountSchema, notes: z.string().trim().max(1000).nullable().optional() });
const shiftCloseSchema = z.object({
  countedCash: amountSchema,
  notes: z.string().trim().max(1000).nullable().optional(),
});
const nightAuditSchema = z.object({ businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

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

function cents(value) {
  const [whole, fraction = ''] = String(value ?? '0').split('.');
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
}

function money(value) {
  const amount = BigInt(value);
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : null;
}

function nextDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function parseTaxSettings(value) {
  return typeof value === 'string' ? JSON.parse(value) : value ?? {};
}

function beginPdf(res, fileName, pageSize = 'A4') {
  const document = new PDFDocument({ size: pageSize, margin: 42 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  document.pipe(res);
  return document;
}

function pdfHeader(document, propertyName, title, number, issuedAt, duplicate = false) {
  document.fontSize(19).fillColor('#146b56').text(propertyName, { align: 'center' });
  document.moveDown(0.5).fontSize(15).fillColor('#26332d').text(title, { align: 'center' });
  document.moveDown(0.25).fontSize(10).text(`${number}${duplicate ? ' · DUPLICATE / REPRINT' : ''}`, { align: 'center' });
  document.fontSize(9).fillColor('#68756d').text(`Issued: ${new Date(issuedAt).toLocaleString()}`, { align: 'center' });
  document.moveDown(1.5).fillColor('#26332d');
}

function pdfLine(document, left, right, y) {
  document.fontSize(9).fillColor('#35433b').text(left, 45, y, { width: 340, continued: false });
  document.text(right, 390, y, { width: 160, align: 'right' });
}

function createInvoicePdf(res, invoice, charges, duplicate) {
  const document = beginPdf(res, `${invoice.number}${duplicate ? '-copy' : ''}.pdf`);
  pdfHeader(document, invoice.property_name, 'Guest invoice', invoice.number, invoice.issued_at, duplicate);
  document.fontSize(9).fillColor('#35433b');
  document.text([invoice.address, invoice.city, invoice.phone, invoice.email].filter(Boolean).join(' · '));
  document.moveDown(0.5);
  document.text(`Guest: ${`${invoice.first_name ?? ''} ${invoice.last_name ?? ''}`.trim() || 'Guest'}`);
  if (invoice.confirmation_no) document.text(`Reservation: ${invoice.confirmation_no}`);
  if (invoice.room_number) document.text(`Room: ${invoice.room_number}`);
  document.moveDown();
  const startY = document.y;
  pdfLine(document, 'Description', 'Amount', startY);
  document.moveTo(45, startY + 13).lineTo(550, startY + 13).strokeColor('#dfe5e1').stroke();
  let y = startY + 22;
  for (const charge of charges) {
    pdfLine(document, `${charge.description} · ${dateOnly(charge.business_date)}`, `ETB ${charge.amount}`, y);
    y += 17;
    if (y > 700) {
      document.addPage();
      y = 45;
    }
  }
  y += 8;
  pdfLine(document, 'Charges', `ETB ${invoice.totals.charges}`, y);
  y += 16;
  pdfLine(document, 'Payments', `ETB ${invoice.totals.payments}`, y);
  y += 16;
  pdfLine(document, 'Balance', `ETB ${invoice.totals.balance}`, y);
  y += 28;
  document.fontSize(8).fillColor('#68756d').text('Operational invoice — not a statutory tax invoice unless stated.', 45, y, { width: 500 });
  document.end();
}

function createReceiptPdf(res, receipt, duplicate) {
  const document = beginPdf(res, `${receipt.number}${duplicate ? '-copy' : ''}.pdf`, [226, 842]);
  pdfHeader(document, receipt.property_name, 'Payment receipt', receipt.number, receipt.issued_at, duplicate);
  document.fontSize(9).fillColor('#35433b');
  document.text(`Guest: ${`${receipt.first_name ?? ''} ${receipt.last_name ?? ''}`.trim() || 'Guest'}`);
  document.text(`Method: ${receipt.method.replaceAll('_', ' ')}`);
  if (receipt.reference) document.text(`Reference: ${receipt.reference}`);
  if (receipt.is_deposit) document.text('Payment type: Deposit');
  document.moveDown();
  document.fontSize(14).fillColor('#146b56').text(`ETB ${receipt.amount}`, { align: 'center' });
  document.moveDown(2).fontSize(8).fillColor('#68756d').text('Thank you.', { align: 'center' });
  document.end();
}

async function propertyForUpdate(connection, propertyId) {
  const [rows] = await connection.execute(
    `SELECT organization_id, currency, business_date, tax_settings,
            adjustment_approval_threshold
     FROM properties WHERE id = ? FOR UPDATE`,
    [propertyId],
  );
  if (!rows[0]) throw httpError(404, 'PROPERTY_NOT_FOUND', 'Property not found');
  return rows[0];
}

async function getFolio(connection, propertyId, folioId, lock = false) {
  const [rows] = await connection.execute(
    `SELECT folio.id, folio.status, folio.guest_id, folio.company_id, folio.stay_id,
            stay.reservation_id, reservation.confirmation_no, guest.first_name, guest.last_name
     FROM folios folio
     LEFT JOIN stays stay ON stay.id = folio.stay_id AND stay.property_id = folio.property_id
     LEFT JOIN reservations reservation ON reservation.id = stay.reservation_id
       AND reservation.property_id = stay.property_id
     LEFT JOIN guests guest ON guest.id = folio.guest_id AND guest.property_id = folio.property_id
     WHERE folio.property_id = ? AND folio.id = ? ${lock ? 'FOR UPDATE' : ''}`,
    [propertyId, folioId],
  );
  if (!rows[0]) throw httpError(404, 'FOLIO_NOT_FOUND', 'Folio not found in this property');
  return rows[0];
}

async function totals(connection, propertyId, folioId) {
  const [rows] = await connection.execute(
    `SELECT
       COALESCE((SELECT SUM(amount) FROM folio_charges WHERE property_id = ? AND folio_id = ?), 0) AS charges,
       COALESCE((SELECT SUM(amount) FROM folio_payments WHERE property_id = ? AND folio_id = ?), 0) AS payments,
       COALESCE((SELECT SUM(CASE type
         WHEN 'discount' THEN -amount WHEN 'write_off' THEN -amount
         WHEN 'correction' THEN amount ELSE 0 END)
         FROM adjustments WHERE property_id = ? AND folio_id = ? AND status = 'approved'), 0) AS adjustments`,
    [propertyId, folioId, propertyId, folioId, propertyId, folioId],
  );
  const charges = cents(rows[0].charges);
  const payments = cents(rows[0].payments);
  const adjustments = cents(rows[0].adjustments);
  return {
    totalCharges: money(charges),
    totalPayments: money(payments),
    totalAdjustments: money(adjustments),
    balance: money(charges - payments + adjustments),
    balanceCents: charges - payments + adjustments,
  };
}

async function allocateNumber(connection, propertyId, kind, prefix) {
  await connection.execute(
    `INSERT INTO number_counters (property_id, kind, next_value)
     VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE next_value = next_value`,
    [propertyId, kind],
  );
  const [rows] = await connection.execute(
    'SELECT next_value FROM number_counters WHERE property_id = ? AND kind = ? FOR UPDATE',
    [propertyId, kind],
  );
  const value = Number(rows[0].next_value);
  await connection.execute(
    'UPDATE number_counters SET next_value = ? WHERE property_id = ? AND kind = ?',
    [value + 1, propertyId, kind],
  );
  return `${prefix}-${String(propertyId).padStart(3, '0')}-${String(value).padStart(8, '0')}`;
}

async function openShift(connection, propertyId, actorId) {
  const [rows] = await connection.execute(
    `SELECT id, opening_float FROM cashier_shifts
     WHERE property_id = ? AND cashier_id = ? AND status = 'open' LIMIT 1 FOR UPDATE`,
    [propertyId, actorId],
  );
  if (!rows[0]) throw httpError(409, 'CASHIER_SHIFT_REQUIRED', 'Open a cashier shift before recording payments or refunds');
  return rows[0];
}

async function appendAdjustment(connection, propertyId, folioId, request, actorId) {
  await connection.execute(
    `INSERT INTO adjustments
      (property_id, folio_id, type, amount, reason, requested_by, approved_by, status, reverses_payment_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, NOW())`,
    [
      propertyId, folioId, request.type, request.amount, request.reason,
      request.requested_by, actorId, request.reverses_payment_id,
    ],
  );
  if (request.type === 'refund') {
    const shift = await openShift(connection, propertyId, actorId);
    const [payments] = await connection.execute(
      `SELECT method, reference FROM folio_payments
       WHERE property_id = ? AND id = ?`,
      [propertyId, request.reverses_payment_id],
    );
    if (!payments[0]) throw httpError(404, 'PAYMENT_NOT_FOUND', 'The payment to refund no longer exists');
    const refundPaymentIdempotency = `refund-request-${request.id}`;
    const [existing] = await connection.execute(
      'SELECT id FROM folio_payments WHERE property_id = ? AND idempotency_key = ? LIMIT 1',
      [propertyId, refundPaymentIdempotency],
    );
    if (!existing.length) {
      const [payment] = await connection.execute(
        `INSERT INTO folio_payments
          (property_id, folio_id, method, amount, reference, shift_id, is_deposit,
           reverses_payment_id, received_by, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [
          propertyId, folioId, payments[0].method, money(-cents(request.amount)),
          payments[0].reference, shift.id, request.reverses_payment_id,
          actorId, refundPaymentIdempotency,
        ],
      );
      const receiptNumber = await allocateNumber(connection, propertyId, 'receipt', 'RCP');
      await connection.execute(
        'INSERT INTO receipts (property_id, payment_id, number, issued_at) VALUES (?, ?, ?, NOW())',
        [propertyId, payment.insertId, receiptNumber],
      );
    }
  }
}

async function postNightlyRate(connection, propertyId, property, stay) {
  const [types] = await connection.execute(
    `SELECT id, property_id, name, max_adults, max_children, base_rate
     FROM room_types WHERE property_id = ? AND id = ? AND is_active = 1 AND deleted_at IS NULL`,
    [propertyId, stay.room_type_id],
  );
  const [plans] = await connection.execute(
    `SELECT id, name FROM rate_plans
     WHERE property_id = ? AND id = ? AND is_active = 1 AND deleted_at IS NULL`,
    [propertyId, stay.rate_plan_id],
  );
  if (!types[0] || !plans[0]) throw httpError(409, 'RATE_CONFIGURATION_MISSING', 'An active rate is required to run night audit');
  const [rates] = await connection.execute(
    `SELECT id, room_type_id, rate_plan_id, date_from, date_to, weekday_mask, amount, min_stay, created_at
     FROM rates WHERE property_id = ? AND room_type_id = ? AND rate_plan_id = ?
       AND date_from <= ? AND date_to >= ? ORDER BY date_from DESC, created_at DESC, id DESC`,
    [propertyId, stay.room_type_id, stay.rate_plan_id, stay.business_date, stay.business_date],
  );
  const result = quote(
    {
      roomTypeId: Number(stay.room_type_id),
      ratePlanId: Number(stay.rate_plan_id),
      checkIn: stay.business_date,
      checkOut: nextDate(stay.business_date),
      adults: Number(stay.adults),
      children: Number(stay.children),
    },
    {
      roomTypes: [{ ...types[0], is_active: 1 }],
      ratePlans: [{ ...plans[0], property_id: propertyId, is_active: 1 }],
      rates,
      taxSettings: parseTaxSettings(property.tax_settings),
    },
  );
  const night = result.nightlyRates[0];
  const items = [
    ['room', `Room charge · ${stay.room_number}`, night.rate],
    ['tax', 'VAT', night.vat ?? '0.00'],
    ['service_charge', 'Service charge', night.serviceCharge ?? '0.00'],
    ['levy', 'Tourism levy', night.tourismLevy ?? '0.00'],
  ];
  for (const [type, description, amount] of items) {
    if (cents(amount) === 0n) continue;
    await connection.execute(
      `INSERT INTO folio_charges
        (property_id, folio_id, charge_type, description, quantity, unit_amount, amount, business_date, posted_by)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [propertyId, stay.folio_id, type, description, amount, amount, stay.business_date, stay.actor_id],
    );
  }

  return cents(night.total);
}

export function createFinanceRouter(db) {
  const router = Router();
  router.use(authenticate(db), propertyScope(db));

  router.get('/folios', requirePermission(db, 'folio.view'), async (req, res, next) => {
    try {
      const status = req.query.status === undefined ? 'open' : String(req.query.status);
      if (!['open', 'closed', 'all'].includes(status)) throw httpError(400, 'INVALID_STATUS', 'Status must be open, closed, or all');
      const statusFilter = status === 'all' ? '' : 'AND folio.status = ?';
      const [rows] = await db.execute(
        `SELECT folio.id, folio.status, folio.guest_id, folio.opened_at, folio.closed_at,
                stay.id AS stay_id, stay.status AS stay_status, room.room_number,
                reservation.confirmation_no, guest.first_name, guest.last_name,
                COALESCE(charges.amount, 0) AS charges, COALESCE(payments.amount, 0) AS payments,
                COALESCE(adjustments.amount, 0) AS adjustments
         FROM folios folio
         LEFT JOIN stays stay ON stay.id = folio.stay_id AND stay.property_id = folio.property_id
         LEFT JOIN rooms room ON room.id = stay.room_id AND room.property_id = stay.property_id
         LEFT JOIN reservations reservation ON reservation.id = stay.reservation_id
           AND reservation.property_id = stay.property_id
         LEFT JOIN guests guest ON guest.id = folio.guest_id AND guest.property_id = folio.property_id
         LEFT JOIN (
           SELECT folio_id, SUM(amount) AS amount FROM folio_charges WHERE property_id = ? GROUP BY folio_id
         ) charges ON charges.folio_id = folio.id
         LEFT JOIN (
           SELECT folio_id, SUM(amount) AS amount FROM folio_payments WHERE property_id = ? GROUP BY folio_id
         ) payments ON payments.folio_id = folio.id
         LEFT JOIN (
           SELECT folio_id, SUM(CASE type WHEN 'discount' THEN -amount
             WHEN 'write_off' THEN -amount WHEN 'correction' THEN amount ELSE 0 END) AS amount
           FROM adjustments WHERE property_id = ? AND status = 'approved' GROUP BY folio_id
         ) adjustments ON adjustments.folio_id = folio.id
         WHERE folio.property_id = ? ${statusFilter}
         ORDER BY folio.id DESC LIMIT 200`,
        [req.propertyId, req.propertyId, req.propertyId, req.propertyId, ...(status === 'all' ? [] : [status])],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id),
        status: row.status,
        stayId: row.stay_id === null ? null : Number(row.stay_id),
        stayStatus: row.stay_status,
        guestId: Number(row.guest_id),
        guestName: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
        confirmationNo: row.confirmation_no,
        roomNumber: row.room_number,
        balance: money(cents(row.charges) - cents(row.payments) + cents(row.adjustments)),
        openedAt: row.opened_at,
        closedAt: row.closed_at,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/folios/:id', requirePermission(db, 'folio.view'), async (req, res, next) => {
    try {
      const id = parse(positiveId, req.params.id);
      const folio = await getFolio(db, req.propertyId, id);
      const [charges] = await db.execute(
        `SELECT id, charge_type, description, quantity, unit_amount, amount, business_date, created_at
         FROM folio_charges WHERE property_id = ? AND folio_id = ? ORDER BY id`,
        [req.propertyId, id],
      );
      const [payments] = await db.execute(
        `SELECT payment.id, payment.method, payment.amount, payment.reference, payment.is_deposit,
                payment.reverses_payment_id, payment.created_at,
                receipt.id AS receipt_id, receipt.number AS receipt_number
         FROM folio_payments payment
         LEFT JOIN receipts receipt ON receipt.payment_id = payment.id AND receipt.property_id = payment.property_id
         WHERE payment.property_id = ? AND payment.folio_id = ? ORDER BY payment.id`,
        [req.propertyId, id],
      );
      const [adjustments] = await db.execute(
        `SELECT id, type, amount, reason, requested_by, approved_by, reverses_payment_id, created_at
         FROM adjustments WHERE property_id = ? AND folio_id = ? ORDER BY id`,
        [req.propertyId, id],
      );
      const [invoices] = await db.execute(
        `SELECT id, number, issued_at, totals FROM invoices
         WHERE property_id = ? AND folio_id = ? ORDER BY id`,
        [req.propertyId, id],
      );
      const [requests] = await db.execute(
        `SELECT id, type, amount, reason, status, requested_by, decided_by, created_at
         FROM adjustment_requests WHERE property_id = ? AND folio_id = ? ORDER BY id`,
        [req.propertyId, id],
      );
      const balance = await totals(db, req.propertyId, id);
      return res.json({ data: {
        id,
        status: folio.status,
        stayId: folio.stay_id === null ? null : Number(folio.stay_id),
        confirmationNo: folio.confirmation_no,
        guestId: folio.guest_id === null ? null : Number(folio.guest_id),
        guestName: `${folio.first_name ?? ''} ${folio.last_name ?? ''}`.trim(),
        ...{
          totalCharges: balance.totalCharges,
          totalPayments: balance.totalPayments,
          totalAdjustments: balance.totalAdjustments,
          balance: balance.balance,
        },
        charges,
        payments: payments.map((payment) => ({
          id: Number(payment.id),
          method: payment.method,
          amount: String(payment.amount),
          reference: payment.reference,
          isDeposit: Boolean(payment.is_deposit),
          reversesPaymentId: payment.reverses_payment_id === null ? null : Number(payment.reverses_payment_id),
          receiptId: payment.receipt_id === null ? null : Number(payment.receipt_id),
          receiptNumber: payment.receipt_number,
          createdAt: payment.created_at,
        })),
        adjustments: adjustments.map((adjustment) => ({
          id: Number(adjustment.id),
          type: adjustment.type,
          amount: String(adjustment.amount),
          reason: adjustment.reason,
          requestedBy: Number(adjustment.requested_by),
          approvedBy: Number(adjustment.approved_by),
          reversesPaymentId: adjustment.reverses_payment_id === null ? null : Number(adjustment.reverses_payment_id),
          createdAt: adjustment.created_at,
        })),
        adjustmentRequests: requests,
        invoices: invoices.map((invoice) => ({
          id: Number(invoice.id),
          number: invoice.number,
          issuedAt: invoice.issued_at,
          totals: typeof invoice.totals === 'string' ? JSON.parse(invoice.totals) : invoice.totals,
        })),
      } });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/folios/:id/charges', requirePermission(db, 'folio.post_charge'), async (req, res, next) => {
    let connection;
    try {
      const id = parse(positiveId, req.params.id);
      const data = parse(chargeSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const property = await propertyForUpdate(connection, req.propertyId);
      const folio = await getFolio(connection, req.propertyId, id, true);
      if (folio.status !== 'open') throw httpError(409, 'FOLIO_CLOSED', 'Charges cannot be posted to a closed folio');
      if (cents(data.amount) === 0n) throw httpError(400, 'INVALID_AMOUNT', 'Charge must be greater than zero');
      const amount = money(cents(data.amount));
      await connection.execute(
        `INSERT INTO folio_charges
          (property_id, folio_id, charge_type, description, quantity, unit_amount, amount, business_date, posted_by)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        [req.propertyId, id, data.type, data.description, amount, amount, dateOnly(property.business_date), req.auth.sub],
      );
      const result = await totals(connection, req.propertyId, id);
      await auditable(connection, {
        organizationId: property.organization_id,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'folio.charge_posted',
        entity: 'folio',
        entityId: id,
        after: { type: data.type, amount, description: data.description, balance: result.balance },
      });
      await connection.commit();
      return res.status(201).json({ data: { folioId: id, amount, balance: result.balance } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/folios/:id/services', requirePermission(db, 'folio.post_charge'), async (req, res, next) => {
    let connection;
    try {
      const id = parse(positiveId, req.params.id);
      const data = parse(catalogChargeSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const property = await propertyForUpdate(connection, req.propertyId);
      const folio = await getFolio(connection, req.propertyId, id, true);
      if (folio.status !== 'open') throw httpError(409, 'FOLIO_CLOSED', 'Charges cannot be posted to a closed folio');
      const [services] = await connection.execute(
        `SELECT id, name, price, category FROM service_catalog
         WHERE property_id = ? AND id = ? AND is_active = 1 AND deleted_at IS NULL
         LIMIT 1 FOR UPDATE`,
        [req.propertyId, data.serviceId],
      );
      const service = services[0];
      if (!service) throw httpError(404, 'SERVICE_NOT_FOUND', 'Active service was not found');
      const unitCents = cents(service.price);
      if (unitCents <= 0n) throw httpError(409, 'INVALID_SERVICE_PRICE', 'The service price must be greater than zero');
      const amount = money(unitCents * BigInt(data.quantity));
      await connection.execute(
        `INSERT INTO folio_charges
          (property_id, folio_id, service_catalog_id, charge_type, description, quantity,
           unit_amount, amount, business_date, posted_by)
         VALUES (?, ?, ?, 'service', ?, ?, ?, ?, ?, ?)`,
        [
          req.propertyId, id, Number(service.id), service.name, data.quantity,
          money(unitCents), amount, dateOnly(property.business_date), req.auth.sub,
        ],
      );
      const result = await totals(connection, req.propertyId, id);
      await auditable(connection, {
        organizationId: property.organization_id,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'folio.service_posted',
        entity: 'folio',
        entityId: id,
        after: {
          serviceId: Number(service.id),
          serviceName: service.name,
          quantity: data.quantity,
          unitAmount: money(unitCents),
          amount,
          balance: result.balance,
        },
      });
      await connection.commit();
      return res.status(201).json({ data: {
        folioId: id,
        serviceId: Number(service.id),
        quantity: data.quantity,
        unitAmount: money(unitCents),
        amount,
        balance: result.balance,
      } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/folios/:id/payments', requirePermission(db, 'folio.take_payment'), async (req, res, next) => {
    let connection;
    try {
      const id = parse(positiveId, req.params.id);
      const data = parse(paymentSchema, req.body);
      if (data.method === 'bank_transfer' && !data.reference) {
        throw httpError(400, 'PAYMENT_REFERENCE_REQUIRED', 'Bank transfers require a reference');
      }
      connection = await db.getConnection();
      await connection.beginTransaction();
      const property = await propertyForUpdate(connection, req.propertyId);
      const folio = await getFolio(connection, req.propertyId, id, true);
      if (folio.status !== 'open') throw httpError(409, 'FOLIO_CLOSED', 'Payments cannot be posted to a closed folio');
      const [duplicateRows] = await connection.execute(
        `SELECT payment.id, payment.amount, receipt.id AS receipt_id, receipt.number
         FROM folio_payments payment
         LEFT JOIN receipts receipt ON receipt.payment_id = payment.id AND receipt.property_id = payment.property_id
         WHERE payment.property_id = ? AND payment.idempotency_key = ? LIMIT 1`,
        [req.propertyId, data.idempotencyKey],
      );
      if (duplicateRows[0]) {
        await connection.commit();
        return res.json({ data: {
          folioId: id,
          paymentId: Number(duplicateRows[0].id),
          receiptId: Number(duplicateRows[0].receipt_id),
          receiptNumber: duplicateRows[0].number,
          amount: String(duplicateRows[0].amount),
          idempotentReplay: true,
        } });
      }
      const shift = await openShift(connection, req.propertyId, req.auth.sub);
      const balance = await totals(connection, req.propertyId, id);
      const amount = cents(data.amount);
      if (amount === 0n) throw httpError(400, 'INVALID_AMOUNT', 'Payment must be greater than zero');
      if (!data.isDeposit && amount > balance.balanceCents
          && (!data.approveCredit || !data.creditReason
            || !(await db.execute(
              `SELECT permission_key FROM role_permissions
               WHERE role_id = ? AND permission_key = 'folio.approve_credit' LIMIT 1`,
              [req.auth.roleId],
            ))[0].length)) {
        throw httpError(409, 'OVERPAYMENT_APPROVAL_REQUIRED', 'Overpayment requires authorized credit approval and a reason');
      }
      const [payment] = await connection.execute(
        `INSERT INTO folio_payments
          (property_id, folio_id, method, amount, reference, shift_id, is_deposit, received_by, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.propertyId, id, data.method, money(amount), data.reference ?? null,
          shift.id, data.isDeposit, req.auth.sub, data.idempotencyKey,
        ],
      );
      const receiptNumber = await allocateNumber(connection, req.propertyId, 'receipt', 'RCP');
      const [receipt] = await connection.execute(
        'INSERT INTO receipts (property_id, payment_id, number, issued_at) VALUES (?, ?, ?, NOW())',
        [req.propertyId, payment.insertId, receiptNumber],
      );
      const newBalance = await totals(connection, req.propertyId, id);
      await auditable(connection, {
        organizationId: property.organization_id,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'folio.payment_received',
        entity: 'folio',
        entityId: id,
        after: {
          paymentId: Number(payment.insertId),
          method: data.method,
          amount: money(amount),
          isDeposit: data.isDeposit,
          receiptNumber,
          balance: newBalance.balance,
          creditApprovalReason: data.approveCredit ? data.creditReason : null,
        },
      });
      await connection.commit();
      return res.status(201).json({ data: {
        folioId: id,
        paymentId: Number(payment.insertId),
        receiptId: Number(receipt.insertId),
        receiptNumber,
        amount: money(amount),
        balance: newBalance.balance,
      } });
    } catch (error) {
      if (connection) await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') {
        try {
          const [rows] = await db.execute(
            `SELECT payment.id, payment.amount, receipt.id AS receipt_id, receipt.number
             FROM folio_payments payment
             LEFT JOIN receipts receipt ON receipt.payment_id = payment.id AND receipt.property_id = payment.property_id
             WHERE payment.property_id = ? AND payment.idempotency_key = ? LIMIT 1`,
            [req.propertyId, req.body?.idempotencyKey],
          );
          if (rows[0]) return res.json({ data: {
            folioId: Number(req.params.id),
            paymentId: Number(rows[0].id),
            receiptId: Number(rows[0].receipt_id),
            receiptNumber: rows[0].number,
            amount: String(rows[0].amount),
            idempotentReplay: true,
          } });
        } catch (lookupError) {
          logger.error({ err: lookupError }, 'Could not resolve an idempotent payment retry');
          return next(lookupError);
        }
      }
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.get('/cashier-shifts/current', requirePermission(db, 'folio.view'), async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT shift.id, shift.opened_at, shift.opening_float, shift.status, shift.notes,
           COALESCE(SUM(CASE WHEN payment.method = 'cash' THEN payment.amount ELSE 0 END), 0) AS cash_collections,
           COALESCE(SUM(CASE WHEN payment.method <> 'cash' THEN payment.amount ELSE 0 END), 0) AS other_collections
         FROM cashier_shifts shift LEFT JOIN folio_payments payment
           ON payment.shift_id = shift.id AND payment.property_id = shift.property_id
         WHERE shift.property_id = ? AND shift.cashier_id = ? AND shift.status = 'open'
         GROUP BY shift.id LIMIT 1`,
        [req.propertyId, req.auth.sub],
      );
      return res.json({ data: rows[0] ? {
        id: Number(rows[0].id),
        openedAt: rows[0].opened_at,
        openingFloat: String(rows[0].opening_float),
        status: rows[0].status,
        notes: rows[0].notes,
        cashCollections: String(rows[0].cash_collections),
        otherCollections: String(rows[0].other_collections),
        expectedCash: money(cents(rows[0].opening_float) + cents(rows[0].cash_collections)),
      } : null });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/cashier-shifts', requirePermission(db, 'reports.view_financial'), async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT shift.id, shift.cashier_id, cashier.name AS cashier_name, shift.opened_at, shift.closed_at,
                shift.opening_float, shift.expected_cash, shift.counted_cash, shift.variance,
                shift.status, shift.notes,
                COALESCE(SUM(CASE WHEN payment.method = 'cash' THEN payment.amount ELSE 0 END), 0) AS cash_collections,
                COALESCE(SUM(CASE WHEN payment.method <> 'cash' THEN payment.amount ELSE 0 END), 0) AS other_collections
         FROM cashier_shifts shift JOIN users cashier ON cashier.id = shift.cashier_id
         LEFT JOIN folio_payments payment ON payment.shift_id = shift.id AND payment.property_id = shift.property_id
         WHERE shift.property_id = ? GROUP BY shift.id ORDER BY shift.id DESC LIMIT 100`,
        [req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id),
        cashierId: Number(row.cashier_id),
        cashierName: row.cashier_name,
        openedAt: row.opened_at,
        closedAt: row.closed_at,
        openingFloat: String(row.opening_float),
        expectedCash: row.expected_cash === null
          ? money(cents(row.opening_float) + cents(row.cash_collections))
          : String(row.expected_cash),
        countedCash: row.counted_cash === null ? null : String(row.counted_cash),
        variance: row.variance === null ? null : String(row.variance),
        cashCollections: String(row.cash_collections),
        otherCollections: String(row.other_collections),
        status: row.status,
        notes: row.notes,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/cashier-shifts/open', requirePermission(db, 'cashier.shift.manage'), async (req, res, next) => {
    let connection;
    try {
      const data = parse(shiftOpenSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const property = await propertyForUpdate(connection, req.propertyId);
      const [userRows] = await connection.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [req.auth.sub]);
      if (!userRows[0]) throw httpError(401, 'USER_UNAVAILABLE', 'User account is unavailable');
      const [existing] = await connection.execute(
        `SELECT id FROM cashier_shifts
         WHERE property_id = ? AND cashier_id = ? AND status = 'open' LIMIT 1`,
        [req.propertyId, req.auth.sub],
      );
      if (existing.length) throw httpError(409, 'SHIFT_ALREADY_OPEN', 'Close the existing cashier shift before opening another');
      const [shift] = await connection.execute(
        `INSERT INTO cashier_shifts (property_id, cashier_id, opened_at, opening_float, status, notes)
         VALUES (?, ?, NOW(), ?, 'open', ?)`,
        [req.propertyId, req.auth.sub, data.openingFloat, data.notes ?? null],
      );
      await auditable(connection, {
        organizationId: property.organization_id,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'cashier_shift.opened',
        entity: 'cashier_shift',
        entityId: shift.insertId,
        after: { openingFloat: data.openingFloat, notes: data.notes ?? null },
      });
      await connection.commit();
      return res.status(201).json({ data: { id: Number(shift.insertId), status: 'open', openingFloat: data.openingFloat } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/cashier-shifts/:id/close', requirePermission(db, 'cashier.shift.manage'), async (req, res, next) => {
    let connection;
    try {
      const id = parse(positiveId, req.params.id);
      const data = parse(shiftCloseSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const property = await propertyForUpdate(connection, req.propertyId);
      const [rows] = await connection.execute(
        `SELECT id, cashier_id, opening_float, status FROM cashier_shifts
         WHERE property_id = ? AND id = ? FOR UPDATE`,
        [req.propertyId, id],
      );
      const shift = rows[0];
      if (!shift) throw httpError(404, 'SHIFT_NOT_FOUND', 'Cashier shift not found');
      if (shift.status !== 'open') throw httpError(409, 'SHIFT_CLOSED', 'Closed cashier shifts cannot be changed');
      if (Number(shift.cashier_id) !== req.auth.sub) throw httpError(403, 'SHIFT_OWNER_REQUIRED', 'Only the cashier who opened this shift can close it');
      const [cashRows] = await connection.execute(
        `SELECT COALESCE(SUM(amount), 0) AS amount FROM folio_payments
         WHERE property_id = ? AND shift_id = ? AND method = 'cash'`,
        [req.propertyId, id],
      );
      const expected = cents(shift.opening_float) + cents(cashRows[0].amount);
      const counted = cents(data.countedCash);
      const variance = counted - expected;
      await connection.execute(
        `UPDATE cashier_shifts
         SET closed_at = NOW(), expected_cash = ?, counted_cash = ?, variance = ?, status = 'closed', notes = ?
         WHERE property_id = ? AND id = ? AND status = 'open'`,
        [money(expected), money(counted), money(variance), data.notes ?? null, req.propertyId, id],
      );
      await auditable(connection, {
        organizationId: property.organization_id,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'cashier_shift.closed',
        entity: 'cashier_shift',
        entityId: id,
        before: { status: 'open' },
        after: { status: 'closed', expectedCash: money(expected), countedCash: money(counted), variance: money(variance) },
      });
      await connection.commit();
      return res.json({ data: { id, status: 'closed', expectedCash: money(expected), countedCash: money(counted), variance: money(variance) } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.get('/adjustment-requests', requirePermission(db, 'folio.adjust'), async (req, res, next) => {
    try {
      const status = req.query.status === 'all' ? '' : "AND request.status = 'pending'";
      const [rows] = await db.execute(
        `SELECT request.id, request.folio_id, request.type, request.amount, request.reason,
                request.requested_by, requester.name AS requester_name, request.reverses_payment_id,
                request.status, request.created_at
         FROM adjustment_requests request JOIN users requester ON requester.id = request.requested_by
         WHERE request.property_id = ? ${status} ORDER BY request.id DESC LIMIT 200`,
        [req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({
        ...row,
        id: Number(row.id),
        folioId: Number(row.folio_id),
        amount: String(row.amount),
        requestedBy: Number(row.requested_by),
        reversesPaymentId: row.reverses_payment_id === null ? null : Number(row.reverses_payment_id),
        requesterName: row.requester_name,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/folios/:id/adjustment-requests', requirePermission(db, 'folio.adjust'), async (req, res, next) => {
    let connection;
    try {
      const folioId = parse(positiveId, req.params.id);
      const data = parse(adjustmentSchema, req.body);
      if (data.type === 'refund' && !data.paymentId) {
        throw httpError(400, 'PAYMENT_REQUIRED', 'A refund must reference its original payment');
      }
      if (data.type !== 'refund' && data.paymentId) {
        throw httpError(400, 'INVALID_PAYMENT_REFERENCE', 'Only refunds may reference a payment');
      }
      connection = await db.getConnection();
      await connection.beginTransaction();
      const property = await propertyForUpdate(connection, req.propertyId);
      const folio = await getFolio(connection, req.propertyId, folioId, true);
      if (folio.status !== 'open') throw httpError(409, 'FOLIO_CLOSED', 'Adjustments cannot be requested for a closed folio');
      if (data.type === 'refund') {
        const permissions = await db.execute(
          `SELECT permission_key FROM role_permissions
           WHERE role_id = ? AND permission_key = 'refund.approve' LIMIT 1`,
          [req.auth.roleId],
        );
        if (!permissions[0].length) throw httpError(403, 'FORBIDDEN', 'Refund requests require refund approval permission');
        const [payments] = await connection.execute(
          `SELECT amount FROM folio_payments
           WHERE property_id = ? AND folio_id = ? AND id = ? AND amount > 0 FOR UPDATE`,
          [req.propertyId, folioId, data.paymentId],
        );
        if (!payments[0]) throw httpError(404, 'PAYMENT_NOT_FOUND', 'The original payment was not found on this folio');
        const [refunds] = await connection.execute(
          `SELECT COALESCE(SUM(amount), 0) AS amount FROM adjustment_requests
           WHERE property_id = ? AND reverses_payment_id = ? AND status <> 'rejected'`,
          [req.propertyId, data.paymentId],
        );
        if (cents(refunds[0].amount) + cents(data.amount) > cents(payments[0].amount)) {
          throw httpError(409, 'REFUND_EXCEEDS_PAYMENT', 'Refunds cannot exceed the original payment amount');
        }
      }
      const threshold = cents(property.adjustment_approval_threshold);
      const amount = cents(data.amount);
      if (amount <= 0n) throw httpError(400, 'INVALID_AMOUNT', 'Adjustment amount must be greater than zero');
      const managerPermission = data.type === 'refund' ? 'refund.approve' : 'folio.adjust';
      const permissions = await db.execute(
        `SELECT permission_key FROM role_permissions WHERE role_id = ? AND permission_key = ? LIMIT 1`,
        [req.auth.roleId, managerPermission],
      );
      const autoApprove = amount <= threshold && permissions[0].length > 0;
      const [requestRow] = await connection.execute(
        `INSERT INTO adjustment_requests
          (property_id, folio_id, type, amount, reason, requested_by, reverses_payment_id,
           status, decided_by, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, IF(? = 'approved', NOW(), NULL))`,
        [
          req.propertyId, folioId, data.type, money(amount), data.reason, req.auth.sub,
          data.paymentId ?? null, autoApprove ? 'approved' : 'pending',
          autoApprove ? req.auth.sub : null, autoApprove ? 'approved' : 'pending',
        ],
      );
      if (autoApprove) {
        const request = {
          id: Number(requestRow.insertId),
          type: data.type,
          amount: money(amount),
          reason: data.reason,
          requested_by: req.auth.sub,
          reverses_payment_id: data.paymentId ?? null,
        };
        await appendAdjustment(connection, req.propertyId, folioId, request, req.auth.sub);
      }
      await auditable(connection, {
        organizationId: property.organization_id,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: autoApprove ? 'folio.adjustment_approved' : 'folio.adjustment_requested',
        entity: 'folio',
        entityId: folioId,
        after: { requestId: Number(requestRow.insertId), type: data.type, amount: money(amount), reason: data.reason },
      });
      await connection.commit();
      return res.status(autoApprove ? 201 : 202).json({ data: {
        id: Number(requestRow.insertId),
        status: autoApprove ? 'approved' : 'pending',
        amount: money(amount),
      } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/adjustment-requests/:id/decision', requirePermission(db, 'folio.adjust'), async (req, res, next) => {
    let connection;
    try {
      const id = parse(positiveId, req.params.id);
      const data = parse(decisionSchema, req.body);
      if (data.action === 'reject' && !data.reason) throw httpError(400, 'REASON_REQUIRED', 'A reason is required to reject an adjustment');
      connection = await db.getConnection();
      await connection.beginTransaction();
      const property = await propertyForUpdate(connection, req.propertyId);
      const [rows] = await connection.execute(
        `SELECT * FROM adjustment_requests
         WHERE property_id = ? AND id = ? FOR UPDATE`,
        [req.propertyId, id],
      );
      const adjustment = rows[0];
      if (!adjustment) throw httpError(404, 'ADJUSTMENT_REQUEST_NOT_FOUND', 'Adjustment request not found');
      if (adjustment.status !== 'pending') throw httpError(409, 'ADJUSTMENT_ALREADY_DECIDED', 'This adjustment request has already been decided');
      if (data.action === 'approve') {
        const permissionKey = adjustment.type === 'refund' ? 'refund.approve' : 'folio.adjust';
        const permissionRows = await db.execute(
          'SELECT permission_key FROM role_permissions WHERE role_id = ? AND permission_key = ? LIMIT 1',
          [req.auth.roleId, permissionKey],
        );
        if (!permissionRows[0].length) throw httpError(403, 'FORBIDDEN', 'You cannot approve this adjustment type');
        if (cents(adjustment.amount) > cents(property.adjustment_approval_threshold)
            && Number(adjustment.requested_by) === req.auth.sub) {
          throw httpError(403, 'SECOND_APPROVER_REQUIRED', 'An adjustment above the configured threshold needs a different approver');
        }
        const [folioRows] = await connection.execute(
          'SELECT status FROM folios WHERE property_id = ? AND id = ? FOR UPDATE',
          [req.propertyId, adjustment.folio_id],
        );
        if (!folioRows[0] || folioRows[0].status !== 'open') throw httpError(409, 'FOLIO_CLOSED', 'The folio is no longer open');
        await appendAdjustment(connection, req.propertyId, Number(adjustment.folio_id), adjustment, req.auth.sub);
      }
      const nextStatus = data.action === 'approve' ? 'approved' : 'rejected';
      await connection.execute(
        `UPDATE adjustment_requests SET status = ?, decided_by = ?, decided_at = NOW()
         WHERE property_id = ? AND id = ? AND status = 'pending'`,
        [nextStatus, req.auth.sub, req.propertyId, id],
      );
      await auditable(connection, {
        organizationId: property.organization_id,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: `folio.adjustment_${nextStatus}`,
        entity: 'adjustment_request',
        entityId: id,
        after: { folioId: Number(adjustment.folio_id), type: adjustment.type, amount: String(adjustment.amount), reason: data.reason ?? adjustment.reason },
      });
      await connection.commit();
      return res.json({ data: { id, status: nextStatus } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.get('/night-audit/status', requirePermission(db, 'night_audit.run'), async (req, res, next) => {
    try {
      const [properties] = await db.execute(
        'SELECT business_date FROM properties WHERE id = ? LIMIT 1',
        [req.propertyId],
      );
      const businessDate = dateOnly(properties[0]?.business_date);
      const [runs] = await db.execute(
        `SELECT id, business_date, posted_stays, total_amount, actor_id, created_at
         FROM night_audit_runs WHERE property_id = ? ORDER BY business_date DESC LIMIT 30`,
        [req.propertyId],
      );
      return res.json({ data: {
        businessDate,
        nextBusinessDate: businessDate ? nextDate(businessDate) : null,
        runs: runs.map((run) => ({
          id: Number(run.id),
          businessDate: dateOnly(run.business_date),
          postedStays: Number(run.posted_stays),
          totalAmount: String(run.total_amount),
          actorId: Number(run.actor_id),
          createdAt: run.created_at,
        })),
      } });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/night-audit/run', requirePermission(db, 'night_audit.run'), async (req, res, next) => {
    let connection;
    try {
      const data = parse(nightAuditSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const property = await propertyForUpdate(connection, req.propertyId);
      const businessDate = data.businessDate;
      const currentBusinessDate = dateOnly(property.business_date);
      const [existingRuns] = await connection.execute(
        `SELECT id, posted_stays, total_amount FROM night_audit_runs
         WHERE property_id = ? AND business_date = ? LIMIT 1`,
        [req.propertyId, businessDate],
      );
      if (existingRuns[0]) {
        await connection.commit();
        return res.json({ data: {
          businessDate,
          nextBusinessDate: dateOnly(property.business_date),
          postedStays: Number(existingRuns[0].posted_stays),
          totalAmount: String(existingRuns[0].total_amount),
          idempotentReplay: true,
        } });
      }
      if (businessDate !== currentBusinessDate) {
        throw httpError(409, 'BUSINESS_DATE_CHANGED', 'Night audit must target the current property business date', {
          currentBusinessDate,
        });
      }
      const [stays] = await connection.execute(
        `SELECT stay.id AS stay_id, stay.room_id, stay.reservation_id, folio.id AS folio_id,
                room.room_number, line.room_type_id, line.nightly_rate, line.adults, line.children,
                reservation.rate_plan_id, reservation.primary_guest_id
         FROM stays stay
         JOIN folios folio ON folio.stay_id = stay.id AND folio.property_id = stay.property_id
           AND folio.status = 'open'
         JOIN rooms room ON room.id = stay.room_id AND room.property_id = stay.property_id
         LEFT JOIN reservation_rooms line ON line.property_id = stay.property_id
           AND line.reservation_id = stay.reservation_id AND line.room_id = stay.room_id
         JOIN reservations reservation ON reservation.id = stay.reservation_id
           AND reservation.property_id = stay.property_id
         WHERE stay.property_id = ? AND stay.status = 'in_house'
           AND reservation.check_in_date <= ? AND reservation.check_out_date > ?
         ORDER BY stay.id FOR UPDATE`,
        [req.propertyId, businessDate, businessDate],
      );
      let total = 0n;
      for (const stay of stays) {
        if (stay.room_type_id === null || stay.rate_plan_id === null && stay.nightly_rate === null) {
          throw httpError(409, 'ROOM_RATE_MISSING', 'An in-house room assignment is missing rate information');
        }
        const ratePlanId = stay.rate_plan_id ?? await defaultRatePlan(connection, req.propertyId, Number(stay.room_type_id));
        total += await postNightlyRate(connection, req.propertyId, property, {
          ...stay,
          rate_plan_id: ratePlanId,
          business_date: businessDate,
          actor_id: req.auth.sub,
        });
      }
      await connection.execute(
        `INSERT INTO night_audit_runs (property_id, business_date, actor_id, posted_stays, total_amount)
         VALUES (?, ?, ?, ?, ?)`,
        [req.propertyId, businessDate, req.auth.sub, stays.length, money(total)],
      );
      const advancedDate = nextDate(businessDate);
      await connection.execute('UPDATE properties SET business_date = ? WHERE id = ?', [advancedDate, req.propertyId]);
      await auditable(connection, {
        organizationId: property.organization_id,
        propertyId: req.propertyId,
        actorId: req.auth.sub,
        ip: req.ip,
        action: 'night_audit.completed',
        entity: 'property',
        entityId: req.propertyId,
        before: { businessDate },
        after: { businessDate: advancedDate, postedStays: stays.length, totalAmount: money(total) },
      });
      await connection.commit();
      return res.json({ data: {
        businessDate,
        nextBusinessDate: advancedDate,
        postedStays: stays.length,
        totalAmount: money(total),
      } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.get('/documents/invoices/:id', requirePermission(db, 'folio.view'), async (req, res, next) => {
    try {
      const id = parse(positiveId, req.params.id);
      const [rows] = await db.execute(
        `SELECT invoice.id, invoice.number, invoice.issued_at, invoice.totals,
                property.name AS property_name, property.address, property.city, property.phone,
                property.email, property.currency, property.tax_settings,
                folio.id AS folio_id, folio.guest_id, guest.first_name, guest.last_name,
                reservation.confirmation_no, room.room_number
         FROM invoices invoice
         JOIN properties property ON property.id = invoice.property_id
         JOIN folios folio ON folio.id = invoice.folio_id AND folio.property_id = invoice.property_id
         LEFT JOIN stays stay ON stay.id = folio.stay_id AND stay.property_id = folio.property_id
         LEFT JOIN reservations reservation ON reservation.id = stay.reservation_id AND reservation.property_id = stay.property_id
         LEFT JOIN rooms room ON room.id = stay.room_id AND room.property_id = stay.property_id
         LEFT JOIN guests guest ON guest.id = folio.guest_id AND guest.property_id = folio.property_id
         WHERE invoice.property_id = ? AND invoice.id = ? LIMIT 1`,
        [req.propertyId, id],
      );
      if (!rows[0]) throw httpError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
      const invoice = rows[0];
      const [charges] = await db.execute(
        `SELECT charge_type, description, quantity, unit_amount, amount, business_date
         FROM folio_charges WHERE property_id = ? AND folio_id = ? ORDER BY id`,
        [req.propertyId, invoice.folio_id],
      );
      const [receipts] = await db.execute(
        `SELECT receipt.number, receipt.issued_at, payment.method, payment.amount, payment.reference
         FROM receipts receipt JOIN folio_payments payment ON payment.id = receipt.payment_id
           AND payment.property_id = receipt.property_id
         WHERE receipt.property_id = ? AND payment.folio_id = ? ORDER BY receipt.id`,
        [req.propertyId, invoice.folio_id],
      );
      return res.json({ data: {
        id: Number(invoice.id),
        number: invoice.number,
        issuedAt: invoice.issued_at,
        currency: invoice.currency,
        property: { name: invoice.property_name, address: invoice.address, city: invoice.city, phone: invoice.phone, email: invoice.email },
        guestName: `${invoice.first_name ?? ''} ${invoice.last_name ?? ''}`.trim(),
        confirmationNo: invoice.confirmation_no,
        roomNumber: invoice.room_number,
        totals: typeof invoice.totals === 'string' ? JSON.parse(invoice.totals) : invoice.totals,
        taxSettings: parseTaxSettings(invoice.tax_settings),
        charges,
        receipts,
        duplicate: req.query.reprint === '1',
        disclaimer: 'Operational invoice — not a statutory tax invoice unless stated.',
      } });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/documents/receipts/:id', requirePermission(db, 'folio.view'), async (req, res, next) => {
    try {
      const id = parse(positiveId, req.params.id);
      const [rows] = await db.execute(
        `SELECT receipt.id, receipt.number, receipt.issued_at, payment.id AS payment_id,
                payment.method, payment.amount, payment.reference, payment.is_deposit,
                folio.id AS folio_id, property.name AS property_name, property.currency,
                guest.first_name, guest.last_name
         FROM receipts receipt
         JOIN folio_payments payment ON payment.id = receipt.payment_id AND payment.property_id = receipt.property_id
         JOIN folios folio ON folio.id = payment.folio_id AND folio.property_id = payment.property_id
         JOIN properties property ON property.id = receipt.property_id
         LEFT JOIN guests guest ON guest.id = folio.guest_id AND guest.property_id = folio.property_id
         WHERE receipt.property_id = ? AND receipt.id = ? LIMIT 1`,
        [req.propertyId, id],
      );
      if (!rows[0]) throw httpError(404, 'RECEIPT_NOT_FOUND', 'Receipt not found');
      return res.json({ data: {
        id: Number(rows[0].id),
        number: rows[0].number,
        issuedAt: rows[0].issued_at,
        paymentId: Number(rows[0].payment_id),
        method: rows[0].method,
        amount: String(rows[0].amount),
        reference: rows[0].reference,
        isDeposit: Boolean(rows[0].is_deposit),
        folioId: Number(rows[0].folio_id),
        guestName: `${rows[0].first_name ?? ''} ${rows[0].last_name ?? ''}`.trim(),
        propertyName: rows[0].property_name,
        currency: rows[0].currency,
        duplicate: req.query.reprint === '1',
      } });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/documents/invoices/:id/pdf', requirePermission(db, 'folio.view'), async (req, res, next) => {
    try {
      const id = parse(positiveId, req.params.id);
      const [rows] = await db.execute(
        `SELECT invoice.id, invoice.number, invoice.issued_at, invoice.totals,
                property.name AS property_name, property.address, property.city, property.phone, property.email,
                folio.id AS folio_id, guest.first_name, guest.last_name,
                reservation.confirmation_no, room.room_number
         FROM invoices invoice
         JOIN properties property ON property.id = invoice.property_id
         JOIN folios folio ON folio.id = invoice.folio_id AND folio.property_id = invoice.property_id
         LEFT JOIN stays stay ON stay.id = folio.stay_id AND stay.property_id = folio.property_id
         LEFT JOIN reservations reservation ON reservation.id = stay.reservation_id AND reservation.property_id = folio.property_id
         LEFT JOIN rooms room ON room.id = stay.room_id AND room.property_id = folio.property_id
         LEFT JOIN guests guest ON guest.id = folio.guest_id AND guest.property_id = folio.property_id
         WHERE invoice.property_id = ? AND invoice.id = ? LIMIT 1`,
        [req.propertyId, id],
      );
      if (!rows[0]) throw httpError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
      const [charges] = await db.execute(
        `SELECT description, amount, business_date FROM folio_charges
         WHERE property_id = ? AND folio_id = ? ORDER BY id`,
        [req.propertyId, rows[0].folio_id],
      );
      const invoice = {
        ...rows[0],
        totals: typeof rows[0].totals === 'string' ? JSON.parse(rows[0].totals) : rows[0].totals,
      };
      createInvoicePdf(res, invoice, charges, req.query.reprint === '1');
    } catch (error) {
      return next(error);
    }
  });

  router.get('/documents/receipts/:id/pdf', requirePermission(db, 'folio.view'), async (req, res, next) => {
    try {
      const id = parse(positiveId, req.params.id);
      const [rows] = await db.execute(
        `SELECT receipt.id, receipt.number, receipt.issued_at, payment.method, payment.amount,
                payment.reference, payment.is_deposit, property.name AS property_name,
                guest.first_name, guest.last_name
         FROM receipts receipt
         JOIN folio_payments payment ON payment.id = receipt.payment_id AND payment.property_id = receipt.property_id
         JOIN folios folio ON folio.id = payment.folio_id AND folio.property_id = payment.property_id
         JOIN properties property ON property.id = receipt.property_id
         LEFT JOIN guests guest ON guest.id = folio.guest_id AND guest.property_id = folio.property_id
         WHERE receipt.property_id = ? AND receipt.id = ? LIMIT 1`,
        [req.propertyId, id],
      );
      if (!rows[0]) throw httpError(404, 'RECEIPT_NOT_FOUND', 'Receipt not found');
      createReceiptPdf(res, rows[0], req.query.reprint === '1');
    } catch (error) {
      return next(error);
    }
  });

  router.use((error, _req, res, next) => {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    if (status >= 500) logger.error({ err: error }, 'Finance API request failed');
    if (res.headersSent) return next(error);
    return res.status(status).json({
      error: {
        code: error?.code ?? 'INTERNAL_ERROR',
        message: status === 500 ? 'The finance request could not be completed' : error.message,
        ...(error?.details ? { details: error.details } : {}),
      },
    });
  });
  return router;
}

async function defaultRatePlan(connection, propertyId, roomTypeId) {
  const [rows] = await connection.execute(
    `SELECT plan.id FROM rate_plans plan
     JOIN rates rate ON rate.rate_plan_id = plan.id AND rate.property_id = plan.property_id
     WHERE plan.property_id = ? AND rate.room_type_id = ? AND plan.is_active = 1
     ORDER BY plan.id LIMIT 1`,
    [propertyId, roomTypeId],
  );
  if (!rows[0]) throw httpError(409, 'RATE_CONFIGURATION_MISSING', 'No active rate plan is available for a current stay');
  return Number(rows[0].id);
}
