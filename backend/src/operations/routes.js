import { Router } from 'express';
import { z } from 'zod';
import { auditable } from '../auth/audit.js';
import { authenticate, propertyScope, requireAnyPermission, requirePermission } from '../auth/middleware.js';
import { logger } from '../config/logger.js';

const idSchema = z.coerce.number().int().positive();
const amountSchema = z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/);
const quantitySchema = z.string().regex(/^\d{1,9}(?:\.\d{1,3})?$/);
const signedQuantitySchema = z.string().regex(/^-?\d{1,9}(?:\.\d{1,3})?$/).refine((value) => value !== '-0' && Number(value) !== 0);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const categorySchema = z.object({ name: z.string().trim().min(2).max(120) });
const supplierSchema = z.object({
  name: z.string().trim().min(2).max(200),
  contact: z.object({
    contactName: z.string().trim().max(160).optional(),
    email: z.string().trim().email().max(190).optional(),
    phone: z.string().trim().max(40).optional(),
    address: z.string().trim().max(1000).optional(),
  }).strict().nullable().optional(),
});
const expenseSchema = z.object({
  categoryId: idSchema,
  supplierId: idSchema.nullable().optional(),
  amount: amountSchema,
  expenseDate: dateSchema,
  reference: z.string().trim().max(120).nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(),
});
const itemSchema = z.object({
  name: z.string().trim().min(2).max(160),
  categoryId: idSchema.nullable().optional(),
  unit: z.string().trim().min(1).max(40),
  reorderLevel: quantitySchema.default('0'),
});
const movementSchema = z.discriminatedUnion('movementType', [
  z.object({
    movementType: z.literal('purchase'),
    quantity: quantitySchema,
    unitCost: amountSchema,
    supplierId: idSchema.nullable().optional(),
    reference: z.string().trim().max(120).nullable().optional(),
    reason: z.string().trim().max(1000).nullable().optional(),
  }),
  z.object({
    movementType: z.literal('issue'),
    quantity: quantitySchema,
    reference: z.string().trim().max(120).nullable().optional(),
    reason: z.string().trim().min(3).max(1000),
  }),
  z.object({
    movementType: z.literal('wastage'),
    quantity: quantitySchema,
    reference: z.string().trim().max(120).nullable().optional(),
    reason: z.string().trim().min(3).max(1000),
  }),
  z.object({
    movementType: z.literal('adjustment'),
    quantity: signedQuantitySchema,
    reference: z.string().trim().max(120).nullable().optional(),
    reason: z.string().trim().min(3).max(1000),
  }),
]);
const serviceSchema = z.object({
  name: z.string().trim().min(2).max(160),
  category: z.string().trim().min(2).max(80),
  price: amountSchema,
  taxClass: z.string().trim().max(80).nullable().optional(),
});

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
  const [whole, fraction = ''] = String(value).split('.');
  return (BigInt(whole) * 100n) + BigInt((fraction + '00').slice(0, 2));
}

function decimalMoney(value) {
  const centsValue = BigInt(value);
  return `${centsValue / 100n}.${String(centsValue % 100n).padStart(2, '0')}`;
}

function milliUnits(value) {
  const normalized = String(value).replace(/^\+/, '');
  const negative = normalized.startsWith('-');
  const [whole, fraction = ''] = (negative ? normalized.slice(1) : normalized).split('.');
  const magnitude = (BigInt(whole || '0') * 1000n) + BigInt((fraction + '000').slice(0, 3));
  return negative ? -magnitude : magnitude;
}

function quantityValue(milli) {
  const value = BigInt(milli);
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const fraction = String(absolute % 1000n).padStart(3, '0');
  return `${sign}${absolute / 1000n}.${fraction}`;
}

function validDate(date) {
  if (!dateSchema.safeParse(date).success) throw httpError(400, 'INVALID_DATE', 'Dates must use YYYY-MM-DD');
  const value = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== date) {
    throw httpError(400, 'INVALID_DATE', 'Provide a valid calendar date');
  }
  return value;
}

function parseContact(value) {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw Object.assign(new Error('Stored supplier contact data is invalid JSON'), { cause: error });
  }
}

function failureResponse(error, _req, res, next) {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) {
    logger.error({ err: error }, 'Operations API request failed');
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'The operations request could not be completed' },
    });
  }
  return res.status(status).json({
    error: {
      code: error.code ?? 'OPERATIONS_ERROR',
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  });
}

async function verifyCategory(connection, table, propertyId, categoryId) {
  if (categoryId === null || categoryId === undefined) return;
  const [rows] = await connection.execute(
    `SELECT id FROM ${table} WHERE property_id = ? AND id = ? AND is_active = 1 LIMIT 1`,
    [propertyId, categoryId],
  );
  if (!rows[0]) throw httpError(400, 'INVALID_CATEGORY', 'Choose an active category from this property');
}

async function verifySupplier(connection, propertyId, supplierId) {
  if (supplierId === null || supplierId === undefined) return;
  const [rows] = await connection.execute(
    'SELECT id FROM suppliers WHERE property_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1',
    [propertyId, supplierId],
  );
  if (!rows[0]) throw httpError(400, 'INVALID_SUPPLIER', 'Choose an active supplier from this property');
}

function contactPayload(value) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export function createOperationsRouter(db) {
  const router = Router();
  router.use(authenticate(db), propertyScope(db));
  const expenses = requirePermission(db, 'expenses.manage');
  const inventory = requirePermission(db, 'inventory.manage');
  const services = requirePermission(db, 'services.manage');
  const serviceReaders = requireAnyPermission(db, ['services.manage', 'folio.post_charge']);

  router.get('/expenses/categories', expenses, async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        'SELECT id, name, is_active FROM expense_categories WHERE property_id = ? ORDER BY name',
        [req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({ id: Number(row.id), name: row.name, isActive: Boolean(row.is_active) })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/expenses/categories', expenses, async (req, res, next) => {
    let connection;
    try {
      const data = parse(categorySchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [insert] = await connection.execute(
        'INSERT INTO expense_categories (property_id, name, is_active) VALUES (?, ?, 1)',
        [req.propertyId, data.name],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'expense.category_created', entity: 'expense_category', entityId: insert.insertId, after: data,
      });
      await connection.commit();
      return res.status(201).json({ data: { id: Number(insert.insertId), ...data, isActive: true } });
    } catch (error) {
      if (connection) await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') return next(httpError(409, 'CATEGORY_EXISTS', 'This expense category already exists'));
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.get('/expenses', expenses, async (req, res, next) => {
    try {
      const from = req.query.from === undefined ? null : String(req.query.from);
      const to = req.query.to === undefined ? null : String(req.query.to);
      const categoryId = req.query.categoryId === undefined ? null : parse(idSchema, req.query.categoryId);
      if ((from && !to) || (!from && to)) throw httpError(400, 'INVALID_DATE_RANGE', 'Provide both from and to dates');
      if (from) {
        const start = validDate(from);
        const end = validDate(to);
        const days = Math.floor((end - start) / 86_400_000) + 1;
        if (days < 1 || days > 366) throw httpError(400, 'INVALID_DATE_RANGE', 'Date range must include 1 to 366 days');
      }
      const [rows] = await db.execute(
        `SELECT expense.id, expense.category_id, category.name AS category_name,
                expense.supplier_id, supplier.name AS supplier_name, expense.amount,
                expense.expense_date, expense.reference, expense.description,
                expense.logged_by, user.name AS logged_by_name, expense.created_at
         FROM expenses expense
         JOIN expense_categories category ON category.id = expense.category_id
           AND category.property_id = expense.property_id
         LEFT JOIN suppliers supplier ON supplier.id = expense.supplier_id
           AND supplier.property_id = expense.property_id
         LEFT JOIN users user ON user.id = expense.logged_by
         WHERE expense.property_id = ? AND expense.deleted_at IS NULL
           AND (? IS NULL OR expense.expense_date >= ?)
           AND (? IS NULL OR expense.expense_date <= ?)
           AND (? IS NULL OR expense.category_id = ?)
         ORDER BY expense.expense_date DESC, expense.id DESC LIMIT 1000`,
        [req.propertyId, from, from, to, to, categoryId, categoryId],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id), categoryId: Number(row.category_id), categoryName: row.category_name,
        supplierId: row.supplier_id === null ? null : Number(row.supplier_id), supplierName: row.supplier_name,
        amount: String(row.amount), expenseDate: String(row.expense_date).slice(0, 10),
        reference: row.reference, description: row.description, loggedBy: row.logged_by_name, createdAt: row.created_at,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/expenses', expenses, async (req, res, next) => {
    let connection;
    try {
      const data = parse(expenseSchema, req.body);
      validDate(data.expenseDate);
      if (cents(data.amount) <= 0n) throw httpError(400, 'INVALID_AMOUNT', 'Expense amount must be greater than zero');
      connection = await db.getConnection();
      await connection.beginTransaction();
      await verifyCategory(connection, 'expense_categories', req.propertyId, data.categoryId);
      await verifySupplier(connection, req.propertyId, data.supplierId ?? null);
      const amount = decimalMoney(cents(data.amount));
      const [insert] = await connection.execute(
        `INSERT INTO expenses
          (property_id, category_id, supplier_id, amount, expense_date, reference, description, logged_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.propertyId, data.categoryId, data.supplierId ?? null, amount,
          data.expenseDate, data.reference ?? null, data.description ?? null, req.auth.sub,
        ],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'expense.created', entity: 'expense', entityId: insert.insertId, after: { ...data, amount },
      });
      await connection.commit();
      return res.status(201).json({ data: { id: Number(insert.insertId), ...data, amount } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.delete('/expenses/:id', expenses, async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT id, category_id, supplier_id, amount, expense_date, reference, description
         FROM expenses WHERE property_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE`,
        [req.propertyId, id],
      );
      if (!rows[0]) throw httpError(404, 'EXPENSE_NOT_FOUND', 'Expense not found');
      await connection.execute(
        'UPDATE expenses SET deleted_at = UTC_TIMESTAMP() WHERE property_id = ? AND id = ?',
        [req.propertyId, id],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'expense.archived', entity: 'expense', entityId: id, before: rows[0], after: { archived: true },
      });
      await connection.commit();
      return res.status(204).end();
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.get('/suppliers', expenses, async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT id, name, contact, created_at FROM suppliers
         WHERE property_id = ? AND deleted_at IS NULL ORDER BY name LIMIT 500`,
        [req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id), name: row.name, contact: parseContact(row.contact), createdAt: row.created_at,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/suppliers', expenses, async (req, res, next) => {
    let connection;
    try {
      const data = parse(supplierSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [insert] = await connection.execute(
        'INSERT INTO suppliers (property_id, name, contact) VALUES (?, ?, ?)',
        [req.propertyId, data.name, contactPayload(data.contact)],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'supplier.created', entity: 'supplier', entityId: insert.insertId, after: data,
      });
      await connection.commit();
      return res.status(201).json({ data: { id: Number(insert.insertId), ...data } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.put('/suppliers/:id', expenses, async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      const data = parse(supplierSchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT id, name, contact FROM suppliers WHERE property_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE',
        [req.propertyId, id],
      );
      if (!rows[0]) throw httpError(404, 'SUPPLIER_NOT_FOUND', 'Supplier not found');
      await connection.execute(
        'UPDATE suppliers SET name = ?, contact = ? WHERE property_id = ? AND id = ?',
        [data.name, contactPayload(data.contact), req.propertyId, id],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'supplier.updated', entity: 'supplier', entityId: id,
        before: { ...rows[0], contact: parseContact(rows[0].contact) }, after: data,
      });
      await connection.commit();
      return res.json({ data: { id, ...data } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.delete('/suppliers/:id', expenses, async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT id, name, contact FROM suppliers WHERE property_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE',
        [req.propertyId, id],
      );
      if (!rows[0]) throw httpError(404, 'SUPPLIER_NOT_FOUND', 'Supplier not found');
      await connection.execute(
        'UPDATE suppliers SET deleted_at = UTC_TIMESTAMP() WHERE property_id = ? AND id = ?',
        [req.propertyId, id],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'supplier.archived', entity: 'supplier', entityId: id,
        before: { id, name: rows[0].name }, after: { archived: true },
      });
      await connection.commit();
      return res.status(204).end();
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.get('/inventory/categories', inventory, async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        'SELECT id, name, is_active FROM inventory_categories WHERE property_id = ? ORDER BY name',
        [req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({ id: Number(row.id), name: row.name, isActive: Boolean(row.is_active) })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/inventory/categories', inventory, async (req, res, next) => {
    let connection;
    try {
      const data = parse(categorySchema, req.body);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [insert] = await connection.execute(
        'INSERT INTO inventory_categories (property_id, name, is_active) VALUES (?, ?, 1)',
        [req.propertyId, data.name],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'inventory.category_created', entity: 'inventory_category', entityId: insert.insertId, after: data,
      });
      await connection.commit();
      return res.status(201).json({ data: { id: Number(insert.insertId), ...data, isActive: true } });
    } catch (error) {
      if (connection) await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') return next(httpError(409, 'CATEGORY_EXISTS', 'This inventory category already exists'));
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.get('/inventory/items', inventory, async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT item.id, item.name, item.category_id, category.name AS category_name,
                item.unit, item.quantity, item.reorder_level, item.created_at
         FROM inventory_items item
         LEFT JOIN inventory_categories category ON category.id = item.category_id
           AND category.property_id = item.property_id
         WHERE item.property_id = ? AND item.deleted_at IS NULL
         ORDER BY item.name LIMIT 1000`,
        [req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id), name: row.name,
        categoryId: row.category_id === null ? null : Number(row.category_id),
        categoryName: row.category_name, unit: row.unit,
        quantity: String(row.quantity), reorderLevel: String(row.reorder_level),
        lowStock: Number(row.quantity) <= Number(row.reorder_level),
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/inventory/items', inventory, async (req, res, next) => {
    let connection;
    try {
      const data = parse(itemSchema, req.body);
      if (milliUnits(data.reorderLevel) < 0n) throw httpError(400, 'INVALID_REORDER_LEVEL', 'Reorder level cannot be negative');
      connection = await db.getConnection();
      await connection.beginTransaction();
      await verifyCategory(connection, 'inventory_categories', req.propertyId, data.categoryId ?? null);
      const [insert] = await connection.execute(
        `INSERT INTO inventory_items (property_id, category_id, name, unit, quantity, reorder_level)
         VALUES (?, ?, ?, ?, 0, ?)`,
        [req.propertyId, data.categoryId ?? null, data.name, data.unit, quantityValue(milliUnits(data.reorderLevel))],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'inventory.item_created', entity: 'inventory_item', entityId: insert.insertId,
        after: { ...data, quantity: '0.000' },
      });
      await connection.commit();
      return res.status(201).json({ data: {
        id: Number(insert.insertId), ...data, quantity: '0.000', lowStock: milliUnits(data.reorderLevel) === 0n,
      } });
    } catch (error) {
      if (connection) await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') return next(httpError(409, 'ITEM_EXISTS', 'An inventory item with this name already exists'));
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.put('/inventory/items/:id', inventory, async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      const data = parse(itemSchema, req.body);
      if (milliUnits(data.reorderLevel) < 0n) throw httpError(400, 'INVALID_REORDER_LEVEL', 'Reorder level cannot be negative');
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [items] = await connection.execute(
        `SELECT id, name, category_id, unit, quantity, reorder_level FROM inventory_items
         WHERE property_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE`,
        [req.propertyId, id],
      );
      if (!items[0]) throw httpError(404, 'ITEM_NOT_FOUND', 'Inventory item not found');
      await verifyCategory(connection, 'inventory_categories', req.propertyId, data.categoryId ?? null);
      await connection.execute(
        `UPDATE inventory_items SET name = ?, category_id = ?, unit = ?, reorder_level = ?
         WHERE property_id = ? AND id = ?`,
        [
          data.name, data.categoryId ?? null, data.unit, quantityValue(milliUnits(data.reorderLevel)),
          req.propertyId, id,
        ],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'inventory.item_updated', entity: 'inventory_item', entityId: id, before: items[0], after: data,
      });
      await connection.commit();
      return res.json({ data: { id, ...data, quantity: String(items[0].quantity) } });
    } catch (error) {
      if (connection) await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') return next(httpError(409, 'ITEM_EXISTS', 'An inventory item with this name already exists'));
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/inventory/items/:id/archive', inventory, async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT id, name, quantity FROM inventory_items WHERE property_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE',
        [req.propertyId, id],
      );
      if (!rows[0]) throw httpError(404, 'ITEM_NOT_FOUND', 'Inventory item not found');
      if (milliUnits(rows[0].quantity) !== 0n) {
        throw httpError(409, 'ITEM_HAS_STOCK', 'Record a movement that clears the stock before archiving the item');
      }
      await connection.execute(
        'UPDATE inventory_items SET deleted_at = UTC_TIMESTAMP() WHERE property_id = ? AND id = ?',
        [req.propertyId, id],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'inventory.item_archived', entity: 'inventory_item', entityId: id,
        before: { id, name: rows[0].name }, after: { archived: true },
      });
      await connection.commit();
      return res.status(204).end();
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.get('/inventory/movements', inventory, async (req, res, next) => {
    try {
      const itemId = req.query.itemId === undefined ? null : parse(idSchema, req.query.itemId);
      const [rows] = await db.execute(
        `SELECT movement.id, movement.item_id, item.name AS item_name, item.unit,
                movement.movement_type, movement.quantity, movement.unit_cost,
                movement.supplier_id, supplier.name AS supplier_name, movement.reference,
                movement.reason, movement.moved_by, user.name AS moved_by_name, movement.created_at
         FROM inventory_movements movement
         JOIN inventory_items item ON item.id = movement.item_id AND item.property_id = movement.property_id
         LEFT JOIN suppliers supplier ON supplier.id = movement.supplier_id
           AND supplier.property_id = movement.property_id
         LEFT JOIN users user ON user.id = movement.moved_by
         WHERE movement.property_id = ? AND (? IS NULL OR movement.item_id = ?)
         ORDER BY movement.created_at DESC, movement.id DESC LIMIT 1000`,
        [req.propertyId, itemId, itemId],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id), itemId: Number(row.item_id), itemName: row.item_name, unit: row.unit,
        movementType: row.movement_type, quantity: String(row.quantity), unitCost: row.unit_cost,
        supplierId: row.supplier_id === null ? null : Number(row.supplier_id), supplierName: row.supplier_name,
        reference: row.reference, reason: row.reason, movedBy: row.moved_by_name, createdAt: row.created_at,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/inventory/items/:id/movements', inventory, async (req, res, next) => {
    let connection;
    try {
      const itemId = parse(idSchema, req.params.id);
      const data = parse(movementSchema, req.body);
      const requested = milliUnits(data.quantity);
      if ((data.movementType !== 'adjustment' && requested <= 0n) || requested === 0n) {
        throw httpError(400, 'INVALID_QUANTITY', 'Movement quantity must be greater than zero');
      }
      if (data.movementType === 'purchase' && cents(data.unitCost) < 0n) {
        throw httpError(400, 'INVALID_UNIT_COST', 'Unit cost cannot be negative');
      }
      const delta = data.movementType === 'issue' || data.movementType === 'wastage'
        ? -requested
        : requested;
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [items] = await connection.execute(
        `SELECT id, name, quantity, unit FROM inventory_items
         WHERE property_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE`,
        [req.propertyId, itemId],
      );
      if (!items[0]) throw httpError(404, 'ITEM_NOT_FOUND', 'Inventory item not found');
      await verifySupplier(connection, req.propertyId, data.supplierId ?? null);
      const newQuantity = milliUnits(items[0].quantity) + delta;
      if (newQuantity < 0n) throw httpError(409, 'INSUFFICIENT_STOCK', 'The movement would take stock below zero');
      const [movement] = await connection.execute(
        `INSERT INTO inventory_movements
          (property_id, item_id, movement_type, quantity, unit_cost, supplier_id, reference, reason, moved_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.propertyId, itemId, data.movementType, quantityValue(delta),
          data.movementType === 'purchase' ? decimalMoney(cents(data.unitCost)) : null,
          data.supplierId ?? null, data.reference ?? null, data.reason ?? null, req.auth.sub,
        ],
      );
      await connection.execute(
        'UPDATE inventory_items SET quantity = ? WHERE property_id = ? AND id = ?',
        [quantityValue(newQuantity), req.propertyId, itemId],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: `inventory.${data.movementType}`, entity: 'inventory_item', entityId: itemId,
        before: { quantity: String(items[0].quantity) },
        after: {
          movementId: Number(movement.insertId), movementType: data.movementType,
          quantity: quantityValue(delta), balance: quantityValue(newQuantity), reason: data.reason ?? null,
        },
      });
      await connection.commit();
      return res.status(201).json({ data: {
        id: Number(movement.insertId), itemId, movementType: data.movementType,
        quantity: quantityValue(delta), balance: quantityValue(newQuantity),
      } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.get('/services/catalog', serviceReaders, async (req, res, next) => {
    try {
      const activeOnly = req.query.includeInactive !== 'true'
        || !(await (async () => {
          const [rows] = await db.execute(
            `SELECT permission_key FROM role_permissions
             WHERE role_id = ? AND permission_key = 'services.manage' LIMIT 1`,
            [req.auth.roleId],
          );
          return rows.length > 0;
        })());
      const [rows] = await db.execute(
        `SELECT id, name, category, price, tax_class, is_active
         FROM service_catalog WHERE property_id = ? AND deleted_at IS NULL
           AND (? = 0 OR is_active = 1)
         ORDER BY category, name`,
        [req.propertyId, activeOnly ? 1 : 0],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id), name: row.name, category: row.category,
        price: String(row.price), taxClass: row.tax_class, isActive: Boolean(row.is_active),
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/services/catalog', services, async (req, res, next) => {
    let connection;
    try {
      const data = parse(serviceSchema, req.body);
      if (cents(data.price) <= 0n) throw httpError(400, 'INVALID_SERVICE_PRICE', 'Service price must be greater than zero');
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [insert] = await connection.execute(
        `INSERT INTO service_catalog (property_id, name, category, price, tax_class, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [req.propertyId, data.name, data.category, decimalMoney(cents(data.price)), data.taxClass ?? null],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'service.created', entity: 'service_catalog', entityId: insert.insertId,
        after: { ...data, price: decimalMoney(cents(data.price)) },
      });
      await connection.commit();
      return res.status(201).json({ data: { id: Number(insert.insertId), ...data, isActive: true } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.put('/services/catalog/:id', services, async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      const data = parse(serviceSchema, req.body);
      if (cents(data.price) <= 0n) throw httpError(400, 'INVALID_SERVICE_PRICE', 'Service price must be greater than zero');
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT id, name, category, price, tax_class FROM service_catalog WHERE property_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE',
        [req.propertyId, id],
      );
      if (!rows[0]) throw httpError(404, 'SERVICE_NOT_FOUND', 'Service not found');
      await connection.execute(
        `UPDATE service_catalog SET name = ?, category = ?, price = ?, tax_class = ?
         WHERE property_id = ? AND id = ?`,
        [data.name, data.category, decimalMoney(cents(data.price)), data.taxClass ?? null, req.propertyId, id],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'service.updated', entity: 'service_catalog', entityId: id,
        before: rows[0], after: { ...data, price: decimalMoney(cents(data.price)) },
      });
      await connection.commit();
      return res.json({ data: { id, ...data, isActive: true } });
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.delete('/services/catalog/:id', services, async (req, res, next) => {
    let connection;
    try {
      const id = parse(idSchema, req.params.id);
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT id, name, category, price, tax_class FROM service_catalog WHERE property_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE',
        [req.propertyId, id],
      );
      if (!rows[0]) throw httpError(404, 'SERVICE_NOT_FOUND', 'Service not found');
      await connection.execute(
        'UPDATE service_catalog SET is_active = 0, deleted_at = UTC_TIMESTAMP() WHERE property_id = ? AND id = ?',
        [req.propertyId, id],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'service.archived', entity: 'service_catalog', entityId: id,
        before: rows[0], after: { archived: true },
      });
      await connection.commit();
      return res.status(204).end();
    } catch (error) {
      if (connection) await connection.rollback();
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.use((req, res, next) => {
    if (req.path.startsWith('/expenses') || req.path.startsWith('/suppliers')
      || req.path.startsWith('/inventory') || req.path.startsWith('/services')) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Operations route not found' } });
    }
    return next();
  });
  router.use(failureResponse);
  return router;
}
