// Create the configured utf8mb4 database without selecting it first.
import mysql from 'mysql2/promise';
import { env } from '../config/env.js';

const connection = await mysql.createConnection({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
});

try {
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${env.DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  process.stdout.write(`Database "${env.DB_NAME}" is ready.\n`);
} finally {
  await connection.end();
}
