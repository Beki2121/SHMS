export async function up(knex) {
  await knex.schema.alterTable('assets', (table) => {
    table.unique(['property_id', 'asset_tag'], 'assets_property_tag_unique');
    table.index(['property_id', 'room_id', 'deleted_at'], 'assets_property_room_deleted_idx');
  });
  await knex.schema.alterTable('maintenance_tickets', (table) => {
    table.text('clearance_notes').nullable();
    table.index(['property_id', 'room_id', 'status', 'blocks_room'], 'maintenance_room_status_block_idx');
    table.index(['property_id', 'asset_id', 'status'], 'maintenance_asset_status_idx');
  });
  await knex.raw(`
    CREATE TRIGGER rooms_maintenance_state_guard
    BEFORE UPDATE ON rooms
    FOR EACH ROW
    BEGIN
      IF OLD.status = 'BLOCKED_MAINTENANCE'
         AND NEW.status <> OLD.status
         AND COALESCE(@shms_maintenance_transition, 0) <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Maintenance-blocked rooms require an audited clearance';
      END IF;
    END
  `);
}

export async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS rooms_maintenance_state_guard');
  await knex.schema.alterTable('maintenance_tickets', (table) => {
    table.dropIndex(['property_id', 'asset_id', 'status'], 'maintenance_asset_status_idx');
    table.dropIndex(['property_id', 'room_id', 'status', 'blocks_room'], 'maintenance_room_status_block_idx');
    table.dropColumn('clearance_notes');
  });
  await knex.schema.alterTable('assets', (table) => {
    table.dropIndex(['property_id', 'room_id', 'deleted_at'], 'assets_property_room_deleted_idx');
    table.dropUnique(['property_id', 'asset_tag'], 'assets_property_tag_unique');
  });
}
