export async function up(knex) {
  await knex.schema.alterTable('housekeeping_tasks', (table) => {
    table.integer('assigned_department_id').unsigned().nullable()
      .references('id').inTable('departments').onDelete('RESTRICT');
    table.string('priority_reason', 255).nullable();
    table.boolean('is_readiness_task').notNullable().defaultTo(true);
    table.index(['property_id', 'assigned_to', 'status'], 'housekeeping_tasks_assignee_status_idx');
  });
  await knex.schema.alterTable('properties', (table) => {
    table.boolean('housekeeping_skip_inspection').notNullable().defaultTo(false);
    table.boolean('housekeeping_same_day_priority').notNullable().defaultTo(true);
  });
  await knex.schema.alterTable('task_checklist_items', (table) => {
    table.boolean('is_required').notNullable().defaultTo(true);
  });

  await knex('permissions').insert([
    { key: 'housekeeping.work', description: 'Start and complete assigned housekeeping tasks' },
    { key: 'housekeeping.checklist.manage', description: 'Create and update housekeeping checklist templates' },
    { key: 'housekeeping.skip_inspection', description: 'Configure housekeeping inspection bypass' },
  ]).onConflict('key').ignore();

  const roles = await knex('roles').select('id', 'name');
  const permissions = await knex('permissions')
    .whereIn('key', ['housekeeping.view', 'housekeeping.assign', 'housekeeping.inspect', 'housekeeping.work', 'housekeeping.checklist.manage', 'housekeeping.skip_inspection'])
    .select('key');
  const grants = roles.flatMap((role) => permissions
    .filter(({ key }) => {
      if (['owner_gm', 'system_admin', 'super_admin'].includes(role.name)) return true;
      if (role.name === 'front_desk') return key === 'housekeeping.view';
      if (role.name === 'housekeeping_supervisor') return key !== 'housekeeping.skip_inspection';
      return role.name === 'housekeeping_staff' && ['housekeeping.view', 'housekeeping.work'].includes(key);
    })
    .map(({ key }) => ({ role_id: role.id, permission_key: key })));
  if (grants.length) await knex('role_permissions').insert(grants).onConflict(['role_id', 'permission_key']).ignore();

  await knex.raw(`
    CREATE TRIGGER rooms_housekeeping_state_guard
    BEFORE UPDATE ON rooms
    FOR EACH ROW
    BEGIN
      IF OLD.status IN ('AWAITING_CLEANING', 'BEING_CLEANED', 'AWAITING_INSPECTION')
         AND NEW.status <> OLD.status
         AND COALESCE(@shms_housekeeping_transition, 0) <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Room readiness transitions require the housekeeping workflow';
      END IF;
    END
  `);
  await knex.transaction(async (connection) => {
    try {
      await connection.raw('SET @shms_housekeeping_transition = 1');
      await connection.raw(`
        INSERT INTO room_status_history
          (property_id, room_id, from_status, to_status, reason, changed_by, changed_at)
        SELECT property_id, id, 'AVAILABLE_CLEAN', 'CLEAN',
               'Phase 9 canonical housekeeping readiness status', NULL, UTC_TIMESTAMP()
        FROM rooms WHERE status = 'AVAILABLE_CLEAN'
      `);
      await connection('rooms').where({ status: 'AVAILABLE_CLEAN' }).update({ status: 'CLEAN' });
    } finally {
      await connection.raw('SET @shms_housekeeping_transition = 0');
    }
  });
}

export async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS rooms_housekeeping_state_guard');
  await knex('role_permissions')
    .whereIn('permission_key', ['housekeeping.work', 'housekeeping.checklist.manage', 'housekeeping.skip_inspection'])
    .delete();
  await knex('permissions')
    .whereIn('key', ['housekeeping.work', 'housekeeping.checklist.manage', 'housekeeping.skip_inspection'])
    .delete();
  await knex.schema.alterTable('task_checklist_items', (table) => {
    table.dropColumn('is_required');
  });
  await knex.schema.alterTable('properties', (table) => {
    table.dropColumn('housekeeping_same_day_priority');
    table.dropColumn('housekeeping_skip_inspection');
  });
  await knex.schema.alterTable('housekeeping_tasks', (table) => {
    table.dropIndex(['property_id', 'assigned_to', 'status'], 'housekeeping_tasks_assignee_status_idx');
    table.dropColumn('is_readiness_task');
    table.dropColumn('priority_reason');
    table.dropForeign(['assigned_department_id']);
    table.dropColumn('assigned_department_id');
  });
}
