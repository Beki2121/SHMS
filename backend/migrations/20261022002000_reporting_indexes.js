export async function up(knex) {
  await knex.schema.alterTable('folio_charges', (table) => {
    table.index(['property_id', 'business_date', 'charge_type'], 'folio_charges_report_date_type_idx');
  });
  await knex.schema.alterTable('folio_payments', (table) => {
    table.index(['property_id', 'created_at'], 'folio_payments_report_created_idx');
  });
  await knex.schema.alterTable('reservations', (table) => {
    table.index(['property_id', 'created_at', 'status'], 'reservations_report_created_status_idx');
    table.index(['property_id', 'check_in_date', 'status'], 'reservations_report_arrival_idx');
    table.index(['property_id', 'check_out_date', 'status'], 'reservations_report_departure_idx');
  });
  await knex.schema.alterTable('stays', (table) => {
    table.index(['property_id', 'checked_in_at', 'checked_out_at'], 'stays_report_checkin_checkout_idx');
  });
  await knex.schema.alterTable('cashier_shifts', (table) => {
    table.index(['property_id', 'closed_at', 'cashier_id'], 'cashier_shifts_report_closed_idx');
  });
  await knex.schema.alterTable('housekeeping_tasks', (table) => {
    table.index(['property_id', 'completed_at', 'status'], 'housekeeping_report_completed_idx');
    table.index(['property_id', 'created_at', 'completed_at'], 'housekeeping_report_created_idx');
  });
  await knex.schema.alterTable('maintenance_tickets', (table) => {
    table.index(['property_id', 'status', 'opened_at'], 'maintenance_report_status_opened_idx');
  });
  await knex.schema.alterTable('shift_assignments', (table) => {
    table.index(['property_id', 'date', 'employee_id'], 'shift_assignments_report_date_idx');
  });
  await knex.schema.alterTable('attendance', (table) => {
    table.index(['property_id', 'date', 'employee_id'], 'attendance_report_date_idx');
  });
  await knex.schema.alterTable('inventory_movements', (table) => {
    table.index(['property_id', 'created_at', 'movement_type'], 'inventory_movement_report_created_idx');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('inventory_movements', (table) => {
    table.dropIndex(['property_id', 'created_at', 'movement_type'], 'inventory_movement_report_created_idx');
  });
  await knex.schema.alterTable('attendance', (table) => {
    table.dropIndex(['property_id', 'date', 'employee_id'], 'attendance_report_date_idx');
  });
  await knex.schema.alterTable('shift_assignments', (table) => {
    table.dropIndex(['property_id', 'date', 'employee_id'], 'shift_assignments_report_date_idx');
  });
  await knex.schema.alterTable('maintenance_tickets', (table) => {
    table.dropIndex(['property_id', 'status', 'opened_at'], 'maintenance_report_status_opened_idx');
  });
  await knex.schema.alterTable('housekeeping_tasks', (table) => {
    table.dropIndex(['property_id', 'created_at', 'completed_at'], 'housekeeping_report_created_idx');
    table.dropIndex(['property_id', 'completed_at', 'status'], 'housekeeping_report_completed_idx');
  });
  await knex.schema.alterTable('cashier_shifts', (table) => {
    table.dropIndex(['property_id', 'closed_at', 'cashier_id'], 'cashier_shifts_report_closed_idx');
  });
  await knex.schema.alterTable('stays', (table) => {
    table.dropIndex(['property_id', 'checked_in_at', 'checked_out_at'], 'stays_report_checkin_checkout_idx');
  });
  await knex.schema.alterTable('reservations', (table) => {
    table.dropIndex(['property_id', 'check_out_date', 'status'], 'reservations_report_departure_idx');
    table.dropIndex(['property_id', 'check_in_date', 'status'], 'reservations_report_arrival_idx');
    table.dropIndex(['property_id', 'created_at', 'status'], 'reservations_report_created_status_idx');
  });
  await knex.schema.alterTable('folio_payments', (table) => {
    table.dropIndex(['property_id', 'created_at'], 'folio_payments_report_created_idx');
  });
  await knex.schema.alterTable('folio_charges', (table) => {
    table.dropIndex(['property_id', 'business_date', 'charge_type'], 'folio_charges_report_date_type_idx');
  });
}
