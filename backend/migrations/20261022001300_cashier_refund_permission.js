export async function up(knex) {
  const cashierRoles = await knex('roles').where('name', 'cashier_accountant').select('id');
  if (!cashierRoles.length) return;
  await knex('role_permissions')
    .insert(cashierRoles.map((role) => ({ role_id: role.id, permission_key: 'refund.approve' })))
    .onConflict(['role_id', 'permission_key']).ignore();
}

export async function down(knex) {
  const cashierRoles = await knex('roles').where('name', 'cashier_accountant').select('id');
  if (!cashierRoles.length) return;
  await knex('role_permissions')
    .whereIn('role_id', cashierRoles.map((role) => role.id))
    .where('permission_key', 'refund.approve')
    .delete();
}
