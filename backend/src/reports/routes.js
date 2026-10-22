import { Router } from 'express';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { authenticate, propertyScope, requirePermission } from '../auth/middleware.js';
import { getRolePermissions } from '../auth/permissions.js';
import { logger } from '../config/logger.js';
import { buildReportSections, loadPropertyReport } from './metrics.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Use a valid calendar date');
const reportQuerySchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  propertyId: z.coerce.number().int().positive().optional(),
}).strict();
const exportQuerySchema = reportQuerySchema.extend({
  format: z.enum(['csv', 'pdf']),
}).strict();

function httpError(status, code, message, details) {
  return Object.assign(new Error(message), { status, code, details });
}

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw httpError(400, 'VALIDATION_ERROR', 'Request validation failed', result.error.issues);
  }
  return result.data;
}

function escapeCsv(value) {
  let text = String(value ?? '');
  const isNegativeNumber = /^-\d+(?:\.\d+)?$/.test(text);
  if (!isNegativeNumber && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csvForReport(report) {
  const rows = [
    ['Section', 'Metric', 'Value'],
    ['Report', 'Property', report.property.name],
    ['Report', 'Date range', `${report.range.from} to ${report.range.to}`],
    ['Report', 'Currency', report.property.currency],
    ['Report', 'Dashboard role', report.dashboardRole],
  ];
  for (const [section, metrics] of buildReportSections(report)) {
    for (const [metric, value] of metrics) rows.push([section, metric, value]);
  }
  return `\uFEFF${rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n')}\r\n`;
}

function ascii(value) {
  return String(value ?? '').replace(/[^\x20-\x7E]/g, ' ');
}

function pdfForReport(res, report) {
  const fileName = `report-property-${report.property.id}-${report.range.from}-${report.range.to}.pdf`;
  const document = new PDFDocument({ size: 'A4', margin: 42 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  document.on('error', (error) => {
    logger.error({ err: error }, 'Could not render report PDF');
    if (!res.headersSent) res.status(500).end();
    else res.destroy(error);
  });
  document.pipe(res);
  document.fontSize(18).fillColor('#146b56').text(ascii(report.property.name), { align: 'center' });
  document.moveDown(0.3).fontSize(14).fillColor('#26332d').text('Management report', { align: 'center' });
  document.moveDown(0.3).fontSize(9).text(
    `${report.range.from} to ${report.range.to} | ${report.property.currency}`,
    { align: 'center' },
  );
  document.moveDown();
  for (const [section, metrics] of buildReportSections(report)) {
    document.fontSize(12).fillColor('#146b56').text(ascii(section));
    document.moveDown(0.3).fontSize(9).fillColor('#26332d');
    for (const [label, value] of metrics) {
      document.text(`${ascii(label)}: ${ascii(value)}`, { lineGap: 2 });
    }
    document.moveDown(0.7);
  }
  document.end();
}

function dateDays(from, to) {
  return Math.round((new Date(`${to}T00:00:00.000Z`) - new Date(`${from}T00:00:00.000Z`)) / 86400000) + 1;
}

function dashboardRole(role) {
  const normalized = String(role ?? '').toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (normalized === 'front_desk') return 'front_desk';
  if (normalized === 'cashier_accountant') return 'cashier';
  if (normalized === 'housekeeping_supervisor') return 'housekeeping';
  return 'management';
}

export function createReportsRouter(db) {
  const router = Router();
  router.use(authenticate(db), propertyScope(db));
  const viewReports = requirePermission(db, 'reports.view');

  async function loadRequestReport(req, schema) {
    const query = parse(schema, req.query);
    const propertyId = query.propertyId ?? req.propertyId;
    if (propertyId !== req.propertyId) {
      const [memberships] = await db.execute(
        `SELECT p.id FROM user_properties up
         JOIN properties p ON p.id = up.property_id
         WHERE up.user_id = ? AND up.property_id = ?
           AND p.organization_id = ? AND p.is_active = 1 LIMIT 1`,
        [req.auth.sub, propertyId, req.auth.orgId],
      );
      if (!memberships[0]) throw httpError(403, 'FORBIDDEN', 'The selected property is not assigned to your account');
    }
    const [properties] = await db.execute(
      'SELECT business_date FROM properties WHERE id = ? AND is_active = 1 LIMIT 1',
      [propertyId],
    );
    if (!properties[0]) throw httpError(404, 'PROPERTY_NOT_FOUND', 'Property not found');
    const businessDate = String(properties[0].business_date).slice(0, 10);
    const from = query.from ?? query.to ?? businessDate;
    const to = query.to ?? query.from ?? businessDate;
    if (from > to) throw httpError(400, 'INVALID_DATE_RANGE', 'The start date must not be after the end date');
    if (dateDays(from, to) > 366) throw httpError(400, 'DATE_RANGE_TOO_LARGE', 'Report date ranges cannot exceed 366 days');
    const permissions = await getRolePermissions(db, req.auth.roleId);
    const report = await loadPropertyReport(db, propertyId, from, to, permissions.includes('reports.view_financial'));
    report.dashboardRole = dashboardRole(req.auth.role);
    return report;
  }

  router.get('/reports', viewReports, async (req, res, next) => {
    try {
      return res.json({ data: await loadRequestReport(req, reportQuerySchema) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/reports/dashboard', viewReports, async (req, res, next) => {
    try {
      const report = await loadRequestReport(req, reportQuerySchema);
      return res.json({ data: report });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/reports/export', viewReports, async (req, res, next) => {
    try {
      const query = parse(exportQuerySchema, req.query);
      const report = await loadRequestReport(req, exportQuerySchema);
      if (query.format === 'csv') {
        const fileName = `report-property-${report.property.id}-${report.range.from}-${report.range.to}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        return res.send(csvForReport(report));
      }
      return pdfForReport(res, report);
    } catch (error) {
      return next(error);
    }
  });

  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number.isInteger(error?.status) ? error.status : 500;
    if (status >= 500) {
      logger.error({ err: error }, 'Reports API request failed');
      return res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'The report could not be generated' },
      });
    }
    return res.status(status).json({
      error: {
        code: error.code ?? 'REPORT_ERROR',
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
  });
  return router;
}
