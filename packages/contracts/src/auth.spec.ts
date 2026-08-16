import { describe, expect, it } from 'vitest';
import {
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  registerRequestSchema,
  registeredUserSchema,
} from './auth';

const valid = {
  email: 'ada@example.com',
  password: 'a-perfectly-fine-passphrase',
  firstName: 'Ada',
  lastName: 'Lovelace',
};

function paths(input: unknown): string[] {
  const result = registerRequestSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join('.'));
}

describe('registerRequestSchema', () => {
  it('accepts a well-formed registration', () => {
    expect(registerRequestSchema.parse(valid)).toEqual(valid);
  });

  it('trims surrounding whitespace on the email but does not case-fold it (F7/AC4 is server-side)', () => {
    const parsed = registerRequestSchema.parse({ ...valid, email: '  A@B.com  ' });
    expect(parsed.email).toBe('A@B.com');
  });

  it('trims names', () => {
    const parsed = registerRequestSchema.parse({ ...valid, firstName: '  Ada  ' });
    expect(parsed.firstName).toBe('Ada');
  });

  /**
   * The number F7/AC2 actually names, asserted as a number.
   *
   * Every other length test in this file is expressed in terms of
   * `PASSWORD_MIN_LENGTH`, which makes each of them true for any value of the
   * constant. Verified: setting it to 8 left all 103 tests in this package green.
   * AC2 says "min 12 chars", so twelve is written out here literally, and the two
   * boundary cases are too — a relative boundary test cannot pin a boundary.
   */
  it('enforces the twelve-character minimum F7/AC2 names, literally (AC2)', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(registerRequestSchema.safeParse({ ...valid, password: 'x'.repeat(11) }).success).toBe(
      false,
    );
    expect(registerRequestSchema.safeParse({ ...valid, password: 'x'.repeat(12) }).success).toBe(
      true,
    );
  });

  it(`rejects a password shorter than ${PASSWORD_MIN_LENGTH} characters (AC2)`, () => {
    expect(paths({ ...valid, password: 'x'.repeat(PASSWORD_MIN_LENGTH - 1) })).toEqual([
      'password',
    ]);
    expect(paths({ ...valid, password: 'x'.repeat(PASSWORD_MIN_LENGTH) })).toEqual([]);
  });

  it('rejects an oversized password rather than handing it to the hasher', () => {
    expect(paths({ ...valid, password: 'x'.repeat(PASSWORD_MAX_LENGTH + 1) })).toEqual([
      'password',
    ]);
  });

  it('does not trim the password — spaces are password characters', () => {
    const password = `  ${'space-padded-passphrase'}  `;
    expect(registerRequestSchema.parse({ ...valid, password }).password).toBe(password);
  });

  it('rejects a malformed email', () => {
    expect(paths({ ...valid, email: 'not-an-email' })).toEqual(['email']);
    expect(paths({ ...valid, email: `${'a'.repeat(EMAIL_MAX_LENGTH)}@example.com` })).toEqual([
      'email',
    ]);
  });

  it('rejects empty or missing fields, one entry per field (AC2)', () => {
    expect(paths({ ...valid, firstName: '   ' })).toEqual(['firstName']);
    expect(paths({}).sort()).toEqual(['email', 'firstName', 'lastName', 'password']);
  });

  it('rejects an unknown key instead of silently stripping it', () => {
    const result = registerRequestSchema.safeParse({ ...valid, role: 'ADMIN' });
    expect(result.success).toBe(false);
  });
});

describe('registeredUserSchema', () => {
  it('describes exactly the fields registration returns — no password material', () => {
    expect(Object.keys(registeredUserSchema.shape).sort()).toEqual([
      'createdAt',
      'email',
      'firstName',
      'id',
      'lastName',
    ]);
  });

  it('rejects a non-ISO createdAt', () => {
    const user = {
      id: '018f1f77-bcf8-7c3d-9a3b-2c4c6b3f0a11',
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      createdAt: 'yesterday',
    };
    expect(registeredUserSchema.safeParse(user).success).toBe(false);
    expect(
      registeredUserSchema.safeParse({ ...user, createdAt: '2026-08-14T10:00:00.000Z' }).success,
    ).toBe(true);
  });
});
