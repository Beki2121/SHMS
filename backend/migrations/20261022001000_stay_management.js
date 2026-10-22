export async function up(knex) {
  await knex.schema.alterTable('properties', (table) => {
    table.boolean('require_id_at_checkin').notNullable().defaultTo(false);
    table.decimal('early_checkin_fee', 12, 2).notNullable().defaultTo(0);
    table.decimal('late_checkout_fee', 12, 2).notNullable().defaultTo(0);
  });

  await knex.schema.alterTable('stays', (table) => {
    table.index(['property_id', 'status', 'checked_in_at'], 'stays_property_status_checkedin_idx');
  });

  await knex('permissions').insert([
    { key: 'stays.shorten', description: 'Authorize shortening an in-house stay' },
    { key: 'stays.rate_change_approve', description: 'Approve rate changes during a room move' },
    { key: 'folio.approve_credit', description: 'Approve checkout with an unsettled balance' },
  ]).onConflict('key').ignore();

  const roles = await knex('roles').whereIn('name', ['owner_gm', 'system_admin', 'super_admin']).select('id');
  const permissions = await knex('permissions')
    .whereIn('key', ['stays.shorten', 'stays.rate_change_approve', 'folio.approve_credit'])
    .select('key');
  const grants = roles.flatMap((role) => permissions.map((permission) => ({
    role_id: role.id,
    permission_key: permission.key,
  })));
  if (grants.length) await knex('role_permissions').insert(grants).onConflict(['role_id', 'permission_key']).ignore();
}

export async function down(knex) {
  await knex('role_permissions')
    .whereIn('permission_key', ['stays.shorten', 'stays.rate_change_approve', 'folio.approve_credit'])
    .delete();
  await knex('permissions')
    .whereIn('key', ['stays.shorten', 'stays.rate_change_approve', 'folio.approve_credit'])
    .delete();
  await knex.schema.alterTable('stays', (table) => {
    table.dropIndex(['property_id', 'status', 'checked_in_at'], 'stays_property_status_checkedin_idx');
  });
  await knex.schema.alterTable('properties', (table) => {
    table.dropColumn('late_checkout_fee');
    table.dropColumn('early_checkin_fee');
    table.dropColumn('require_id_at_checkin');
  });
}
