import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  authTokensSchema,
  EMAIL_MAX_LENGTH,
  loginRequestSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  REFRESH_TOKEN_BYTES,
  REFRESH_TOKEN_TTL_SECONDS,
  refreshTokenSchema,
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

  it('rejects a non-ISO createdAt (F7)', () => {
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

// ------------------------------------------------------------------ F8

describe('loginRequestSchema', () => {
  const credentials = { email: 'ada@example.com', password: 'a-perfectly-fine-passphrase' };

  it('accepts a well-formed login', () => {
    expect(loginRequestSchema.parse(credentials)).toEqual(credentials);
  });

  /**
   * The enumeration property, stated as a schema test (F8/AC4).
   *
   * If login ever validated the password against the REGISTRATION policy, an
   * eleven-character attempt would come back 422 while a twelve-character one came back
   * 401 — two distinguishable answers, one of them free of any hashing cost. Both must
   * reach the service and be indistinguishable there.
   */
  it('accepts a password the registration policy would reject (AC4)', () => {
    expect(loginRequestSchema.safeParse({ ...credentials, password: 'x' }).success).toBe(true);
    expect(
      loginRequestSchema.safeParse({
        ...credentials,
        password: 'x'.repeat(PASSWORD_MIN_LENGTH - 1),
      }).success,
    ).toBe(true);
    // …and the registration schema really would have rejected it, so the test above is
    // asserting a difference that exists.
    expect(
      registerRequestSchema.safeParse({
        ...credentials,
        firstName: 'Ada',
        lastName: 'Lovelace',
        password: 'x',
      }).success,
    ).toBe(false);
  });

  it('still bounds the input so an oversized body is not hashed', () => {
    expect(
      loginRequestSchema.safeParse({
        ...credentials,
        password: 'x'.repeat(PASSWORD_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(loginRequestSchema.safeParse({ ...credentials, password: '' }).success).toBe(false);
  });

  it('rejects a malformed email and an unknown key', () => {
    expect(loginRequestSchema.safeParse({ ...credentials, email: 'nope' }).success).toBe(false);
    expect(loginRequestSchema.safeParse({ ...credentials, role: 'ADMIN' }).success).toBe(false);
  });

  it('trims the email so an autofilled trailing space is not a failed login', () => {
    expect(loginRequestSchema.parse({ ...credentials, email: '  Ada@Example.com ' }).email).toBe(
      'Ada@Example.com',
    );
  });
});

describe('token constants', () => {
  /**
   * AC5 names fifteen minutes. Expressed as a literal, because every other test in the
   * suite reads the constant and would stay green if it became fifteen seconds.
   */
  it('access tokens live for exactly 15 minutes (AC5)', () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
  });

  it('refresh tokens live for 30 days (SPEC §6.4)', () => {
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(2_592_000);
  });
});

describe('refreshTokenSchema', () => {
  it('accepts what the minter actually produces', () => {
    for (let i = 0; i < 20; i += 1) {
      const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
      expect(refreshTokenSchema.safeParse(token).success).toBe(true);
    }
  });

  it('rejects anything else — a cookie is caller-controlled input', () => {
    for (const bad of [
      '',
      'short',
      `${randomBytes(REFRESH_TOKEN_BYTES).toString('base64url')}x`,
      randomBytes(REFRESH_TOKEN_BYTES).toString('base64'), // padded / non-url alphabet
      randomBytes(16).toString('base64url'),
      "' OR 1=1 --",
    ]) {
      expect(refreshTokenSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('authTokensSchema', () => {
  it('carries the access token and nothing that would leak the refresh token', () => {
    expect(Object.keys(authTokensSchema.shape).sort()).toEqual([
      'accessToken',
      'expiresIn',
      'tokenType',
    ]);
  });

  it('rejects a token response whose type is not Bearer', () => {
    const valid = { accessToken: 'header.payload.signature', tokenType: 'Bearer', expiresIn: 900 };
    expect(authTokensSchema.safeParse(valid).success).toBe(true);
    expect(authTokensSchema.safeParse({ ...valid, tokenType: 'bearer' }).success).toBe(false);
    expect(authTokensSchema.safeParse({ ...valid, expiresIn: 0 }).success).toBe(false);
    expect(authTokensSchema.safeParse({ ...valid, accessToken: '' }).success).toBe(false);
  });
});
