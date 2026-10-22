export async function up(knex) {
  await knex.schema.alterTable('expense_categories', (table) => {
    table.unique(['property_id', 'name'], 'expense_category_property_name_uq');
    table.index(['property_id', 'is_active'], 'expense_category_property_active_idx');
  });
  await knex.schema.alterTable('suppliers', (table) => {
    table.index(['property_id', 'deleted_at', 'name'], 'supplier_property_deleted_name_idx');
  });
  await knex.schema.alterTable('expenses', (table) => {
    table.index(['property_id', 'expense_date', 'deleted_at'], 'expenses_property_date_deleted_idx');
    table.index(['property_id', 'category_id', 'expense_date'], 'expenses_property_category_date_idx');
  });
  await knex.schema.alterTable('inventory_categories', (table) => {
    table.unique(['property_id', 'name'], 'inventory_category_property_name_uq');
    table.index(['property_id', 'is_active'], 'inventory_category_property_active_idx');
  });
  await knex.schema.alterTable('inventory_items', (table) => {
    table.unique(['property_id', 'name'], 'inventory_item_property_name_uq');
    table.index(['property_id', 'category_id', 'deleted_at'], 'inventory_item_property_category_idx');
  });
  await knex.schema.alterTable('inventory_movements', (table) => {
    table.index(['property_id', 'item_id', 'created_at'], 'inventory_movement_item_created_idx');
    table.index(['property_id', 'movement_type', 'created_at'], 'inventory_movement_type_created_idx');
  });
  await knex.schema.alterTable('service_catalog', (table) => {
    table.index(['property_id', 'is_active', 'category'], 'service_catalog_property_active_idx');
    table.index(['property_id', 'deleted_at', 'name'], 'service_catalog_property_deleted_name_idx');
  });
  await knex.schema.alterTable('folio_charges', (table) => {
    table.integer('service_catalog_id').unsigned().nullable()
      .references('id').inTable('service_catalog').onDelete('RESTRICT');
    table.index(['property_id', 'service_catalog_id'], 'folio_charge_service_catalog_idx');
  });

  for (const tableName of ['inventory_movements']) {
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

  const roles = await knex('roles').whereIn('name', ['owner_gm', 'cashier_accountant', 'system_admin', 'super_admin'])
    .select('id', 'name');
  const grants = roles.flatMap((role) => {
    const keys = ['inventory.manage'];
    if (['owner_gm', 'system_admin', 'super_admin'].includes(role.name)) keys.push('services.manage');
    return keys.map((permission_key) => ({ role_id: role.id, permission_key }));
  });
  if (grants.length) {
    await knex('role_permissions').insert(grants).onConflict(['role_id', 'permission_key']).ignore();
  }
}

export async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS inventory_movements_prevent_delete');
  await knex.raw('DROP TRIGGER IF EXISTS inventory_movements_prevent_update');
  await knex('role_permissions').whereIn('permission_key', ['inventory.manage', 'services.manage'])
    .whereIn('role_id', knex('roles').whereIn('name', ['owner_gm', 'cashier_accountant', 'system_admin', 'super_admin']).select('id'))
    .delete();
  await knex.schema.alterTable('folio_charges', (table) => {
    table.dropIndex(['property_id', 'service_catalog_id'], 'folio_charge_service_catalog_idx');
    table.dropForeign(['service_catalog_id']);
    table.dropColumn('service_catalog_id');
  });
  await knex.schema.alterTable('service_catalog', (table) => {
    table.dropIndex(['property_id', 'is_active', 'category'], 'service_catalog_property_active_idx');
    table.dropIndex(['property_id', 'deleted_at', 'name'], 'service_catalog_property_deleted_name_idx');
  });
  await knex.schema.alterTable('inventory_movements', (table) => {
    table.dropIndex(['property_id', 'item_id', 'created_at'], 'inventory_movement_item_created_idx');
    table.dropIndex(['property_id', 'movement_type', 'created_at'], 'inventory_movement_type_created_idx');
  });
  await knex.schema.alterTable('inventory_items', (table) => {
    table.dropIndex(['property_id', 'category_id', 'deleted_at'], 'inventory_item_property_category_idx');
    table.dropUnique(['property_id', 'name'], 'inventory_item_property_name_uq');
  });
  await knex.schema.alterTable('inventory_categories', (table) => {
    table.dropIndex(['property_id', 'is_active'], 'inventory_category_property_active_idx');
    table.dropUnique(['property_id', 'name'], 'inventory_category_property_name_uq');
  });
  await knex.schema.alterTable('expenses', (table) => {
    table.dropIndex(['property_id', 'expense_date', 'deleted_at'], 'expenses_property_date_deleted_idx');
    table.dropIndex(['property_id', 'category_id', 'expense_date'], 'expenses_property_category_date_idx');
  });
  await knex.schema.alterTable('suppliers', (table) => {
    table.dropIndex(['property_id', 'deleted_at', 'name'], 'supplier_property_deleted_name_idx');
  });
  await knex.schema.alterTable('expense_categories', (table) => {
    table.dropIndex(['property_id', 'is_active'], 'expense_category_property_active_idx');
    table.dropUnique(['property_id', 'name'], 'expense_category_property_name_uq');
  });
}
