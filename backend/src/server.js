// API process entry point.
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { checkDatabaseVersion } from './db/check-version.js';
import { pool } from './db/pool.js';
import { initializeRealtime } from './realtime.js';
import { runPropertyAutomation } from './automation/engine.js';
import { initializeLicenses } from './platform/licensing.js';

try {
  await checkDatabaseVersion(pool);
} catch (error) {
  logger.warn({ err: error }, 'Could not check database version during startup');
}
try {
  await initializeLicenses(pool);
} catch (error) {
  logger.error({ err: error }, 'Could not initialize local license verification');
}

const server = createServer(createApp());
initializeRealtime(server, pool);
let automationCycleRunning = false;
async function runAutomationCycle() {
  if (automationCycleRunning) return;
  automationCycleRunning = true;
  try {
    const [properties] = await pool.execute('SELECT id FROM properties WHERE is_active = 1 ORDER BY id');
    for (const property of properties) {
      try {
        await runPropertyAutomation(pool, Number(property.id));
      } catch (error) {
        logger.error({ err: error, propertyId: Number(property.id) }, 'Scheduled automation cycle failed for property');
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'Could not list properties for scheduled automation');
  } finally {
    automationCycleRunning = false;
  }
}
const automationTimer = setInterval(() => { void runAutomationCycle(); }, 5 * 60 * 1000);
automationTimer.unref();
void runAutomationCycle();
server.listen(env.API_PORT, env.API_HOST, () => {
  logger.info({ host: env.API_HOST, port: env.API_PORT }, 'SmartHotel API listening');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(async () => {
    await pool.end();
    process.exit(0);
  }));
}
