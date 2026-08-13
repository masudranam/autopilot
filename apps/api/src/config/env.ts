import { z } from 'zod';

/**
 * Environment contract — validated once at boot (F4/AC2).
 *
 * A missing or malformed variable fails fast with a message naming it, instead of
 * surfacing at 3am as a connection error on the first request that needed it.
 * process.env is read HERE and nowhere else (rules/10-backend.md).
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().max(65535).default(3001),
  API_PREFIX: z.string().default('api/v1'),
  DATABASE_URL: z
    .url()
    .default(
      'postgresql://ecommerce:ecommerce_dev_password@localhost:5442/ecommerce?schema=public',
    ),
  REDIS_URL: z.url().default('redis://localhost:6389'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Environment validation failed — fix these variables before the API can start:\n${details}\n` +
        `(Defaults exist for local development; production must set every variable explicitly.)`,
    );
  }
  return result.data;
}
