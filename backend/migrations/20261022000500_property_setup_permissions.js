export async function up(knex) {
  await knex('permissions').insert({
    key: 'rates.view',
    description: 'rates view',
  }).onConflict('key').ignore();
  await knex('permissions').insert({
    key: 'rates.override_past',
    description: 'rates override past',
  }).onConflict('key').ignore();

  const rateViewRoles = await knex('roles')
    .whereIn('name', ['owner_gm', 'front_desk', 'system_admin'])
    .select('id');
  for (const role of rateViewRoles) {
    await knex('role_permissions')
      .insert({ role_id: role.id, permission_key: 'rates.view' })
      .onConflict(['role_id', 'permission_key'])
      .ignore();
  }
  const overrideRoles = await knex('roles')
    .whereIn('name', ['owner_gm', 'system_admin'])
    .select('id');
  for (const role of overrideRoles) {
    await knex('role_permissions')
      .insert({ role_id: role.id, permission_key: 'rates.override_past' })
      .onConflict(['role_id', 'permission_key'])
      .ignore();
  }

  await knex.schema.createTable('room_type_amenities', (table) => {
    table.increments('id').unsigned().primary();
    table.integer('property_id').unsigned().notNullable()
      .references('id').inTable('properties').onDelete('RESTRICT');
    table.integer('room_type_id').unsigned().notNullable()
      .references('id').inTable('room_types').onDelete('RESTRICT');
    table.integer('amenity_id').unsigned().notNullable()
      .references('id').inTable('amenities').onDelete('RESTRICT');
    table.unique(['room_type_id', 'amenity_id']);
    table.index(['property_id', 'room_type_id']);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.alterTable('floors', (table) => {
    table.index(['property_id', 'building_id', 'floor_number'], 'floors_property_building_number_idx');
  });
  await knex.schema.alterTable('rooms', (table) => {
    table.index(['property_id', 'floor_id', 'is_active'], 'rooms_property_floor_active_idx');
    table.index(['property_id', 'room_type_id', 'is_active'], 'rooms_property_type_active_idx');
  });
  await knex.schema.alterTable('room_types', (table) => {
    table.index(['property_id', 'is_active'], 'room_types_property_active_idx');
  });
  await knex.schema.alterTable('rate_plans', (table) => {
    table.index(['property_id', 'is_active'], 'rate_plans_property_active_idx');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('rate_plans', (table) => {
    table.dropIndex(['property_id', 'is_active'], 'rate_plans_property_active_idx');
  });
  await knex.schema.alterTable('room_types', (table) => {
    table.dropIndex(['property_id', 'is_active'], 'room_types_property_active_idx');
  });
  await knex.schema.alterTable('rooms', (table) => {
    table.dropIndex(['property_id', 'room_type_id', 'is_active'], 'rooms_property_type_active_idx');
    table.dropIndex(['property_id', 'floor_id', 'is_active'], 'rooms_property_floor_active_idx');
  });
  await knex.schema.alterTable('floors', (table) => {
    table.dropIndex(['property_id', 'building_id', 'floor_number'], 'floors_property_building_number_idx');
  });

  await knex.schema.dropTableIfExists('room_type_amenities');
  await knex('role_permissions').where({ permission_key: 'rates.override_past' }).del();
  await knex('role_permissions').where({ permission_key: 'rates.view' }).del();
  await knex('permissions').where({ key: 'rates.override_past' }).del();
  await knex('permissions').where({ key: 'rates.view' }).del();
}
