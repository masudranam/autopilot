import { Injectable } from '@nestjs/common';
import { hash, type Options } from '@node-rs/argon2';

/**
 * Argon2id password hashing — F7/AC1, and the parameter choice recorded in
 * docs/adr/0009-argon2id-password-hashing.md.
 *
 * `@node-rs/argon2` ships prebuilt platform binaries, so there is no node-gyp step in
 * CI or on a fresh clone.
 */

/**
 * `Algorithm.Argon2id`.
 *
 * The literal 2 rather than the enum member: `Algorithm` is an ambient `const enum` in
 * the package's `.d.ts`, which `isolatedModules` forbids reading, and the runtime
 * export is an empty object — `Algorithm.Argon2id` would compile to `undefined` and
 * silently select the library default. The number is pinned by a test that asserts the
 * encoded hash begins with `$argon2id$`, so a wrong constant fails loudly rather than
 * quietly downgrading everyone's password to Argon2d.
 */
const ARGON2ID = 2 as Options['algorithm'];

/**
 * OWASP Password Storage Cheat Sheet's first Argon2id profile: m=19 MiB, t=2, p=1.
 * See the ADR for why this one and not a heavier profile.
 */
export const ARGON2_PARAMETERS: Options = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

@Injectable()
export class PasswordHasher {
  /**
   * Returns a PHC-encoded hash: `$argon2id$v=19$m=…,t=…,p=…$<salt>$<digest>`.
   *
   * The salt is generated per call by the library, and the parameters travel inside
   * the string — so raising the cost later does not invalidate existing hashes, and
   * nothing else has to be stored alongside.
   */
  hash(plaintext: string): Promise<string> {
    return hash(plaintext, ARGON2_PARAMETERS);
  }
}
