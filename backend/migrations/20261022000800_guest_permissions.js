export async function up(knex) {
  const permissions = [
    ['guest.view_id', 'reveal encrypted guest identity numbers'],
    ['guest_requests.manage', 'manage guest service requests'],
  ];
  for (const [key, description] of permissions) {
    await knex('permissions').insert({ key, description }).onConflict('key').ignore();
  }

  const roles = await knex('roles')
    .whereIn('name', ['owner_gm', 'front_desk', 'cashier_accountant', 'system_admin', 'super_admin'])
    .select('id', 'name');
  for (const role of roles) {
    const keys = role.name === 'front_desk' || role.name === 'cashier_accountant'
      ? ['guest_requests.manage']
      : permissions.map(([key]) => key);
    for (const permission_key of keys) {
      await knex('role_permissions')
        .insert({ role_id: role.id, permission_key })
        .onConflict(['role_id', 'permission_key'])
        .ignore();
    }
  }
}

export async function down(knex) {
  await knex('role_permissions')
    .whereIn('permission_key', ['guest.view_id', 'guest_requests.manage'])
    .del();
  await knex('permissions')
    .whereIn('key', ['guest.view_id', 'guest_requests.manage'])
    .del();
}
