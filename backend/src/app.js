// Express application and Phase 1 health endpoint.
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { pool } from './db/pool.js';
import { createAuthRouter } from './auth/routes.js';
import { createPropertyRouter } from './property/routes.js';
import { createGuestRouter } from './guests/routes.js';
import { createReservationRouter } from './reservations/routes.js';
import { createStayRouter } from './stays/routes.js';
import { createFinanceRouter } from './finance/routes.js';
import { createHousekeepingRouter } from './housekeeping/routes.js';
import { createMaintenanceRouter } from './maintenance/routes.js';
import { createStaffRouter } from './staff/routes.js';
import { createOperationsRouter } from './operations/routes.js';
import { createAutomationRouter } from './automation/routes.js';
import { createReportsRouter } from './reports/routes.js';
import { requireModule, authenticate } from './auth/middleware.js';
import { checkLicenseWriteAccess } from './platform/licensing.js';
import { createPlatformRouter } from './platform/routes.js';

export function createApp({ db = pool } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', async (_req, res) => {
    let database = 'unavailable';
    try {
      await db.query('SELECT 1');
      database = 'ok';
    } catch (error) {
      logger.warn({ err: error }, 'Health check could not reach the database');
    }
    const status = database === 'ok' ? 200 : 503;
    res.status(status).json({ data: { status: status === 200 ? 'ok' : 'degraded', database } });
  });

  app.use('/api', (req, res, next) => {
    const publicAuthPath = ['/auth/login', '/auth/refresh', '/auth/logout'].includes(req.path);
    if (req.path === '/health' || publicAuthPath || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    return authenticate(db)(req, res, (error) => {
      if (error) return next(error);
      if (req.auth?.supportSessionId) {
        if (req.path === '/platform/support/exit') return next();
        return res.status(403).json({
          error: { code: 'SUPPORT_READ_ONLY', message: 'Support access is read-only' },
        });
      }
      return checkLicenseWriteAccess(db)(req, res, next);
    });
  });
  app.use('/api/reservations', authenticate(db), requireModule(db, 'reservations'));
  app.use('/api/stays', authenticate(db), requireModule(db, 'reservations'));
  app.use('/api/walk-ins', authenticate(db), requireModule(db, 'reservations'));
  app.use('/api/housekeeping', authenticate(db), requireModule(db, 'housekeeping'));
  app.use('/api/maintenance', authenticate(db), requireModule(db, 'maintenance'));
  app.use('/api/staff', authenticate(db), requireModule(db, 'staff'));
  app.use('/api/inventory', authenticate(db), requireModule(db, 'inventory'));
  app.use('/api/reports', authenticate(db), requireModule(db, 'reports'));
  app.use('/api/guests', authenticate(db), requireModule(db, 'reservations'));
  app.use('/api/companies', authenticate(db), requireModule(db, 'reservations'));
  app.use('/api/guest-groups', authenticate(db), requireModule(db, 'reservations'));
  app.use('/api/guest-requests', authenticate(db), requireModule(db, 'reservations'));
  app.use('/api/property/rooms', authenticate(db), requireModule(db, 'reservations'));
  app.use('/api/property/room-types', authenticate(db), requireModule(db, 'reservations'));
  app.use('/api/property/rate-plans', authenticate(db), requireModule(db, 'reservations'));
  app.use('/api/property/rates', authenticate(db), requireModule(db, 'reservations'));

  app.use('/api/auth', createAuthRouter(db));
  app.use('/api/platform', createPlatformRouter(db));
  app.use('/api', createPropertyRouter(db));
  app.use('/api', createGuestRouter(db));
  app.use('/api', createReservationRouter(db));
  app.use('/api', createStayRouter(db));
  app.use('/api', createFinanceRouter(db));
  app.use('/api', createHousekeepingRouter(db));
  app.use('/api', createStaffRouter(db));
  app.use('/api', createOperationsRouter(db));
  app.use('/api', createAutomationRouter(db));
  app.use('/api', createReportsRouter(db));
  app.use('/api', createMaintenanceRouter(db));

  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
  return app;
}
