// Startup compatibility check for MySQL and MariaDB.
import { logger } from '../config/logger.js';

export async function checkDatabaseVersion(db) {
  const [rows] = await db.query('SELECT VERSION() AS version');
  const version = String(rows[0]?.version ?? '');
  const isMysql8 = /^(8\.|9\.)/.test(version);
  const mariaVersion = version.match(/(\d+\.\d+\.\d+)-MariaDB/i)?.[1];
  const isSupportedMaria = mariaVersion && Number(mariaVersion.split('.')[0]) >= 10 &&
    (Number(mariaVersion.split('.')[0]) > 10 || Number(mariaVersion.split('.')[1]) >= 5);

  if (!isMysql8 && !isSupportedMaria) {
    logger.warn({ version }, 'Database version is not MySQL 8 or MariaDB 10.5+; compatibility is not guaranteed');
  } else {
    logger.info({ version }, 'Supported database server detected');
  }
  return version;
}
