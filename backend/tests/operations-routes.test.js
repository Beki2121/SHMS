import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';
import { clearPermissionCache } from '../src/auth/permissions.js';

describe('Phase 12 expenses, inventory and guest services', () => {
  const app = createApp();
  let propertyId;
  let organizationId;
  let ownerToken;
  let frontDeskToken;
  let cashierToken;
  let categoryId;
  let inventoryCategoryId;
  let supplierId;
  let itemId;
  let expenseId;
  let serviceId;
  let folioId;

  function tokenFor(userId, role, orgId = organizationId, property = propertyId) {
    return jwt.sign({
      orgId,
      role,
      propertyIds: property ? [property] : [],
      activePropertyId: property ?? null,
    }, env.JWT_ACCESS_SECRET, { subject: String(userId), expiresIn: '10m' });
  }

  function authorized(token, method, path) {
    return request(app)[method](path).set('Authorization', `Bearer ${token}`);
  }

  beforeAll(async () => {
    clearPermissionCache();
    const [owners] = await pool.execute(
      `SELECT user.id, user.organization_id, membership.property_id
       FROM users user
       JOIN roles role ON role.id = user.role_id AND role.name = 'owner_gm'
       JOIN user_properties membership ON membership.user_id = user.id
       WHERE user.email = 'owner@smarthotel.local' LIMIT 1`,
    );
    if (!owners.length) throw new Error('Operations tests require the seeded owner');
    organizationId = Number(owners[0].organization_id);
    propertyId = Number(owners[0].property_id);
    ownerToken = tokenFor(Number(owners[0].id), 'owner_gm');

    const [staff] = await pool.execute(
      `SELECT user.id, role.name
       FROM users user
       JOIN roles role ON role.id = user.role_id
       JOIN user_properties membership ON membership.user_id = user.id
       WHERE membership.property_id = ? AND role.name IN ('front_desk', 'cashier_accountant')
       ORDER BY role.name`,
      [propertyId],
    );
    const frontDesk = staff.find((row) => row.name === 'front_desk');
    const cashier = staff.find((row) => row.name === 'cashier_accountant');
    if (!frontDesk || !cashier) throw new Error('Operations tests require seeded front-desk and cashier users');
    frontDeskToken = tokenFor(Number(frontDesk.id), 'front_desk');
    cashierToken = tokenFor(Number(cashier.id), 'cashier_accountant');
  });

  afterAll(async () => {
    if (!propertyId) return;
    if (expenseId) {
      await pool.execute(
        'UPDATE expenses SET deleted_at = COALESCE(deleted_at, UTC_TIMESTAMP()) WHERE property_id = ? AND id = ?',
        [propertyId, expenseId],
      );
    }
    if (supplierId) {
      await pool.execute(
        'UPDATE suppliers SET deleted_at = COALESCE(deleted_at, UTC_TIMESTAMP()) WHERE property_id = ? AND id = ?',
        [propertyId, supplierId],
      );
    }
    if (itemId) {
      await pool.execute(
        'UPDATE inventory_items SET deleted_at = COALESCE(deleted_at, UTC_TIMESTAMP()) WHERE property_id = ? AND id = ?',
        [propertyId, itemId],
      );
    }
    if (serviceId) {
      await pool.execute(
        'UPDATE service_catalog SET deleted_at = COALESCE(deleted_at, UTC_TIMESTAMP()), is_active = 0 WHERE property_id = ? AND id = ?',
        [propertyId, serviceId],
      );
    }
    void categoryId;
    void inventoryCategoryId;
    void folioId;
  });

  it('records scoped expenses and suppliers, appends stock movements, and bills catalog services', async () => {
    const forbidden = await authorized(frontDeskToken, 'get', '/api/expenses/categories');
    expect(forbidden.status).toBe(403);
    const cashierInventory = await authorized(cashierToken, 'get', '/api/inventory/items');
    expect(cashierInventory.status).toBe(200);
    const staffServices = await authorized(cashierToken, 'get', '/api/services/catalog');
    expect(staffServices.status).toBe(200);

    const category = await authorized(ownerToken, 'post', '/api/expenses/categories')
      .send({ name: `Ops expense ${Date.now()}` });
    expect(category.status).toBe(201);
    categoryId = category.body.data.id;

    const inventoryCategory = await authorized(ownerToken, 'post', '/api/inventory/categories')
      .send({ name: `Ops inventory ${Date.now()}` });
    expect(inventoryCategory.status).toBe(201);
    inventoryCategoryId = inventoryCategory.body.data.id;

    const supplier = await authorized(ownerToken, 'post', '/api/suppliers')
      .send({
        name: `Ops supplier ${Date.now()}`,
        contact: { contactName: 'Test buyer', email: 'ops@example.test', phone: '+251900000000' },
      });
    expect(supplier.status).toBe(201);
    supplierId = supplier.body.data.id;

    const expense = await authorized(ownerToken, 'post', '/api/expenses')
      .send({
        categoryId,
        supplierId,
        amount: '325.50',
        expenseDate: '2026-10-22',
        reference: 'OPS-TEST',
        description: 'Operations integration fixture',
      });
    expect(expense.status).toBe(201);
    expenseId = expense.body.data.id;
    const expenses = await authorized(ownerToken, 'get', '/api/expenses?from=2026-10-22&to=2026-10-22');
    expect(expenses.status).toBe(200);
    expect(expenses.body.data.some((row) => row.id === expenseId && row.amount === '325.50')).toBe(true);

    const item = await authorized(ownerToken, 'post', '/api/inventory/items')
      .send({ name: `Ops item ${Date.now()}`, categoryId: inventoryCategoryId, unit: 'piece', reorderLevel: '2' });
    expect(item.status).toBe(201);
    itemId = item.body.data.id;
    const purchase = await authorized(ownerToken, 'post', `/api/inventory/items/${itemId}/movements`)
      .send({
        movementType: 'purchase',
        quantity: '12.500',
        unitCost: '25.00',
        supplierId,
        reference: 'PO-OPS-TEST',
      });
    expect(purchase.status).toBe(201);
    expect(purchase.body.data.balance).toBe('12.500');

    const issue = await authorized(ownerToken, 'post', `/api/inventory/items/${itemId}/movements`)
      .send({ movementType: 'issue', quantity: '3', reason: 'Issued for operations test' });
    expect(issue.status).toBe(201);
    expect(issue.body.data.balance).toBe('9.500');
    const adjustment = await authorized(ownerToken, 'post', `/api/inventory/items/${itemId}/movements`)
      .send({ movementType: 'adjustment', quantity: '-1.250', reason: 'Counted stock correction' });
    expect(adjustment.status).toBe(201);
    expect(adjustment.body.data.balance).toBe('8.250');
    const overspend = await authorized(ownerToken, 'post', `/api/inventory/items/${itemId}/movements`)
      .send({ movementType: 'wastage', quantity: '9', reason: 'Must not overspend stock' });
    expect(overspend.status).toBe(409);
    expect(overspend.body.error.code).toBe('INSUFFICIENT_STOCK');
    const currentItems = await authorized(ownerToken, 'get', '/api/inventory/items?propertyId=2147483647');
    expect(currentItems.status).toBe(200);
    expect(currentItems.body.data.find((row) => row.id === itemId).quantity).toBe('8.250');

    const service = await authorized(ownerToken, 'post', '/api/services/catalog')
      .send({ name: `Ops service ${Date.now()}`, category: 'laundry', price: '123.45', taxClass: 'standard' });
    expect(service.status).toBe(201);
    serviceId = service.body.data.id;
    const [folios] = await pool.execute(
      `SELECT id FROM folios WHERE property_id = ? AND status = 'open' ORDER BY id LIMIT 1`,
      [propertyId],
    );
    if (!folios.length) throw new Error('Operations tests require an open guest folio');
    folioId = Number(folios[0].id);
    const postService = await authorized(cashierToken, 'post', `/api/folios/${folioId}/services`)
      .send({ serviceId, quantity: 2 });
    expect(postService.status).toBe(201);
    expect(postService.body.data.unitAmount).toBe('123.45');
    expect(postService.body.data.amount).toBe('246.90');
    const [charges] = await pool.execute(
      `SELECT service_catalog_id, quantity, unit_amount, amount FROM folio_charges
       WHERE property_id = ? AND folio_id = ? AND service_catalog_id = ?
       ORDER BY id DESC LIMIT 1`,
      [propertyId, folioId, serviceId],
    );
    expect(Number(charges[0].quantity)).toBe(2);
    expect(String(charges[0].amount)).toBe('246.90');

    const archiveExpense = await authorized(ownerToken, 'delete', `/api/expenses/${expenseId}`);
    expect(archiveExpense.status).toBe(204);
    const archivedRows = await authorized(ownerToken, 'get', '/api/expenses?from=2026-10-22&to=2026-10-22');
    expect(archivedRows.body.data.some((row) => row.id === expenseId)).toBe(false);
    const archiveWithStock = await authorized(ownerToken, 'post', `/api/inventory/items/${itemId}/archive`).send({});
    expect(archiveWithStock.status).toBe(409);
    expect(archiveWithStock.body.error.code).toBe('ITEM_HAS_STOCK');
    const drain = await authorized(ownerToken, 'post', `/api/inventory/items/${itemId}/movements`)
      .send({ movementType: 'issue', quantity: '8.250', reason: 'Clear stock for test cleanup' });
    expect(drain.status).toBe(201);
    const archiveItem = await authorized(ownerToken, 'post', `/api/inventory/items/${itemId}/archive`).send({});
    expect(archiveItem.status).toBe(204);
  });

  it('keeps stock movement entries immutable and rejects invalid date and tenant references', async () => {
    const invalidDate = await authorized(ownerToken, 'post', '/api/expenses')
      .send({ categoryId: 1, amount: '5.00', expenseDate: '2026-02-30' });
    expect(invalidDate.status).toBe(400);

    const foreignSupplier = await authorized(ownerToken, 'post', '/api/inventory/items/2147483647/movements')
      .send({ movementType: 'purchase', quantity: '1', unitCost: '1.00', supplierId: 2147483647 });
    expect(foreignSupplier.status).toBe(404);

    if (itemId) {
      await expect(pool.execute(
        'UPDATE inventory_movements SET reason = ? WHERE property_id = ? AND item_id = ?',
        ['must fail', propertyId, itemId],
      )).rejects.toThrow();
      await expect(pool.execute(
        'DELETE FROM inventory_movements WHERE property_id = ? AND item_id = ?',
        [propertyId, itemId],
      )).rejects.toThrow();
    }
  });
});
