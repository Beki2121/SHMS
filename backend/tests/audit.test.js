import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { auditable } from '../src/auth/audit.js';

describe('append-only audit log', () => {
  it('writes before and after snapshots and rejects updates and deletes', async () => {
    const action = `test.audit.${randomUUID()}`;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await auditable(connection, {
        organizationId: null,
        actorId: null,
        action,
        entity: 'test',
        before: { enabled: false },
        after: { enabled: true },
      });
      const [rows] = await connection.execute(
        'SELECT `before`, `after` FROM audit_log WHERE action = ?',
        [action],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].before).toEqual({ enabled: false });
      expect(rows[0].after).toEqual({ enabled: true });
      await expect(
        connection.execute('UPDATE audit_log SET action = ? WHERE action = ?', ['changed', action]),
      ).rejects.toThrow(/append-only/);
      await expect(
        connection.execute('DELETE FROM audit_log WHERE action = ?', [action]),
      ).rejects.toThrow(/append-only/);
      await connection.rollback();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  });
});
