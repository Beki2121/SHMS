export async function up(knex) {
  await knex.raw(`
    CREATE TRIGGER audit_log_prevent_update
    BEFORE UPDATE ON audit_log
    FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only'
  `);
  await knex.raw(`
    CREATE TRIGGER audit_log_prevent_delete
    BEFORE DELETE ON audit_log
    FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only'
  `);
}

export async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS audit_log_prevent_delete');
  await knex.raw('DROP TRIGGER IF EXISTS audit_log_prevent_update');
}
