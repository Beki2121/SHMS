export async function up(knex) {
  await knex.schema.alterTable('properties', (table) => {
    table.decimal('adjustment_approval_threshold', 12, 2).notNullable().defaultTo(1000);
  });

  await knex.schema.alterTable('folio_payments', (table) => {
    table.string('idempotency_key', 80).nullable();
    table.unique(['property_id', 'idempotency_key'], 'folio_payments_property_idempotency_uq');
  });

  await knex.schema.alterTable('adjustments', (table) => {
    table.integer('reverses_payment_id').unsigned().nullable()
      .references('id').inTable('folio_payments').onDelete('RESTRICT');
    table.index(['property_id', 'folio_id', 'created_at'], 'adjustments_folio_created_idx');
  });

  await knex.schema.createTable('adjustment_requests', (table) => {
    table.increments('id').unsigned().primary();
    table.integer('property_id').unsigned().notNullable().references('id').inTable('properties').onDelete('RESTRICT');
    table.integer('folio_id').unsigned().notNullable().references('id').inTable('folios').onDelete('RESTRICT');
    table.enu('type', ['discount', 'correction', 'refund', 'write_off'], { useNative: true }).notNullable();
    table.decimal('amount', 12, 2).notNullable();
    table.text('reason').notNullable();
    table.integer('requested_by').unsigned().notNullable().references('id').inTable('users').onDelete('RESTRICT');
    table.integer('reverses_payment_id').unsigned().nullable()
      .references('id').inTable('folio_payments').onDelete('RESTRICT');
    table.enu('status', ['pending', 'approved', 'rejected'], { useNative: true }).notNullable().defaultTo('pending');
    table.integer('decided_by').unsigned().nullable().references('id').inTable('users').onDelete('RESTRICT');
    table.dateTime('decided_at').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['property_id', 'status', 'created_at'], 'adjustment_requests_property_status_idx');
  });

  await knex.schema.createTable('night_audit_runs', (table) => {
    table.increments('id').unsigned().primary();
    table.integer('property_id').unsigned().notNullable().references('id').inTable('properties').onDelete('RESTRICT');
    table.date('business_date').notNullable();
    table.integer('actor_id').unsigned().notNullable().references('id').inTable('users').onDelete('RESTRICT');
    table.integer('posted_stays').unsigned().notNullable().defaultTo(0);
    table.decimal('total_amount', 12, 2).notNullable().defaultTo(0);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['property_id', 'business_date'], 'night_audit_property_date_uq');
  });

  await knex('permissions').insert([
    { key: 'cashier.shift.manage', description: 'Open, reconcile, and close cashier shifts' },
    { key: 'night_audit.run', description: 'Run the property night audit' },
  ]).onConflict('key').ignore();

  const roleNames = ['owner_gm', 'front_desk', 'cashier_accountant', 'system_admin', 'super_admin'];
  const roles = await knex('roles').whereIn('name', roleNames).select('id', 'name');
  const permissions = await knex('permissions')
    .whereIn('key', ['cashier.shift.manage', 'night_audit.run'])
    .select('key');
  const grants = roles.flatMap((role) => permissions
    .filter((permission) => permission.key !== 'night_audit.run'
      || ['owner_gm', 'cashier_accountant', 'system_admin', 'super_admin'].includes(role.name))
    .map((permission) => ({
      role_id: role.id,
      permission_key: permission.key,
    })));
  if (grants.length) await knex('role_permissions').insert(grants).onConflict(['role_id', 'permission_key']).ignore();

  for (const tableName of ['folio_charges', 'folio_payments', 'adjustments', 'invoices', 'receipts']) {
    await knex.raw(`
      CREATE TRIGGER ${tableName}_prevent_update
      BEFORE UPDATE ON ${tableName}
      FOR EACH ROW
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${tableName} is append-only'
    `);
    await knex.raw(`
      CREATE TRIGGER ${tableName}_prevent_delete
      BEFORE DELETE ON ${tableName}
      FOR EACH ROW
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${tableName} is append-only'
    `);
  }

  await knex.raw(`
    CREATE TRIGGER cashier_shifts_closed_prevent_update
    BEFORE UPDATE ON cashier_shifts
    FOR EACH ROW
    BEGIN
      IF OLD.status = 'closed' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Closed cashier shifts are immutable';
      END IF;
    END
  `);
}

export async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS cashier_shifts_closed_prevent_update');
  for (const tableName of ['receipts', 'invoices', 'adjustments', 'folio_payments', 'folio_charges']) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${tableName}_prevent_delete`);
    await knex.raw(`DROP TRIGGER IF EXISTS ${tableName}_prevent_update`);
  }
  await knex('role_permissions')
    .whereIn('permission_key', ['cashier.shift.manage', 'night_audit.run'])
    .delete();
  await knex('permissions')
    .whereIn('key', ['cashier.shift.manage', 'night_audit.run'])
    .delete();
  await knex.schema.dropTableIfExists('night_audit_runs');
  await knex.schema.dropTableIfExists('adjustment_requests');
  await knex.schema.alterTable('adjustments', (table) => {
    table.dropIndex(['property_id', 'folio_id', 'created_at'], 'adjustments_folio_created_idx');
    table.dropForeign(['reverses_payment_id']);
    table.dropColumn('reverses_payment_id');
  });
  await knex.schema.alterTable('folio_payments', (table) => {
    table.dropUnique(['property_id', 'idempotency_key'], 'folio_payments_property_idempotency_uq');
    table.dropColumn('idempotency_key');
  });
  await knex.schema.alterTable('properties', (table) => {
    table.dropColumn('adjustment_approval_threshold');
  });
}
