import type { Options } from '@node-rs/argon2';

/**
 * Argon2id cost parameters — docs/adr/0009-argon2id-password-hashing.md.
 *
 * In their own file, free of `@nestjs/common`, so non-DI code can import them. The seed
 * runs under `tsx` with no `reflect-metadata` loaded, and importing anything carrying an
 * `@Injectable()` decorator there fails at import time with a `Reflect.defineMetadata`
 * TypeError — which would have made "seed the demo accounts with real hashes" fail in a
 * way that looks like a Prisma problem.
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
