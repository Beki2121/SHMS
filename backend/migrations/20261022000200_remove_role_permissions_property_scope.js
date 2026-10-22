export async function up(knex) {
  if (!(await knex.schema.hasColumn('role_permissions', 'property_id'))) return;

  await knex.schema.alterTable('role_permissions', (table) => {
    table.dropForeign(['property_id']);
    table.dropColumn('property_id');
  });
}

export async function down(knex) {
  if (await knex.schema.hasColumn('role_permissions', 'property_id')) return;

  await knex.schema.alterTable('role_permissions', (table) => {
    table.integer('property_id').unsigned().nullable();
    table.foreign('property_id').references('id').inTable('properties').onDelete('RESTRICT');
  });
}
