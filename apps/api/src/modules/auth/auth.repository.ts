import { Injectable } from '@nestjs/common';
import type { RoleName } from '@repo/contracts';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * The only place the auth module touches Prisma (rules/10-backend.md).
 *
 * These interfaces are row projections, not wire shapes — the API response shape is
 * `RegisteredUser` in `@repo/contracts` and the service maps to it (I2).
 */
export interface NewUserRow {
  /** Already canonicalised by `normaliseEmail` — this layer stores what it is given. */
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
}

export interface UserRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  createdAt: Date;
}

/** The minimum login needs: who this is, and what to verify against. */
export interface CredentialRow {
  id: string;
  passwordHash: string;
  /** Minted into the access token by F10; one more column on a query already made. */
  role: RoleName;
}

/** Where a session was created from — F9 lists these back to the account owner. */
export interface SessionOrigin {
  device: string | null;
  ip: string | null;
}

/** A session row as the service refers to it after a login or a rotation. */
export interface SessionRow {
  id: string;
  userId: string;
  family: string;
  user: { role: RoleName };
}

/**
 * What happened when a refresh token was presented (F8/AC2, AC3).
 *
 * `reused` is the interesting one: the token exists and was already exchanged, which
 * means two parties hold it and one of them should not. The repository reports the
 * fact; deciding that the fact means "revoke the whole family" is the service's rule.
 */
export type RotationOutcome =
  | { outcome: 'rotated'; session: SessionRow }
  | { outcome: 'reused'; family: string; userId: string }
  | { outcome: 'rejected' }
  | { outcome: 'unknown' };

/**
 * Why an outcome rather than an exception: knowing that Postgres error 23505 arrives
 * as Prisma `P2002` is repository knowledge, and deciding that a taken email is a 409
 * with a particular message is a service decision. Returning the outcome keeps each
 * where it belongs and lets the service be unit-tested with a trivial fake.
 */
export type CreateUserOutcome = { created: true; user: UserRow } | { created: false };

/** Never selects `passwordHash` — it cannot leak into a response it is never read into. */
const USER_PROJECTION = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  createdAt: true,
} as const;

/** Never selects `refreshTokenHash` — a hash that is not read cannot be logged. */
const SESSION_PROJECTION = {
  id: true,
  userId: true,
  family: true,
  // The owner's role, for the access token minted from this session (F10).
  //
  // This DOES add a SQL statement: Prisma loads a relation with a separate query
  // unless `relationJoins` is enabled, which it is not. An earlier comment here
  // claimed it was a join in the same statement and that the refresh
  // statement-count test would catch it otherwise — both wrong. That test counts
  // Prisma CLIENT OPERATIONS, so `session.create` stays one entry no matter how
  // many statements it issues. One indexed lookup per refresh is the accepted
  // cost; see ADR-0010.
  user: { select: { role: true } },
} as const;

/** The columns F9/AC1 puts on the wire. Still no `refreshTokenHash`. */
const SESSION_LIST_PROJECTION = {
  id: true,
  device: true,
  ip: true,
  lastUsedAt: true,
  createdAt: true,
  expiresAt: true,
} as const;

/**
 * A session row as the list endpoint reads it — a row projection, not a wire shape.
 * The response type is `SessionSummary` in `@repo/contracts` and the service maps to
 * it, which is where `Date` becomes an ISO string and `current` gets decided (I2).
 */
export interface ActiveSessionRow {
  id: string;
  device: string | null;
  ip: string | null;
  lastUsedAt: Date;
  createdAt: Date;
  expiresAt: Date;
}

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Inserts the user and lets the unique index arbitrate.
   *
   * There is deliberately no `findByEmail` on this repository. A read-then-write check
   * would (a) leave a window in which two parallel registrations for the same address
   * both pass the check, and (b) make the duplicate path cheaper than the fresh one,
   * which is the timing oracle F7/AC3 forbids. The insert is one statement either way.
   *
   * `role` is not settable here. It is not in the request contract, it is not in this
   * insert, and the column's own default (CUSTOMER) supplies it — so there is no line
   * of code through which a request body could choose a role.
   */
  async createUser(input: NewUserRow): Promise<CreateUserOutcome> {
    try {
      const user = await this.prisma.client.user.create({
        data: {
          email: input.email,
          passwordHash: input.passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
        },
        select: USER_PROJECTION,
      });
      return { created: true, user };
    } catch (error) {
      if (isEmailUniqueViolation(error)) return { created: false };
      throw error;
    }
  }

  /**
   * The one lookup login needs, by canonicalised email.
   *
   * Selects the hash and nothing else beyond the id: a projection that cannot carry a
   * name or a role into a place that has not authenticated anybody yet. Registration
   * still has no way to call this — its own criterion (F7/AC3) is that the unique index
   * decides uniqueness, and its unit test asserts the exact call sequence.
   */
  async findCredentialsByEmail(email: string): Promise<CredentialRow | null> {
    return this.prisma.client.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true, role: true },
    });
  }

  /** Opens a new session family — one row, one login (F8/AC1). */
  async createSession(input: {
    userId: string;
    family: string;
    refreshTokenHash: string;
    expiresAt: Date;
    origin: SessionOrigin;
  }): Promise<SessionRow> {
    return this.prisma.client.session.create({
      data: {
        userId: input.userId,
        family: input.family,
        refreshTokenHash: input.refreshTokenHash,
        expiresAt: input.expiresAt,
        device: input.origin.device,
        ip: input.origin.ip,
      },
      select: SESSION_PROJECTION,
    });
  }

  /**
   * Exchanges a presented refresh token for its successor, atomically (F8/AC2).
   *
   * The whole exchange is one transaction, and the claim itself is a CONDITIONAL update
   * — `rotatedAt: null` is in the WHERE clause, not in an `if` above it. That is what
   * makes two simultaneous refreshes with the same token resolve to exactly one winner:
   * the second UPDATE blocks on the first's row lock, re-evaluates its WHERE after the
   * commit, matches nothing and reports `count: 0`. A read-then-write version passes
   * every sequential test and issues two live tokens under a real race.
   *
   * The pre-read exists to CLASSIFY a failure (unknown / reused / expired), never to
   * decide whether the claim succeeds — that decision is `count` and only `count`. A
   * loser of the race is reported as `reused`, which is the truthful reading: two
   * requests presented the same single-use token.
   */
  async rotateSession(input: {
    presentedHash: string;
    next: { refreshTokenHash: string; expiresAt: Date; origin: SessionOrigin };
    now?: Date;
  }): Promise<RotationOutcome> {
    const now = input.now ?? new Date();

    return this.prisma.client.$transaction(async (tx): Promise<RotationOutcome> => {
      const presented = await tx.session.findUnique({
        where: { refreshTokenHash: input.presentedHash },
        select: {
          id: true,
          userId: true,
          family: true,
          rotatedAt: true,
          revokedAt: true,
          expiresAt: true,
        },
      });

      // No such token was ever issued — or it belongs to a database that is not this
      // one. Nothing to revoke, and no family to blame.
      if (!presented) return { outcome: 'unknown' };

      if (presented.rotatedAt !== null) {
        return { outcome: 'reused', family: presented.family, userId: presented.userId };
      }

      if (presented.revokedAt !== null || presented.expiresAt <= now) {
        return { outcome: 'rejected' };
      }

      const claimed = await tx.session.updateMany({
        where: { id: presented.id, rotatedAt: null, revokedAt: null },
        data: { rotatedAt: now, lastUsedAt: now },
      });

      if (claimed.count === 0) {
        // Someone claimed this token between the read above and this update. That is
        // the race, and by definition the token was presented twice.
        return { outcome: 'reused', family: presented.family, userId: presented.userId };
      }

      const successor = await tx.session.create({
        data: {
          userId: presented.userId,
          family: presented.family,
          refreshTokenHash: input.next.refreshTokenHash,
          expiresAt: input.next.expiresAt,
          device: input.next.origin.device,
          ip: input.next.origin.ip,
        },
        select: SESSION_PROJECTION,
      });

      return { outcome: 'rotated', session: successor };
    });
  }

  /**
   * Kills every session in a lineage (F8/AC3).
   *
   * `revokedAt: null` in the WHERE keeps the original revocation timestamp when this is
   * called twice — which it will be, because a stolen token gets presented repeatedly.
   * Returns the number of sessions actually revoked, so the caller can log the blast
   * radius of a detected theft.
   */
  async revokeFamily(family: string, now: Date = new Date()): Promise<number> {
    const revoked = await this.prisma.client.session.updateMany({
      where: { family, revokedAt: null },
      data: { revokedAt: now },
    });
    return revoked.count;
  }

  /**
   * The caller's live sessions, newest first (F9/AC1).
   *
   * "Live" is three conditions, and dropping any one shows a person rows they cannot
   * act on: `revokedAt: null` (not killed), `rotatedAt: null` (not already exchanged
   * for a successor — those rows are kept as reuse evidence, not as devices), and
   * `expiresAt` in the future.
   *
   * `select` rather than the whole row: `refreshTokenHash` must never be read into a
   * process that is about to serialise something, and the surest way to guarantee that
   * is to never load it.
   */
  async listActiveSessions(userId: string, now: Date = new Date()): Promise<ActiveSessionRow[]> {
    return this.prisma.client.session.findMany({
      where: { userId, revokedAt: null, rotatedAt: null, expiresAt: { gt: now } },
      select: SESSION_LIST_PROJECTION,
      orderBy: { lastUsedAt: 'desc' },
    });
  }

  /**
   * Revokes one session, scoped by owner (F9/AC2, I4).
   *
   * `userId` is part of the WHERE, not a comparison afterwards. Fetching the row and
   * then checking who owns it leaks existence through timing, and answering 403 leaks
   * it outright — so another account's session id is indistinguishable here from one
   * that never existed, and both produce the 404 the service raises on a zero count.
   *
   * `revokedAt: null` keeps this idempotent: revoking twice returns 0 the second time
   * and leaves the original timestamp, and the caller reads 0 as "nothing to revoke"
   * rather than as an error.
   */
  async revokeSessionForUser(
    sessionId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const revoked = await this.prisma.client.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: now },
    });
    return revoked.count;
  }

  /**
   * Revokes whichever session a refresh token belongs to (F9/AC3).
   *
   * `updateMany` on the unique hash rather than `update`: a token that is unknown or
   * already revoked matches nothing and returns 0, where `update` would throw P2025 and
   * make the caller distinguish "no such token" from "done" — a distinction logout must
   * not expose. No owner scope is needed because possession of the token IS the claim.
   */
  async revokeSessionByRefreshTokenHash(
    refreshTokenHash: string,
    now: Date = new Date(),
  ): Promise<number> {
    const revoked = await this.prisma.client.session.updateMany({
      where: { refreshTokenHash, revokedAt: null },
      data: { revokedAt: now },
    });
    return revoked.count;
  }
}

/**
 * Prisma's unique-constraint failure, narrowed to the email index.
 *
 * Matched structurally on `code` rather than with `instanceof
 * PrismaClientKnownRequestError`: the driver-adapter build re-exports that class from
 * a generated path, and an `instanceof` across two copies of the module silently
 * returns false — which here would turn every duplicate registration into a 500.
 *
 * `meta.target` is the constraint name (`users_email_key`) or the column list
 * depending on driver; both are inspected. When it is absent the violation is still
 * treated as the email one, because `email` is the only unique index on the table —
 * and the alternative, rethrowing, would render a plain duplicate as a 500.
 */
function isEmailUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== 'P2002') return false;

  const target = candidate.meta?.target;
  if (typeof target === 'string') return target.toLowerCase().includes('email');
  if (Array.isArray(target)) {
    return target.some((column) => typeof column === 'string' && column.toLowerCase() === 'email');
  }

  // Absent, or a shape Prisma has not documented. `email` is the only unique index on
  // this table, so a P2002 here is that one; the alternative — rethrow — would turn an
  // ordinary duplicate registration into a 500.
  return true;
}
