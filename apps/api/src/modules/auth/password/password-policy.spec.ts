/**
 * F7/AC2 — the common-password half of the policy.
 *
 * The tests that matter here use entries of twelve characters or more. A blocklist
 * test built on `password` or `123456` would pass with the blocklist deleted, because
 * PASSWORD_MIN_LENGTH already rejects those — the test would be measuring the wrong
 * rule and would keep passing through the regression it exists to catch.
 */
import { PASSWORD_MIN_LENGTH } from '@repo/contracts';
import { ValidationError } from '../../../common/errors/domain-error';
import { COMMON_PASSWORDS } from './common-passwords';
import {
  assertPasswordIsAllowed,
  commonPasswordsAtLeast,
  isCommonPassword,
} from './password-policy';

describe('isCommonPassword', () => {
  it.each([
    'password1234',
    'qwertyuiopasd',
    'iloveyou1234',
    'correcthorsebatterystaple',
    'letmeinletmein',
  ])('blocks %s, which is long enough to pass the length rule', (password) => {
    expect(password.length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
    expect(isCommonPassword(password)).toBe(true);
  });

  it('folds case — Password1234 is the same guess as password1234', () => {
    expect(isCommonPassword('Password1234')).toBe(true);
    expect(isCommonPassword('PASSWORD1234')).toBe(true);
    expect(isCommonPassword('PaSsWoRd1234')).toBe(true);
  });

  it('allows a passphrase that is not on the list', () => {
    expect(isCommonPassword('marmalade-tuesday-gantry')).toBe(false);
    expect(isCommonPassword('password1234!')).toBe(false);
  });
});

describe('assertPasswordIsAllowed', () => {
  it('throws a 422 ValidationError naming the password field (AC2)', () => {
    expect.assertions(4);
    try {
      assertPasswordIsAllowed('password1234');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const failure = error as ValidationError;
      expect(failure.status).toBe(422);
      expect(failure.errors).toHaveLength(1);
      expect(failure.errors?.[0]?.path).toBe('password');
    }
  });

  it('does not repeat the rejected password back in the error', () => {
    // Captured, not caught in a try/catch around the call. The previous shape put the
    // "it should have thrown" guard INSIDE the try, so its own catch swallowed it:
    // with the blocklist disabled the function returned, the guard Error was caught,
    // and both assertions passed against that Error instead. Verified — the test was
    // green with `assertPasswordIsAllowed` reduced to a no-op.
    let thrown: unknown;
    try {
      assertPasswordIsAllowed('correcthorsebatterystaple');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    const failure = thrown as ValidationError;
    expect(JSON.stringify(failure)).not.toContain('correcthorse');
    expect(failure.message).not.toContain('correcthorse');
    expect(failure.errors?.[0]?.message).not.toContain('correcthorse');
  });

  it('returns quietly for an acceptable password', () => {
    expect(() => assertPasswordIsAllowed('marmalade-tuesday-gantry')).not.toThrow();
  });
});

describe('the dataset itself', () => {
  it('carries enough entries at or above the minimum length to be worth consulting', () => {
    // Without this, the list could rot into nothing but short classics and every
    // blocklist test above would still pass by virtue of the length rule.
    expect(commonPasswordsAtLeast(PASSWORD_MIN_LENGTH)).toBeGreaterThanOrEqual(150);
  });

  it('is stored normalised — lower-cased and untrimmed entries would never match', () => {
    for (const entry of COMMON_PASSWORDS) {
      expect(entry).toBe(entry.toLowerCase().trim());
      expect(entry.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(COMMON_PASSWORDS).size).toBe(COMMON_PASSWORDS.length);
  });
});
