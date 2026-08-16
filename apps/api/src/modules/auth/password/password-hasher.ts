import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { ARGON2_PARAMETERS } from './argon2-parameters';

/**
 * Argon2id password hashing — F7/AC1, and the parameter choice recorded in
 * docs/adr/0009-argon2id-password-hashing.md.
 *
 * `@node-rs/argon2` ships prebuilt platform binaries, so there is no node-gyp step in
 * CI or on a fresh clone.
 *
 * The cost parameters live in `./argon2-parameters` so the seed — which runs outside
 * Nest — can hash with exactly the same profile without importing a decorated class.
 */

export { ARGON2_PARAMETERS };

@Injectable()
export class PasswordHasher {
  /**
   * A hash of a value nobody knows, computed once when this provider is constructed.
   *
   * F8/AC4 turns on it. Login for an address that does not exist must still pay a full
   * Argon2id verify, or "no such user" answers in about a millisecond while "wrong
   * password" takes ~30 ms, and the endpoint is an email-enumeration oracle no matter
   * how identical the two response bodies are. Verifying against THIS costs exactly
   * what verifying a real credential costs, because it was produced with the same
   * parameters.
   *
   * Started in the constructor rather than lazily on the first miss: a lazy version
   * would make the very first unknown-email login pay hash + verify while every later
   * one paid only verify, which is a smaller oracle but still an oracle. The `.catch`
   * attaches a handler so a failure here is not an unhandled rejection — it is still
   * raised at the `await` in `verifyAgainstDummy`, where it becomes a 500 rather than
   * a silently-skipped verify.
   */
  private readonly dummyHash: Promise<string>;

  constructor() {
    this.dummyHash = hash(randomBytes(32).toString('hex'), ARGON2_PARAMETERS);
    void this.dummyHash.catch(() => undefined);
  }

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

  /**
   * Constant-time comparison of a candidate password against a stored PHC hash.
   *
   * A malformed or unparseable stored hash returns false rather than throwing. The
   * seed writes placeholder hashes for its demo accounts, and a throw there would be a
   * 500 that distinguishes "account with an unusable hash" from "wrong password" —
   * another way to answer the question AC4 says must not be answerable.
   *
   * No options argument: cost parameters, salt and version all travel inside the PHC
   * string, so verification uses what the hash was actually made with. Passing today's
   * parameters instead would silently start rejecting every credential hashed under an
   * older cost the day the cost is raised.
   */
  async verify(storedHash: string, candidate: string): Promise<boolean> {
    try {
      return await verify(storedHash, candidate);
    } catch {
      return false;
    }
  }

  /**
   * Pays the verify cost when there is no credential to check, and always answers
   * false. Callers use this so that both branches of "does this account exist" execute
   * the same work (F8/AC4).
   */
  async verifyAgainstDummy(candidate: string): Promise<false> {
    await this.verify(await this.dummyHash, candidate);
    return false;
  }
}
