export async function up(knex) {
  await knex.schema.alterTable('users', (table) => {
    table.integer('failed_login_attempts').unsigned().notNullable().defaultTo(0);
    table.timestamp('locked_until').nullable();
  });

  await knex.schema.alterTable('refresh_tokens', (table) => {
    table.string('family_id', 36).nullable();
    table.unique(['token_hash']);
    table.index(['family_id']);
  });

}

export async function down(knex) {
  await knex.schema.alterTable('refresh_tokens', (table) => {
    table.dropIndex(['family_id']);
    table.dropUnique(['token_hash']);
    table.dropColumn('family_id');
  });

  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('locked_until');
    table.dropColumn('failed_login_attempts');
  });
}
