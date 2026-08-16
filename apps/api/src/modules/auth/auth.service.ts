import { Injectable } from '@nestjs/common';
import type { RegisterRequest, RegisteredUser } from '@repo/contracts';
import { ConflictError } from '../../common/errors/domain-error';
import { AuthRepository } from './auth.repository';
import { normaliseEmail } from './email-normalisation';
import { PasswordHasher } from './password/password-hasher';
import { assertPasswordIsAllowed } from './password/password-policy';

/**
 * Registration (SPEC.md F7). Login, tokens and verification are F8 and F11.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly users: AuthRepository,
    private readonly hasher: PasswordHasher,
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
}
