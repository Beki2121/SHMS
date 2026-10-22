export async function up(knex) {
  await knex.schema.alterTable('automation_rules', (table) => {
    table.unique(['property_id', 'key'], 'automation_rule_property_key_uq');
  });
  await knex.schema.alterTable('automation_log', (table) => {
    table.string('dedupe_key', 190).notNullable();
    table.unique(['property_id', 'dedupe_key'], 'automation_log_property_dedupe_uq');
    table.index(['property_id', 'rule_key', 'created_at'], 'automation_log_rule_created_idx');
  });
  await knex.schema.alterTable('notifications', (table) => {
    table.string('dedupe_key', 190).nullable();
    table.unique(['property_id', 'dedupe_key'], 'notification_property_dedupe_uq');
    table.index(['property_id', 'user_id', 'read_at', 'created_at'], 'notification_user_read_idx');
    table.index(['property_id', 'role', 'read_at', 'created_at'], 'notification_role_read_idx');
  });

  for (const tableName of ['automation_log']) {
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
}

export async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS automation_log_prevent_delete');
  await knex.raw('DROP TRIGGER IF EXISTS automation_log_prevent_update');
  await knex.schema.alterTable('notifications', (table) => {
    table.dropIndex(['property_id', 'role', 'read_at', 'created_at'], 'notification_role_read_idx');
    table.dropIndex(['property_id', 'user_id', 'read_at', 'created_at'], 'notification_user_read_idx');
    table.dropUnique(['property_id', 'dedupe_key'], 'notification_property_dedupe_uq');
    table.dropColumn('dedupe_key');
  });
  await knex.schema.alterTable('automation_log', (table) => {
    table.dropIndex(['property_id', 'rule_key', 'created_at'], 'automation_log_rule_created_idx');
    table.dropUnique(['property_id', 'dedupe_key'], 'automation_log_property_dedupe_uq');
    table.dropColumn('dedupe_key');
  });
  await knex.schema.alterTable('automation_rules', (table) => {
    table.dropUnique(['property_id', 'key'], 'automation_rule_property_key_uq');
  });
}
