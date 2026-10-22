export async function up(knex) {
  await knex.schema.alterTable('packages', (table) => {
    table.unique(['name'], 'packages_name_unique');
  });
  await knex.schema.alterTable('organizations', (table) => {
    table.enu('subscription_status', ['trial', 'active', 'past_due', 'cancelled'])
      .notNullable().defaultTo('active');
    table.unique(['name'], 'organizations_name_unique');
    table.string('installation_id', 120).nullable().unique('organizations_installation_id_uq');
  });

  await knex.schema.createTable('billing_notes', (table) => {
    table.increments('id').unsigned().primary();
    table.integer('organization_id').unsigned().notNullable().index();
    table.integer('created_by').unsigned().nullable();
    table.text('note').notNullable();
    table.decimal('amount', 12, 2).nullable();
    table.string('currency', 3).notNullable().defaultTo('ETB');
    table.date('period_from').nullable();
    table.date('period_to').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('support_access_requests', (table) => {
    table.increments('id').unsigned().primary();
    table.integer('organization_id').unsigned().notNullable();
    table.integer('property_id').unsigned().notNullable();
    table.integer('requested_by').unsigned().notNullable();
    table.integer('reviewed_by').unsigned().nullable();
    table.string('reason', 1000).notNullable();
    table.integer('duration_minutes').unsigned().notNullable().defaultTo(30);
    table.enu('status', ['pending', 'approved', 'started', 'denied', 'revoked']).notNullable().defaultTo('pending');
    table.timestamp('requested_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('reviewed_at').nullable();
    table.timestamp('expires_at').nullable();
    table.index(['organization_id', 'status', 'requested_at'], 'support_request_org_status_idx');
  });

  await knex.schema.createTable('support_access_sessions', (table) => {
    table.increments('id').unsigned().primary();
    table.integer('request_id').unsigned().notNullable().unique();
    table.integer('organization_id').unsigned().notNullable();
    table.integer('property_id').unsigned().notNullable();
    table.integer('actor_id').unsigned().notNullable();
    table.integer('approved_by').unsigned().notNullable();
    table.timestamp('started_at').notNullable().defaultTo(knex.fn.now());
    table.dateTime('expires_at').notNullable();
    table.timestamp('ended_at').nullable();
    table.index(['actor_id', 'expires_at', 'ended_at'], 'support_session_actor_expiry_idx');
    table.index(['organization_id', 'property_id', 'expires_at'], 'support_session_scope_idx');
  });

  await knex.schema.createTable('support_access_events', (table) => {
    table.increments('id').unsigned().primary();
    table.integer('session_id').unsigned().notNullable();
    table.integer('organization_id').unsigned().notNullable();
    table.integer('property_id').unsigned().notNullable();
    table.integer('actor_id').unsigned().notNullable();
    table.string('method', 10).notNullable();
    table.string('path', 500).notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['session_id', 'created_at'], 'support_event_session_created_idx');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('support_access_events');
  await knex.schema.dropTableIfExists('support_access_sessions');
  await knex.schema.dropTableIfExists('support_access_requests');
  await knex.schema.dropTableIfExists('billing_notes');
  await knex.schema.alterTable('organizations', (table) => {
    table.dropUnique(['installation_id'], 'organizations_installation_id_uq');
    table.dropUnique(['name'], 'organizations_name_unique');
    table.dropColumn('installation_id');
    table.dropColumn('subscription_status');
  });
  await knex.schema.alterTable('packages', (table) => {
    table.dropUnique(['name'], 'packages_name_unique');
  });
}
