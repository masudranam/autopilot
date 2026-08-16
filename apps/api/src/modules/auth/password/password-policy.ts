import { ValidationError } from '../../../common/errors/domain-error';
import { COMMON_PASSWORDS } from './common-passwords';

/**
 * The "not in a common-password list" half of F7/AC2.
 *
 * The length half lives in `passwordSchema` in `@repo/contracts` and is applied by the
 * global validation pipe before this ever runs. Both produce the same wire shape — a
 * 422 with a `password` entry in `errors[]` — because both raise the same
 * `ValidationError` and one filter renders it (I3).
 *
 * The set is built once at module load, so the check is a hash lookup per registration
 * rather than a scan.
 */
const BLOCKED = new Set(COMMON_PASSWORDS.map((entry) => entry.toLowerCase()));

/**
 * Case-insensitive: `Password1234` is `password1234` with the shift key held down and
 * is exactly as guessable. Folding case can only ever reject more, which is the safe
 * direction for a blocklist.
 */
export function isCommonPassword(password: string): boolean {
  return BLOCKED.has(password.toLowerCase());
}

/** How many entries are long enough to matter given the minimum length — see the spec. */
export function commonPasswordsAtLeast(length: number): number {
  return COMMON_PASSWORDS.filter((entry) => entry.length >= length).length;
}

export function assertPasswordIsAllowed(password: string): void {
  if (!isCommonPassword(password)) return;

  // Per-field, because "422" with no indication of WHICH field is a form the user
  // cannot fix. The message names the reason without naming the list.
  throw new ValidationError('The password does not meet the password policy.', [
    {
      path: 'password',
      message: 'This password is among the most commonly used ones. Choose a different one.',
    },
  ]);
}
