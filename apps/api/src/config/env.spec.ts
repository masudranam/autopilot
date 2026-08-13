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
