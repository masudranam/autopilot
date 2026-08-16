import { Injectable } from '@nestjs/common';
import { refreshTokenSchema } from '@repo/contracts';
import type { AuthTokens, LoginRequest, RegisterRequest, RegisteredUser } from '@repo/contracts';
import { ConflictError, UnauthenticatedError } from '../../common/errors/domain-error';
import { logger } from '../../common/logging/logger';
import { AuthRepository, type SessionOrigin } from './auth.repository';
import { normaliseEmail } from './email-normalisation';
import { PasswordHasher } from './password/password-hasher';
import { assertPasswordIsAllowed } from './password/password-policy';
import { AccessTokenService } from './tokens/access-token.service';
import { RefreshTokenService } from './tokens/refresh-token.service';

/**
 * Registration (SPEC.md F7) and the login/refresh exchange (F8). Verification and
 * password reset are F11; session listing and logout are F9.
 */

/**
 * The single answer to every failed login (F8/AC4).
 *
 * "No such account" and "wrong password" must be indistinguishable — same status, same
 * problem type, same bytes — because the alternative is a free account-enumeration API.
 * Constant time is the other half, and it lives in `login` below.
 */
export const INVALID_CREDENTIALS = 'Email address or password is incorrect.';

/**
 * The single answer to every failed refresh: unknown token, expired token, revoked
 * session, and a reused token that just cost its family every session (AC3). A caller
 * holding a bad token learns only that it is bad.
 */
export const SESSION_NOT_VALID = 'Your session is no longer valid. Sign in again.';

/**
 * What a caller gets from a successful login or refresh.
 *
 * `refreshToken` is the plaintext, and it exists on this object for exactly one hop:
 * the controller writes it into the Set-Cookie header. It is not part of `tokens`, so
 * it cannot reach a response body by someone widening a return value.
 */
export interface IssuedSession {
  readonly tokens: AuthTokens;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: AuthRepository,
    private readonly hasher: PasswordHasher,
    private readonly accessTokens: AccessTokenService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  /**
   * ORDER OF OPERATIONS IS THE SECURITY PROPERTY HERE (AC3).
   *
   * The blocklist check runs first — it depends only on the password, never on the
   * email, so it tells an attacker nothing about which addresses exist. Then the
   * password is hashed, and only then does anything touch the users table.
   *
   * Hashing before the insert is what makes a duplicate registration cost the same
   * wall-clock time as a fresh one: ~50 ms of memory-hard work dominates both, and
   * there is no earlier branch that could return without paying it. The obvious
   * alternative — look the address up, return 409 if found — answers in about a
   * millisecond for a taken address and 50 ms for a free one, which turns the endpoint
   * into a fast email-enumeration oracle even if the response bodies are identical.
   *
   * Uniqueness itself is decided by the database index, not by this code, so two
   * parallel registrations of the same address cannot both succeed.
   */
  async register(input: RegisterRequest): Promise<RegisteredUser> {
    assertPasswordIsAllowed(input.password);

    const email = normaliseEmail(input.email);
    const passwordHash = await this.hasher.hash(input.password);

    const outcome = await this.users.createUser({
      email,
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
    });

    if (!outcome.created) {
      // No address in the message. The 409 status already concedes that this
      // particular address is taken — that is unavoidable for a registration form
      // people have to be able to use — but the body is copied into logs, error
      // trackers and screenshots, and none of those need the address in them.
      throw new ConflictError('An account with that email address already exists.');
    }

    // Built field by field rather than spread, so widening the row projection later
    // cannot silently add a column to the public response.
    return {
      id: outcome.user.id,
      email: outcome.user.email,
      firstName: outcome.user.firstName,
      lastName: outcome.user.lastName,
      createdAt: outcome.user.createdAt.toISOString(),
    };
  }

  /**
   * EVERY PATH THROUGH THIS METHOD PAYS FOR ONE ARGON2ID VERIFY (F8/AC4).
   *
   * That is the whole design. An unknown address verifies the submitted password
   * against a dummy hash generated at startup with the same parameters and then fails;
   * a known address verifies against the real hash and may fail too. Both spend ~30 ms
   * in the same memory-hard function, and both raise the same error with the same
   * message, so neither the clock nor the body distinguishes them.
   *
   * Skipping the verify when there is no user is the obvious optimisation and the exact
   * bug: it answers in about a millisecond, and an attacker with a wordlist of email
   * addresses can partition it into "registered here" and "not" as fast as the network
   * allows — without ever guessing a password.
   *
   * `!credentials || !matches` rather than a short-circuit above: by the time control
   * reaches the check, the expensive work is already done either way.
   */
  async login(input: LoginRequest, origin: SessionOrigin): Promise<IssuedSession> {
    const email = normaliseEmail(input.email);
    const credentials = await this.users.findCredentialsByEmail(email);

    const passwordMatches = credentials
      ? await this.hasher.verify(credentials.passwordHash, input.password)
      : await this.hasher.verifyAgainstDummy(input.password);

    if (!credentials || !passwordMatches) {
      throw new UnauthenticatedError(INVALID_CREDENTIALS);
    }

    const refresh = this.refreshTokens.mint();
    const session = await this.users.createSession({
      userId: credentials.id,
      family: this.refreshTokens.newFamily(),
      refreshTokenHash: refresh.tokenHash,
      expiresAt: refresh.expiresAt,
      origin,
    });

    return {
      tokens: this.accessTokens.issue({ userId: session.userId, sessionId: session.id }),
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt,
    };
  }

  /**
   * Rotates a refresh token, and treats a second use of one as theft (AC2, AC3).
   *
   * The presented value is parsed with the contract schema before it is hashed: a
   * cookie is caller-controlled input like any other (I2). A malformed one is answered
   * with the same 401 as a valid-looking but unknown one, because "your cookie is the
   * wrong shape" is information about the token format, not about this caller.
   *
   * There is deliberately no grace window on reuse. rules/60-security.md states the
   * rule plainly — presenting an already-rotated token is evidence of theft, not a
   * retry — and a grace window is exactly the seam an attacker races into: it turns
   * "one of you is an impostor" into "both of you get a token". The cost is real and
   * accepted: a client that fires two refreshes at once loses the session family. A
   * client should serialise its refreshes.
   */
  async refresh(presented: string | undefined, origin: SessionOrigin): Promise<IssuedSession> {
    const parsed = refreshTokenSchema.safeParse(presented);
    if (!parsed.success) throw new UnauthenticatedError(SESSION_NOT_VALID);

    const next = this.refreshTokens.mint();
    const result = await this.users.rotateSession({
      presentedHash: this.refreshTokens.hash(parsed.data),
      next: { refreshTokenHash: next.tokenHash, expiresAt: next.expiresAt, origin },
    });

    if (result.outcome === 'rotated') {
      return {
        tokens: this.accessTokens.issue({
          userId: result.session.userId,
          sessionId: result.session.id,
        }),
        refreshToken: next.token,
        refreshTokenExpiresAt: next.expiresAt,
      };
    }

    if (result.outcome === 'reused') {
      const revoked = await this.users.revokeFamily(result.family);
      // Worth an alert, and safe to record: ids only. The token itself is never logged
      // — a log line carrying it would hand a live credential to anyone with read
      // access to the logs, which is a much larger set of people than it looks.
      logger.warn('refresh token reuse detected — session family revoked', {
        userId: result.userId,
        family: result.family,
        sessionsRevoked: revoked,
      });
    }

    throw new UnauthenticatedError(SESSION_NOT_VALID);
  }
}
