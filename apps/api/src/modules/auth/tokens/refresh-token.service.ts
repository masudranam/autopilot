import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { REFRESH_TOKEN_BYTES, REFRESH_TOKEN_TTL_SECONDS } from '@repo/contracts';
import type { Env } from '../../../config/env';
import { ENV } from '../../../config/env.module';

/**
 * A freshly minted refresh token and everything the database needs to store it.
 *
 * `token` is the ONLY copy of the plaintext that exists — it goes into the Set-Cookie
 * header and nowhere else. It is never persisted, never logged, and never returned in a
 * response body.
 */
export interface MintedRefreshToken {
  readonly token: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

/**
 * Refresh tokens: opaque, 256-bit, stored as a keyed hash (F8/AC2, AC3).
 *
 * Why an opaque random string rather than a second JWT: a refresh token has to be
 * revocable and single-use, which means a database row must be consulted on every
 * refresh regardless. A JWT would add a signature to verify and claims to keep in sync
 * with that row while buying nothing — and its payload would be readable by anyone who
 * got hold of the cookie.
 *
 * Why HMAC-SHA256 and not Argon2id, when passwords in this same module are Argon2id:
 * the threat models are different. A password is low-entropy and human-chosen, so the
 * defence is to make each guess expensive. A refresh token is 256 bits of CSPRNG output
 * — guessing is already infeasible — so a slow KDF would only add ~30 ms to every
 * refresh. It also could not work: Argon2 salts per hash, so the stored value cannot be
 * looked up by index, and rotation would degrade into scanning the sessions table.
 * The HMAC key (JWT_REFRESH_SECRET) is what a plain SHA-256 would lack: with it, a
 * stolen database dump alone does not let an attacker confirm a guessed token, because
 * the hash cannot be recomputed without the key.
 */
@Injectable()
export class RefreshTokenService {
  private readonly hmacKey: string;

  constructor(@Inject(ENV) env: Env) {
    this.hmacKey = env.JWT_REFRESH_SECRET;
  }

  mint(now: Date = new Date()): MintedRefreshToken {
    // base64url: cookie-safe with no percent-encoding, so what the browser stores is
    // byte-for-byte what was issued.
    const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    return {
      token,
      tokenHash: this.hash(token),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    };
  }

  /**
   * Deterministic, so the presented token can be found by its unique index.
   *
   * No timing-safe comparison here and none needed: the comparison is done by Postgres
   * on an indexed column, and what an attacker would have to guess is the 256-bit
   * pre-image, not the digest.
   */
  hash(token: string): string {
    return createHmac('sha256', this.hmacKey).update(token, 'utf8').digest('hex');
  }

  /**
   * A new session family — the lineage a login starts and every rotation extends.
   *
   * Reuse of any token in the family revokes all of them (AC3), so the id is what ties
   * a stolen token back to the sessions that must die with it.
   */
  newFamily(): string {
    return randomUUID();
  }
}
