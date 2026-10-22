import { Router } from 'express';
import { z } from 'zod';
import { auditable } from '../auth/audit.js';
import { authenticate, propertyScope, requirePermission } from '../auth/middleware.js';
import { logger } from '../config/logger.js';
import { getAutomationRuleDefinitions, runPropertyAutomation } from './engine.js';

const ruleUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
}).strict().refine((value) => value.enabled !== undefined || value.config !== undefined);
const idSchema = z.coerce.number().int().positive();
const limitSchema = z.coerce.number().int().min(1).max(200).default(50);

function httpError(status, code, message, details) {
  return Object.assign(new Error(message), { status, code, details });
}

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw Object.assign(new Error('Request validation failed'), {
      status: 400,
      code: 'VALIDATION_ERROR',
      details: result.error.issues,
    });
  }
  return result.data;
}

function parseJson(value, label) {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch (error) {
    throw Object.assign(httpError(500, 'INVALID_STORED_JSON', `${label} contains invalid stored JSON`), { cause: error });
  }
}

function parseRuleConfig(definition, value, key) {
  const result = definition.schema.safeParse(parseJson(value, `Automation rule ${key}`));
  if (!result.success) {
    throw Object.assign(httpError(500, 'INVALID_RULE_CONFIG', `Stored configuration for ${key} is invalid`), {
      details: result.error.issues,
    });
  }
  return result.data;
}

function failureResponse(error, _req, res, next) {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) {
    logger.error({ err: error }, 'Automation API request failed');
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'The automation request could not be completed' },
    });
  }
  return res.status(status).json({
    error: {
      code: error.code ?? 'AUTOMATION_ERROR',
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  });
}

export function createAutomationRouter(db) {
  const router = Router();
  router.use(authenticate(db), propertyScope(db));
  const manageAutomation = requirePermission(db, 'automation.manage');
  const definitions = getAutomationRuleDefinitions();

  router.get('/notifications', async (req, res, next) => {
    try {
      const limit = parse(limitSchema, req.query.limit);
      const unreadOnly = req.query.unreadOnly === 'true';
      const [roles] = await db.execute('SELECT name FROM roles WHERE id = ? LIMIT 1', [req.auth.roleId]);
      if (!roles[0]) throw httpError(403, 'FORBIDDEN', 'Your role is no longer available');
      const recipientClause = '(user_id = ? OR (user_id IS NULL AND (role = ? OR role IS NULL)))';
      const values = [req.propertyId, req.auth.sub, roles[0].name];
      const unreadClause = unreadOnly ? ' AND read_at IS NULL' : '';
      const [rows] = await db.execute(
        `SELECT id, type, payload, read_at, created_at FROM notifications
         WHERE property_id = ? AND ${recipientClause}${unreadClause}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
        [...values, limit],
      );
      const [counts] = await db.execute(
        `SELECT COUNT(*) AS unread_count FROM notifications
         WHERE property_id = ? AND ${recipientClause} AND read_at IS NULL`,
        values,
      );
      return res.json({
        data: {
          notifications: rows.map((row) => ({
            id: Number(row.id),
            type: row.type,
            payload: parseJson(row.payload, 'Notification'),
            readAt: row.read_at,
            createdAt: row.created_at,
          })),
          unreadCount: Number(counts[0].unread_count),
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/notifications/:id/read', async (req, res, next) => {
    try {
      const id = parse(idSchema, req.params.id);
      const [roles] = await db.execute('SELECT name FROM roles WHERE id = ? LIMIT 1', [req.auth.roleId]);
      if (!roles[0]) throw httpError(403, 'FORBIDDEN', 'Your role is no longer available');
      const [existing] = await db.execute(
        `SELECT id FROM notifications
         WHERE property_id = ? AND id = ?
           AND (user_id = ? OR (user_id IS NULL AND (role = ? OR role IS NULL))) LIMIT 1`,
        [req.propertyId, id, req.auth.sub, roles[0].name],
      );
      if (!existing[0]) throw httpError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found');
      await db.execute(
        `UPDATE notifications SET read_at = COALESCE(read_at, UTC_TIMESTAMP())
         WHERE property_id = ? AND id = ?
           AND (user_id = ? OR (user_id IS NULL AND (role = ? OR role IS NULL)))`,
        [req.propertyId, id, req.auth.sub, roles[0].name],
      );
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.get('/automation/rules', manageAutomation, async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        'SELECT id, `key`, enabled, config, updated_at FROM automation_rules WHERE property_id = ? ORDER BY `key`',
        [req.propertyId],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id),
        key: row.key,
        description: definitions[row.key]?.description ?? 'No description is registered for this rule.',
        mode: definitions[row.key]?.mode ?? 'scheduled',
        enabled: Boolean(row.enabled),
        config: definitions[row.key]
          ? parseRuleConfig(definitions[row.key], row.config, row.key)
          : parseJson(row.config, `Automation rule ${row.key}`),
        updatedAt: row.updated_at,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/automation/rules/:key', manageAutomation, async (req, res, next) => {
    let connection;
    try {
      const { key } = req.params;
      const definition = definitions[key];
      if (!definition) throw httpError(404, 'RULE_NOT_FOUND', 'Automation rule not found');
      if (definition.mode === 'event') {
        throw httpError(409, 'EVENT_RULE_MANAGED_BY_WORKFLOW', 'This event-driven rule is executed by its operational workflow');
      }
      const changes = parse(ruleUpdateSchema, req.body);
      const [rules] = await db.execute(
        'SELECT id, enabled, config FROM automation_rules WHERE property_id = ? AND `key` = ? LIMIT 1',
        [req.propertyId, key],
      );
      if (!rules[0]) throw httpError(404, 'RULE_NOT_FOUND', 'Automation rule is not configured for this property');
      const oldConfig = parseRuleConfig(definition, rules[0].config, key);
      const config = changes.config === undefined ? oldConfig : definition.schema.parse(changes.config);
      const enabled = changes.enabled ?? Boolean(rules[0].enabled);
      connection = await db.getConnection();
      await connection.beginTransaction();
      await connection.execute(
        'UPDATE automation_rules SET enabled = ?, config = ? WHERE property_id = ? AND id = ?',
        [enabled ? 1 : 0, JSON.stringify(config), req.propertyId, rules[0].id],
      );
      await auditable(connection, {
        organizationId: req.auth.orgId, propertyId: req.propertyId, actorId: req.auth.sub, ip: req.ip,
        action: 'automation.rule_updated', entity: 'automation_rule', entityId: rules[0].id,
        before: { key, enabled: Boolean(rules[0].enabled), config: oldConfig },
        after: { key, enabled, config },
      });
      await connection.commit();
      return res.json({ data: { id: Number(rules[0].id), key, enabled, config } });
    } catch (error) {
      if (connection) await connection.rollback();
      if (error?.name === 'ZodError') return next(Object.assign(new Error('Invalid automation rule configuration'), {
        status: 400,
        code: 'VALIDATION_ERROR',
        details: error.issues,
      }));
      return next(error);
    } finally {
      connection?.release();
    }
  });

  router.post('/automation/run', manageAutomation, async (req, res, next) => {
    try {
      const result = await runPropertyAutomation(db, req.propertyId);
      return res.json({ data: result });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/automation/logs', manageAutomation, async (req, res, next) => {
    try {
      const limit = parse(limitSchema, req.query.limit);
      const ruleKey = req.query.ruleKey === undefined ? null : String(req.query.ruleKey);
      if (ruleKey && !definitions[ruleKey]) throw httpError(400, 'INVALID_RULE', 'Unknown automation rule');
      const [rows] = await db.execute(
        `SELECT id, rule_key, entity, entity_id, result, created_at
         FROM automation_log WHERE property_id = ? AND (? IS NULL OR rule_key = ?)
         ORDER BY created_at DESC, id DESC LIMIT ?`,
        [req.propertyId, ruleKey, ruleKey, limit],
      );
      return res.json({ data: rows.map((row) => ({
        id: Number(row.id), ruleKey: row.rule_key, entity: row.entity, entityId: row.entity_id,
        result: parseJson(row.result, 'Automation log'), createdAt: row.created_at,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.use((req, res, next) => {
    if (req.path.startsWith('/automation') || req.path.startsWith('/notifications')) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Automation route not found' } });
    }
    return next();
  });
  router.use(failureResponse);
  return router;
}
