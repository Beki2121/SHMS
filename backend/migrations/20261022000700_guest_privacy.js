export async function up(knex) {
  await knex.schema.alterTable('guests', (table) => {
    table.string('id_number_last4', 4).nullable();
    table.index(['property_id', 'id_number_hash'], 'guests_property_id_hash_idx');
    table.index(['property_id', 'phone'], 'guests_property_phone_idx');
    table.index(['property_id', 'email'], 'guests_property_email_idx');
  });

  await knex.schema.createTable('group_guests', (table) => {
    table.increments('id').unsigned().primary();
    table.integer('property_id').unsigned().notNullable().references('id').inTable('properties').onDelete('RESTRICT');
    table.integer('group_id').unsigned().notNullable().references('id').inTable('groups').onDelete('RESTRICT');
    table.integer('guest_id').unsigned().notNullable().references('id').inTable('guests').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['group_id', 'guest_id']);
    table.index(['property_id', 'guest_id']);
  });

  await knex.schema.alterTable('guest_requests', (table) => {
    table.integer('stay_id').unsigned().nullable().alter();
    table.integer('guest_id').unsigned().nullable().references('id').inTable('guests').onDelete('RESTRICT');
    table.integer('assigned_to').unsigned().nullable().references('id').inTable('users').onDelete('RESTRICT');
    table.integer('created_by').unsigned().nullable().references('id').inTable('users').onDelete('RESTRICT');
    table.dateTime('completed_at').nullable();
    table.index(['property_id', 'status', 'created_at'], 'guest_requests_property_status_idx');
    table.index(['property_id', 'guest_id'], 'guest_requests_property_guest_idx');
  });

  await knex.schema.alterTable('groups', (table) => {
    table.dateTime('deleted_at').nullable();
  });
}

export async function down(knex) {
  await knex.schema.alterTable('groups', (table) => table.dropColumn('deleted_at'));
  await knex.schema.alterTable('guest_requests', (table) => {
    table.dropIndex(['property_id', 'guest_id'], 'guest_requests_property_guest_idx');
    table.dropIndex(['property_id', 'status', 'created_at'], 'guest_requests_property_status_idx');
    table.dropColumn('completed_at');
    table.dropForeign(['created_by']);
    table.dropForeign(['assigned_to']);
    table.dropForeign(['guest_id']);
    table.dropColumn('created_by');
    table.dropColumn('assigned_to');
    table.dropColumn('guest_id');
    table.integer('stay_id').unsigned().notNullable().alter();
  });
  await knex.schema.dropTableIfExists('group_guests');
  await knex.schema.alterTable('guests', (table) => {
    table.dropIndex(['property_id', 'email'], 'guests_property_email_idx');
    table.dropIndex(['property_id', 'phone'], 'guests_property_phone_idx');
    table.dropIndex(['property_id', 'id_number_hash'], 'guests_property_id_hash_idx');
    table.dropColumn('id_number_last4');
  });
}
