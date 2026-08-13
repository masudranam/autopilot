import { validateEnv } from './env';

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
    const partial = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@db.internal:5432/shop',
    };
    expect(() => validateEnv(partial)).toThrow(/REDIS_URL/);
    expect(() => validateEnv(partial)).not.toThrow(/DATABASE_URL[^_]/);
  });

  it('a fully-specified production env passes and keeps the given values', () => {
    const env = validateEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@db.internal:5432/shop',
      REDIS_URL: 'redis://cache.internal:6379',
    });
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
    [
      'production',
      {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://u:p@h:5432/d',
        REDIS_URL: 'redis://h:6379',
      },
      true,
    ],
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
