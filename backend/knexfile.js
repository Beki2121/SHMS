import { env } from './src/config/env.js';

export default {
  development: {
    client: 'mysql2',
    connection: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      charset: 'utf8mb4',
      dateStrings: true,
    },
    pool: { min: 0, max: env.DB_CONNECTION_LIMIT },
    migrations: { directory: './migrations', extension: 'js', loadExtensions: ['.js'] },
    seeds: { directory: './seeds', extension: 'js', loadExtensions: ['.js'] },
  },
  test: {
    client: 'mysql2',
    connection: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      charset: 'utf8mb4',
      dateStrings: true,
    },
    pool: { min: 0, max: env.DB_CONNECTION_LIMIT },
    migrations: { directory: './migrations', extension: 'js', loadExtensions: ['.js'] },
    seeds: { directory: './seeds', extension: 'js', loadExtensions: ['.js'] },
  },
  production: {
    client: 'mysql2',
    connection: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      charset: 'utf8mb4',
      dateStrings: true,
    },
    pool: { min: 0, max: env.DB_CONNECTION_LIMIT },
    migrations: { directory: './migrations', extension: 'js', loadExtensions: ['.js'] },
    seeds: { directory: './seeds', extension: 'js', loadExtensions: ['.js'] },
  },
};
