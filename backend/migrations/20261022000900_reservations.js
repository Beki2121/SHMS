export async function up(knex) {
  await knex.schema.createTable('reservation_history', (table) => {
    table.increments('id').unsigned().primary();
    table.integer('property_id').unsigned().notNullable().references('id').inTable('properties').onDelete('RESTRICT');
    table.integer('reservation_id').unsigned().notNullable().references('id').inTable('reservations').onDelete('RESTRICT');
    table.integer('actor_id').unsigned().nullable().references('id').inTable('users').onDelete('RESTRICT');
    table.string('action', 80).notNullable();
    table.string('from_status', 40).nullable();
    table.string('to_status', 40).nullable();
    table.json('before_state').nullable();
    table.json('after_state').nullable();
    table.string('reason', 500).nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['property_id', 'reservation_id', 'created_at'], 'reservation_history_property_idx');
  });

  await knex.schema.alterTable('reservation_rooms', (table) => {
    table.index(['property_id', 'reservation_id'], 'reservation_rooms_property_reservation_idx');
    table.index(['property_id', 'room_id'], 'reservation_rooms_property_room_idx');
  });

  await knex.schema.alterTable('reservation_guests', (table) => {
    table.unique(['reservation_id', 'guest_id'], 'reservation_guests_res_guest_unique');
  });

  await knex.schema.alterTable('reservations', (table) => {
    table.index(['property_id', 'status', 'check_in_date', 'check_out_date'], 'reservations_property_status_dates_idx');
    table.index(['property_id', 'primary_guest_id', 'check_in_date'], 'reservations_property_guest_date_idx');
  });

  await knex.raw(`
    CREATE TRIGGER reservation_history_prevent_update
    BEFORE UPDATE ON reservation_history
    FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'reservation_history is append-only'
  `);
  await knex.raw(`
    CREATE TRIGGER reservation_history_prevent_delete
    BEFORE DELETE ON reservation_history
    FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'reservation_history is append-only'
  `);
}

export async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS reservation_history_prevent_delete');
  await knex.raw('DROP TRIGGER IF EXISTS reservation_history_prevent_update');
  await knex.schema.alterTable('reservations', (table) => {
    table.dropIndex(['property_id', 'primary_guest_id', 'check_in_date'], 'reservations_property_guest_date_idx');
    table.dropIndex(['property_id', 'status', 'check_in_date', 'check_out_date'], 'reservations_property_status_dates_idx');
  });
  const [indexes] = await knex.raw(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reservation_guests'
       AND INDEX_NAME = 'reservation_guests_reservation_id_idx' LIMIT 1`,
  );
  if (!indexes.length) {
    await knex.schema.alterTable('reservation_guests', (table) => {
      table.index(['reservation_id'], 'reservation_guests_reservation_id_idx');
    });
  }
  await knex.schema.alterTable('reservation_guests', (table) => {
    table.dropUnique(['reservation_id', 'guest_id'], 'reservation_guests_res_guest_unique');
  });
  await knex.schema.alterTable('reservation_rooms', (table) => {
    table.dropIndex(['property_id', 'room_id'], 'reservation_rooms_property_room_idx');
    table.dropIndex(['property_id', 'reservation_id'], 'reservation_rooms_property_reservation_idx');
  });
  await knex.schema.dropTableIfExists('reservation_history');
}
