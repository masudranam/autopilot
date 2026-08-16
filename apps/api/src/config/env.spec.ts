import { JWT_SECRET_MIN_LENGTH, validateEnv } from './env';

/**
 * A production environment with every required variable supplied.
 *
 * Spread and overridden per test, so a test about ONE missing variable does not
 * accidentally also assert the others — and so adding a new production requirement
 * fails the tests that should notice it rather than silently passing.
 */
const PRODUCTION = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@db.internal:5432/shop',
  REDIS_URL: 'redis://cache.internal:6379',
  JWT_ACCESS_SECRET: 'f2b4e1c0a97d4f3e8b6a5c4d3e2f1a0b',
  JWT_REFRESH_SECRET: '0b1a2f3e4d5c6a7b8e9f4d7a0c9b1e2f',
};

describe('environment validation (F4/AC2)', () => {
  it('applies development defaults when nothing is set', () => {
    const env = validateEnv({});
    expect(env.API_PORT).toBe(3001);
    expect(env.API_PREFIX).toBe('api/v1');
    expect(env.NODE_ENV).toBe('development');
  });

  it('coerces the port from a string, as it arrives from the environment', () => {
    expect(validateEnv({ API_PORT: '4000' }).API_PORT).toBe(4000);
  });

  // The AC: a bad variable fails fast with a message NAMING it.
  it.each([
    ['API_PORT', { API_PORT: 'not-a-port' }],
    ['DATABASE_URL', { DATABASE_URL: 'not a url' }],
    ['REDIS_URL', { REDIS_URL: ':::' }],
    ['NODE_ENV', { NODE_ENV: 'staging' }],
  ])('a bad %s fails fast and the error names the variable', (name, overrides) => {
    expect(() => validateEnv(overrides as NodeJS.ProcessEnv)).toThrow(
      expect.objectContaining({ message: expect.stringContaining(name) }) as Error,
    );
  });

  it('rejects an out-of-range port', () => {
    expect(() => validateEnv({ API_PORT: '70000' })).toThrow(/API_PORT/);
  });
});

describe('production refuses to inherit development defaults (#65)', () => {
  // security-auditor demonstrated that without this, a production deploy with zero
  // configuration boots green against localhost with the committed dev password.
  it('a production env with nothing set fails fast, naming every missing variable', () => {
    expect(() => validateEnv({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ NODE_ENV: 'production' })).toThrow(/REDIS_URL/);
  });

  it('a production env missing only REDIS_URL names exactly that', () => {
    const { REDIS_URL: _omitted, ...partial } = PRODUCTION;
    expect(() => validateEnv(partial)).toThrow(/REDIS_URL/);
    expect(() => validateEnv(partial)).not.toThrow(/DATABASE_URL[^_]/);
  });

  it('a fully-specified production env passes and keeps the given values', () => {
    const env = validateEnv(PRODUCTION);
    expect(env.DATABASE_URL).toContain('db.internal');
    expect(env.REDIS_URL).toContain('cache.internal');
  });

  it('development and test still get the zero-setup defaults', () => {
    expect(validateEnv({}).DATABASE_URL).toContain('localhost:5442');
    expect(validateEnv({ NODE_ENV: 'test' }).REDIS_URL).toContain('localhost:6389');
  });
});

/**
 * The trigger for AC2's suppression, which had no test at all: pr-reviewer reverted
 * the derivation to `explicit === 'production'` — the exact fail-open form
 * security-auditor originally reported — and the whole suite stayed green at 139/139.
 * Only the NODE_ENV-unset case changes under that mutation, and nothing looked at it.
 */
describe('suppressInternalErrors fails closed (AC2 trigger)', () => {
  it.each([
    ['unset', {}, true],
    ['production', PRODUCTION, true],
    ['development', { NODE_ENV: 'development' }, false],
    ['test', { NODE_ENV: 'test' }, false],
  ])('%s → suppress=%s', (_label, source, expected) => {
    expect(validateEnv(source).suppressInternalErrors).toBe(expected);
  });

  // An empty string is not one of the three valid values, so it does not reach the
  // derivation at all — the app refuses to boot. Also fail-closed, by a different route.
  it.each([[''], ['staging'], ['PRODUCTION']])(
    'refuses to boot on NODE_ENV=%o rather than guessing',
    (value) => {
      expect(() => validateEnv({ NODE_ENV: value })).toThrow(/NODE_ENV/);
    },
  );

  // The specific regression: absence must NOT be treated as development. An
  // unconfigured deploy has to suppress, not narrate its internals to clients.
  it('an unset NODE_ENV suppresses, because an unconfigured deploy is not a dev box', () => {
    expect(validateEnv({}).suppressInternalErrors).toBe(true);
    // …while still keeping the zero-setup connection defaults, so a fresh clone runs.
    expect(validateEnv({}).DATABASE_URL).toContain('localhost:5442');
  });
});

/**
 * JWT signing keys (F8).
 *
 * The development defaults exist so a fresh clone runs the API and its test suite with
 * no setup, exactly like the localhost DATABASE_URL. That is only safe while production
 * cannot inherit them, which takes both halves tested below: "must be set" AND "must
 * not be set to the published default".
 */
describe('JWT secrets (F8)', () => {
  it('development gets a working default so a fresh clone can sign tokens', () => {
    const env = validateEnv({});
    expect(env.JWT_ACCESS_SECRET.length).toBeGreaterThanOrEqual(JWT_SECRET_MIN_LENGTH);
    expect(env.JWT_REFRESH_SECRET.length).toBeGreaterThanOrEqual(JWT_SECRET_MIN_LENGTH);
    // Two different keys: reusing one secret for both purposes means a token forged for
    // one is valid for the other.
    expect(env.JWT_ACCESS_SECRET).not.toBe(env.JWT_REFRESH_SECRET);
  });

  it.each(['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'])(
    'production without %s fails fast, naming it',
    (name) => {
      const incomplete: Record<string, string> = { ...PRODUCTION };
      delete incomplete[name];
      expect(() => validateEnv(incomplete)).toThrow(new RegExp(name));
    },
  );

  /**
   * The half that "must be set explicitly" does not cover.
   *
   * Pasting the repository's own development secret into a production environment
   * satisfies every "is it set?" check while leaving the signing key public — anyone
   * with the repository can then mint an access token for any user id.
   */
  it.each(['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'])(
    'production refuses the published development value of %s',
    (name) => {
      const development = validateEnv({});
      const leaked = {
        ...PRODUCTION,
        [name]: development[name as 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET'],
      };
      expect(() => validateEnv(leaked)).toThrow(new RegExp(name));
      expect(() => validateEnv(leaked)).toThrow(/public/);
    },
  );

  it('rejects a short secret in any environment', () => {
    expect(() => validateEnv({ JWT_ACCESS_SECRET: 'too-short' })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() =>
      validateEnv({ JWT_REFRESH_SECRET: 'x'.repeat(JWT_SECRET_MIN_LENGTH - 1) }),
    ).toThrow(/JWT_REFRESH_SECRET/);
    expect(() =>
      validateEnv({ JWT_REFRESH_SECRET: 'x'.repeat(JWT_SECRET_MIN_LENGTH) }),
    ).not.toThrow();
  });
});

/**
 * Serving the OpenAPI document (issue #66).
 *
 * The document enumerates every route, parameter and payload shape. Handing that to
 * anonymous callers in production is free reconnaissance, so the flag fails closed the
 * same way `suppressInternalErrors` does — absence is not evidence of a dev box.
 */
describe('docsEnabled fails closed (#66)', () => {
  it.each([
    ['unset NODE_ENV', {}, false],
    ['production', PRODUCTION, false],
    ['development', { NODE_ENV: 'development' }, true],
    ['test', { NODE_ENV: 'test' }, true],
  ])('%s → docs=%s', (_label, source, expected) => {
    expect(validateEnv(source).docsEnabled).toBe(expected);
  });

  it('DOCS_ENABLED overrides in both directions', () => {
    expect(validateEnv({ ...PRODUCTION, DOCS_ENABLED: 'true' }).docsEnabled).toBe(true);
    expect(validateEnv({ NODE_ENV: 'development', DOCS_ENABLED: 'false' }).docsEnabled).toBe(false);
  });

  it('refuses to boot on a DOCS_ENABLED it cannot interpret, rather than guessing', () => {
    // "maybe" is not a boolean, and guessing which way to read it is precisely the
    // decision that must not be made silently.
    expect(() => validateEnv({ DOCS_ENABLED: 'maybe' })).toThrow(/DOCS_ENABLED/);
  });
});
