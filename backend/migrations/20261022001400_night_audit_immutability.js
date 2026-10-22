export async function up(knex) {
  await knex.raw(`
    CREATE TRIGGER night_audit_runs_prevent_update
    BEFORE UPDATE ON night_audit_runs
    FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'night_audit_runs is append-only'
  `);
  await knex.raw(`
    CREATE TRIGGER night_audit_runs_prevent_delete
    BEFORE DELETE ON night_audit_runs
    FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'night_audit_runs is append-only'
  `);
}

export async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS night_audit_runs_prevent_delete');
  await knex.raw('DROP TRIGGER IF EXISTS night_audit_runs_prevent_update');
}
