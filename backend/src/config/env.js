// Validate runtime configuration once at process startup.
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
  DB_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/)
    .default('smarthotel'),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default('root'),
  DB_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
  JWT_ACCESS_SECRET: z.string().min(32).default('development-only-secret-change-before-deploying'),
  GUEST_PII_ENCRYPTION_KEY: z.string().min(32).default('development-only-guest-pii-key-change-before-production'),
  LICENSE_FILE_PATH: z.string().optional(),
  LICENSE_PUBLIC_KEY: z.string().optional(),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

const result = schema.safeParse(process.env);
if (!result.success) {
  const issues = result.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid environment configuration: ${issues}`);
}

if (result.data.NODE_ENV === 'production' && !process.env.JWT_ACCESS_SECRET) {
  throw new Error('Invalid environment configuration: JWT_ACCESS_SECRET is required in production');
}
if (result.data.NODE_ENV === 'production' && !process.env.GUEST_PII_ENCRYPTION_KEY) {
  throw new Error('Invalid environment configuration: GUEST_PII_ENCRYPTION_KEY is required in production');
}

export const env = result.data;
