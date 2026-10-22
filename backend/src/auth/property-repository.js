export function propertyRepository(db, table, propertyId) {
  if (!/^[a-z_]+$/i.test(table)) throw new Error('Invalid repository table');
  const scope = Number(propertyId);
  if (!Number.isInteger(scope) || scope < 1) throw new Error('A valid property scope is required');

  return {
    async list({ where = {}, orderBy = 'id', direction = 'asc', limit = 100 } = {}) {
      if (
        !/^[a-z_]+$/i.test(orderBy)
        || !['asc', 'desc'].includes(direction)
        || Object.keys(where).some((key) => !/^[a-z_]+$/i.test(key))
      ) {
        throw new Error('Invalid repository query options');
      }
      const clauses = ['property_id = ?', ...Object.keys(where).map((key) => `\`${key}\` = ?`)];
      const values = [scope, ...Object.values(where), Math.min(Math.max(Number(limit) || 100, 1), 500)];
      const [rows] = await db.execute(
        `SELECT * FROM \`${table}\` WHERE ${clauses.join(' AND ')} ORDER BY \`${orderBy}\` ${direction.toUpperCase()} LIMIT ?`,
        values,
      );
      return rows;
    },
    async get(id) {
      const [rows] = await db.execute(
        `SELECT * FROM \`${table}\` WHERE property_id = ? AND id = ? LIMIT 1`,
        [scope, id],
      );
      return rows[0] ?? null;
    },
    async insert(values) {
      const entries = Object.entries({ ...values, property_id: scope });
      if (entries.some(([key]) => !/^[a-z_]+$/i.test(key))) throw new Error('Invalid repository fields');
      const columns = entries.map(([key]) => `\`${key}\``).join(', ');
      const placeholders = entries.map(() => '?').join(', ');
      const [result] = await db.execute(
        `INSERT INTO \`${table}\` (${columns}) VALUES (${placeholders})`,
        entries.map(([, value]) => value),
      );
      return result.insertId;
    },
    async update(id, values) {
      const scopedValues = Object.fromEntries(
        Object.entries(values).filter(([key]) => key !== 'property_id'),
      );
      const entries = Object.entries(scopedValues);
      if (!entries.length || entries.some(([key]) => !/^[a-z_]+$/i.test(key))) {
        throw new Error('Invalid repository fields');
      }
      const assignments = entries.map(([key]) => `\`${key}\` = ?`).join(', ');
      const [result] = await db.execute(
        `UPDATE \`${table}\` SET ${assignments} WHERE property_id = ? AND id = ?`,
        [...entries.map(([, value]) => value), scope, id],
      );
      return result.affectedRows === 1;
    },
  };
}
