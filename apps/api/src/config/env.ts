import { z } from 'zod';

/**
 * Environment contract — validated once at boot (F4/AC2).
 *
 * A missing or malformed variable fails fast with a message naming it, instead of
 * surfacing at 3am as a connection error on the first request that needed it.
 * process.env is read HERE and nowhere else (rules/10-backend.md).
 *
 * Defaults exist so a fresh clone runs against the compose stack with zero setup —
 * but ONLY outside production. In production every connection-bearing variable must
 * be explicit: security-auditor demonstrated (#65) that without this, a production
 * deploy with no configuration boots green against localhost with the committed dev
 * password, and a missing REDIS_URL points sessions at whatever answers on 6389.
 */
const PRODUCTION_REQUIRED = ['DATABASE_URL', 'REDIS_URL'] as const;

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().max(65535).default(3001),
    API_PREFIX: z.string().default('api/v1'),
    DATABASE_URL: z
      .url()
      .default(
        'postgresql://ecommerce:ecommerce_dev_password@localhost:5442/ecommerce?schema=public',
      ),
    REDIS_URL: z.url().default('redis://localhost:6389'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    for (const name of PRODUCTION_REQUIRED) {
      // A default that "validated" is indistinguishable from a set value after
      // parsing, so the check must consult the raw source captured below.
      if (!rawSourceBeingValidated?.[name]) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `${name} must be set explicitly in production — the development default (localhost, committed dev credentials) must never be silently inherited`,
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * The raw env being validated, visible to the superRefine above. Zod refinements see
 * post-default values, so "was it actually set?" needs the original source. Scoped to
 * the duration of validateEnv — not reentrant, which is fine for a boot-time check.
 */
let rawSourceBeingValidated: NodeJS.ProcessEnv | undefined;

export function validateEnv(source: NodeJS.ProcessEnv = process.env): Env {
  rawSourceBeingValidated = source;
  try {
    const result = envSchema.safeParse(source);
    if (!result.success) {
      const details = result.error.issues
        .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n');
      throw new Error(
        `Environment validation failed — fix these variables before the API can start:\n${details}`,
      );
    }
    return result.data;
  } finally {
    rawSourceBeingValidated = undefined;
  }
}
