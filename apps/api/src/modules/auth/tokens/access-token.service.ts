import { Inject, Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  ACCESS_TOKEN_TTL_SECONDS,
  accessTokenClaimsSchema,
} from '@repo/contracts';
import type { AccessTokenClaims, AuthTokens } from '@repo/contracts';
import { UnauthenticatedError } from '../../../common/errors/domain-error';
import type { Env } from '../../../config/env';
import { ENV } from '../../../config/env.module';

/**
 * The stateless half of F8: a 15-minute HS256 access token.
 *
 * Symmetric rather than asymmetric because exactly one service both signs and verifies
 * these. RS256 would buy public verification by a party that does not exist yet, at the
 * cost of a key pair to distribute; if an edge verifier ever appears, the claims schema
 * is already in `@repo/contracts` and only this file changes.
 */

/**
 * One message for every way an access token can fail (F8/AC5).
 *
 * "Expired", "malformed", "signed with the wrong key" and "issued for another audience"
 * are all the same fact from the caller's side — the token is not usable — and telling
 * them apart is free reconnaissance for anyone probing with forged tokens.
 */
export const ACCESS_TOKEN_REJECTED = 'Your session has expired or the token is not valid.';

@Injectable()
export class AccessTokenService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  /**
   * `sid` binds the token to the session that minted it, which is what lets F9 revoke
   * an access token's lineage — a stateless token with only `sub` in it stays valid for
   * its full lifetime after the session is revoked, and there is nothing to look up.
   */
  issue(input: { userId: string; sessionId: string }): AuthTokens {
    const accessToken = jwt.sign({ sid: input.sessionId }, this.env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      subject: input.userId,
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });

    return { accessToken, tokenType: 'Bearer', expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }

  /**
   * Verifies signature, expiry, issuer and audience, then parses the payload with the
   * contract schema.
   *
   * `algorithms: ['HS256']` is not decoration. Without it, jsonwebtoken accepts whatever
   * algorithm the token's own header names — the classic confusion attack, where an
   * attacker re-signs a payload with `alg: none` or with the (public) verification key
   * of an asymmetric scheme and the library obligingly agrees.
   *
   * Every failure — including an expired token, which is AC5's case — becomes an
   * `UnauthenticatedError`, so the global filter renders 401 Problem Details. Letting
   * jsonwebtoken's own `TokenExpiredError` escape would surface as a 500, which is
   * precisely what AC5 forbids; and a raw `ZodError` escaping the parse below would
   * ALSO be a 500, because the filter deliberately treats a bare ZodError as an
   * internal fault (see problem-details.filter.ts).
   */
  verify(token: string): AccessTokenClaims {
    try {
      const payload = jwt.verify(token, this.env.JWT_ACCESS_SECRET, {
        algorithms: ['HS256'],
        issuer: ACCESS_TOKEN_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
      });
      return accessTokenClaimsSchema.parse(payload);
    } catch {
      throw new UnauthenticatedError(ACCESS_TOKEN_REJECTED);
    }
  }
}
