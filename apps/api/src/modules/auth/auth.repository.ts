import { Injectable } from '@nestjs/common';
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
