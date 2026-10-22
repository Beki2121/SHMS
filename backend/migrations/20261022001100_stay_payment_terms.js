export async function up(knex) {
  await knex.schema.alterTable('folios', (table) => {
    table.decimal('deposit_required', 12, 2).notNullable().defaultTo(0);
    table.text('payment_terms').nullable();
  });
}

export async function down(knex) {
  await knex.schema.alterTable('folios', (table) => {
    table.dropColumn('payment_terms');
    table.dropColumn('deposit_required');
  });
}
