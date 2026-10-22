export async function up(knex) {
  await knex('permissions').insert({
    key: 'rates.view',
    description: 'rates view',
  }).onConflict('key').ignore();

  const roles = await knex('roles')
    .whereIn('name', ['owner_gm', 'front_desk', 'system_admin'])
    .select('id');
  for (const role of roles) {
    await knex('role_permissions')
      .insert({ role_id: role.id, permission_key: 'rates.view' })
      .onConflict(['role_id', 'permission_key'])
      .ignore();
  }
}

export async function down(knex) {
  await knex('role_permissions').where({ permission_key: 'rates.view' }).del();
  await knex('permissions').where({ key: 'rates.view' }).del();
}
