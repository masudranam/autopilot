import { z } from 'zod';

/**
 * Environment contract — validated once at boot (F4/AC2).
 *
 * A missing or malformed variable fails fast with a message naming it, instead of
 * surfacing at 3am as a connection error on the first request that needed it.
 * process.env is read HERE and nowhere else (CLAUDE.md § Backend).
 *
 * Defaults exist so a fresh clone runs against the compose stack with zero setup —
 * but ONLY outside production. In production every connection-bearing variable must
 * be explicit: security-auditor demonstrated (#65) that without this, a production
 * deploy with no configuration boots green against localhost with the committed dev
 * password, and a missing REDIS_URL points sessions at whatever answers on 6389.
 */
const PRODUCTION_REQUIRED = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
] as const;

/**
 * Development-only signing keys.
 *
 * They exist for the same reason the localhost DATABASE_URL default does — a fresh
 * clone has to run `pnpm dev` and the test suite without anyone writing a `.env` — and
 * they are safe only because they can never be used in production: the names are in
 * PRODUCTION_REQUIRED, so the variable must be set explicitly there, AND the refinement
 * below rejects these exact strings even if someone copies them into a production
 * environment. Both halves matter: "must be set" alone is satisfied by pasting the
 * default back in.
 */
const DEV_ACCESS_SECRET = 'development-only-access-secret-do-not-use-in-production';
const DEV_REFRESH_SECRET = 'development-only-refresh-secret-do-not-use-in-production';

const DEVELOPMENT_ONLY_SECRETS: Readonly<Partial<Record<string, string>>> = {
  JWT_ACCESS_SECRET: DEV_ACCESS_SECRET,
  JWT_REFRESH_SECRET: DEV_REFRESH_SECRET,
};

/**
 * Minimum secret length. HS256 keys shorter than the 256-bit digest weaken the MAC,
 * and a short one is invariably a human-chosen password rather than CSPRNG output.
 */
export const JWT_SECRET_MIN_LENGTH = 32;

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
    /**
     * Un-silences structured logs under NODE_ENV=test, where they are off by default
     * so request logging does not bury a CI assertion failure. Declared here because
     * every variable this app reads belongs in this schema — pr-reviewer caught it
     * being read with a bare process.env, contradicting this file's own header.
     */
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    /**
     * HS256 signing key for the 15-minute access token (F8).
     *
     * `.min()` before `.default()` would not check the default itself; declaring the
     * default on the string schema means the constraint applies to whatever value ends
     * up being used, development one included.
     */
    JWT_ACCESS_SECRET: z
      .string()
      .min(
        JWT_SECRET_MIN_LENGTH,
        `Must be at least ${JWT_SECRET_MIN_LENGTH} characters — generate one with 'openssl rand -hex 32'`,
      )
      .default(DEV_ACCESS_SECRET),
    /**
     * Keyed hashing for refresh tokens (F8). The stored value is
     * `HMAC-SHA256(JWT_REFRESH_SECRET, token)`, so a leaked database dump alone does
     * not let an attacker confirm a guessed token — they need the key as well.
     */
    JWT_REFRESH_SECRET: z
      .string()
      .min(
        JWT_SECRET_MIN_LENGTH,
        `Must be at least ${JWT_SECRET_MIN_LENGTH} characters — generate one with 'openssl rand -hex 32'`,
      )
      .default(DEV_REFRESH_SECRET),
    /**
     * Whether to serve /api/docs, /api/docs-json and /api/docs-yaml (issue #66).
     *
     * Left unset it follows NODE_ENV, which is what almost every deployment wants; the
     * explicit form exists for the staging box that genuinely wants the document, and
     * for turning docs OFF in development while reproducing a production problem.
     */
    DOCS_ENABLED: z.stringbool().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    for (const name of PRODUCTION_REQUIRED) {
      // A default that "validated" is indistinguishable from a set value after
      // parsing, so the check must consult the raw source captured below.
      const supplied = rawSourceBeingValidated?.[name];
      if (!supplied) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `${name} must be set explicitly in production — the development default (localhost, committed dev credentials) must never be silently inherited`,
        });
        continue;
      }
      // Set, but set to the value that ships in this repository. "Explicit" is not the
      // property that matters; "not publicly known" is.
      if (supplied === DEVELOPMENT_ONLY_SECRETS[name]) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `${name} is the development default, which is committed to this repository and therefore public — generate a real one with 'openssl rand -hex 32'`,
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema> & {
  /**
   * Whether to suppress internal error detail on the wire.
   *
   * Derived from whether NODE_ENV was EXPLICITLY development or test — not from the
   * parsed value, which defaults to 'development'. security-auditor showed the
   * `=== 'production'` form failing open: with NODE_ENV unset the server booted
   * verbose, returning raw internal messages to clients. Absent or unrecognised now
   * means suppressed. The connection-string defaults still apply, so a fresh clone
   * runs with zero setup — it is only disclosure that fails closed.
   */
  readonly suppressInternalErrors: boolean;

  /**
   * Whether the OpenAPI document and its Swagger UI are mounted at all (issue #66).
   *
   * Derived the same fail-closed way as `suppressInternalErrors`, and for the same
   * reason: once authenticated routes exist, the document is a complete, machine-
   * readable map of the attack surface — every path, every parameter, every shape —
   * served to anonymous callers. `DOCS_ENABLED` overrides when set; otherwise only an
   * EXPLICIT development or test NODE_ENV enables it, so an unconfigured deploy serves
   * no document rather than deciding it must be a dev box.
   */
  readonly docsEnabled: boolean;
};

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

    const explicit = source.NODE_ENV;
    const isExplicitNonProduction = explicit === 'development' || explicit === 'test';
    return {
      ...result.data,
      suppressInternalErrors: !isExplicitNonProduction,
      docsEnabled: result.data.DOCS_ENABLED ?? isExplicitNonProduction,
    };
  } finally {
    rawSourceBeingValidated = undefined;
  }
}
