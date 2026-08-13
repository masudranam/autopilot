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
