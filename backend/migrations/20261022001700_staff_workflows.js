export async function up(knex) {
  await knex.schema.alterTable('shift_assignments', (table) => {
    table.unique(['property_id', 'employee_id', 'date'], 'shift_assignment_employee_date_unique');
    table.index(['property_id', 'date'], 'shift_assignment_property_date_idx');
  });
  await knex.schema.alterTable('attendance', (table) => {
    table.integer('shift_assignment_id').unsigned().nullable()
      .references('id').inTable('shift_assignments').onDelete('SET NULL');
    table.unique(['property_id', 'employee_id', 'date'], 'attendance_employee_date_unique');
    table.index(['property_id', 'date'], 'attendance_property_date_idx');
  });
  await knex.schema.alterTable('leave_requests', (table) => {
    table.text('reason').nullable();
    table.timestamp('reviewed_at').nullable();
    table.index(['property_id', 'employee_id', 'status', 'date_from', 'date_to'], 'leave_employee_status_dates_idx');
  });
  await knex.schema.alterTable('handover_notes', (table) => {
    table.string('title', 160).nullable();
    table.index(['property_id', 'department_id', 'created_at'], 'handover_department_created_idx');
  });
  await knex('permissions').insert({
    key: 'staff.self_service',
    description: 'View own staff schedule and manage own attendance and leave requests',
  }).onConflict('key').ignore();

  const roles = await knex('roles').select('id', 'name');
  const grants = roles
    .filter(({ name }) => !['auditor', 'super_admin'].includes(name))
    .map(({ id }) => ({ role_id: id, permission_key: 'staff.self_service' }));
  if (grants.length) await knex('role_permissions').insert(grants)
    .onConflict(['role_id', 'permission_key']).ignore();
}

export async function down(knex) {
  await knex('role_permissions').where({ permission_key: 'staff.self_service' }).delete();
  await knex('permissions').where({ key: 'staff.self_service' }).delete();
  await knex.schema.alterTable('handover_notes', (table) => {
    table.dropIndex(['property_id', 'department_id', 'created_at'], 'handover_department_created_idx');
    table.dropColumn('title');
  });
  await knex.schema.alterTable('leave_requests', (table) => {
    table.dropIndex(['property_id', 'employee_id', 'status', 'date_from', 'date_to'], 'leave_employee_status_dates_idx');
    table.dropColumn('reviewed_at');
    table.dropColumn('reason');
  });
  await knex.schema.alterTable('attendance', (table) => {
    table.dropIndex(['property_id', 'date'], 'attendance_property_date_idx');
    table.dropUnique(['property_id', 'employee_id', 'date'], 'attendance_employee_date_unique');
    table.dropForeign(['shift_assignment_id']);
    table.dropColumn('shift_assignment_id');
  });
  await knex.schema.alterTable('shift_assignments', (table) => {
    table.dropIndex(['property_id', 'date'], 'shift_assignment_property_date_idx');
    table.dropUnique(['property_id', 'employee_id', 'date'], 'shift_assignment_employee_date_unique');
  });
}
