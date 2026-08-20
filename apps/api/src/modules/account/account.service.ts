import { Injectable } from '@nestjs/common';
import type {
  Address,
  CreateAddressRequest,
  Profile,
  UpdateAddressRequest,
  UpdateProfileRequest,
} from '@repo/contracts';
import { MAX_ADDRESSES_PER_ACCOUNT } from '@repo/contracts';
import { ConflictError, NotFoundError } from '../../common/errors/domain-error';
import { AccountRepository, type AddressRow, type ProfileRow } from './account.repository';

/**
 * Profile and address book (SPEC.md F12).
 *
 * Every method takes the caller's id from the verified token and hands it to the
 * repository, which puts it in the `WHERE`. Nothing here compares an owner after a
 * fetch, so no branch in this file can distinguish "belongs to someone else" from
 * "does not exist" — which is the property I4 asks for, held by construction rather
 * than by remembering to write the same check each time.
 */

/** Postgres unique-violation code, as Prisma reports it. */
const UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class AccountService {
  constructor(private readonly accounts: AccountRepository) {}

  async getProfile(userId: string): Promise<Profile> {
    const row = await this.accounts.findProfile(userId);
    // A verified token whose subject has no row means the account was deleted while the
    // token was still live. 404 is honest; 500 would blame the server for it.
    if (!row) throw new NotFoundError('No such account.');
    return toProfile(row);
  }

  async updateProfile(userId: string, input: UpdateProfileRequest): Promise<Profile> {
    const existing = await this.accounts.findProfile(userId);
    if (!existing) throw new NotFoundError('No such account.');
    return toProfile(await this.accounts.updateProfile(userId, input));
  }

  async listAddresses(userId: string): Promise<Address[]> {
    return (await this.accounts.listAddresses(userId)).map(toAddress);
  }

  async getAddress(addressId: string, userId: string): Promise<Address> {
    const row = await this.accounts.findAddressForUser(addressId, userId);
    if (!row) throw new NotFoundError('No such address.');
    return toAddress(row);
  }

  /**
   * Creates an address (F12/AC2).
   *
   * The partial unique index can still reject this even though the repository clears
   * the previous default first — that is the point of having it. Two parallel creates
   * both claiming the default for one kind race, one commits, and the other arrives
   * here as a unique violation. Rendering that as 409 rather than letting it surface as
   * a 500 is the difference between "try again" and "the server is broken".
   */
  async createAddress(userId: string, input: CreateAddressRequest): Promise<Address> {
    // A resource cap, not rate limiting. The security review of PR #95 stored 120
    // addresses in parallel on one account and read all of them back in a single 35 KB
    // response; F51's throttling would slow that down without ever bounding it. The
    // count is a cheap indexed query on a column the list endpoint already filters by.
    const held = await this.accounts.countAddresses(userId);
    if (held >= MAX_ADDRESSES_PER_ACCOUNT) {
      throw new ConflictError(
        `An account may hold at most ${MAX_ADDRESSES_PER_ACCOUNT} addresses. Remove one first.`,
      );
    }

    try {
      return toAddress(await this.accounts.createAddress(userId, input));
    } catch (error) {
      if (isDefaultCollision(error)) throw defaultCollision();
      throw error;
    }
  }

  async updateAddress(
    addressId: string,
    userId: string,
    input: UpdateAddressRequest,
  ): Promise<Address> {
    try {
      const row = await this.accounts.updateAddressForUser(addressId, userId, input);
      if (!row) throw new NotFoundError('No such address.');
      return toAddress(row);
    } catch (error) {
      if (isDefaultCollision(error)) throw defaultCollision();
      throw error;
    }
  }

  /**
   * Deletes an address (F12/AC2, AC3).
   *
   * Deleting the default is allowed and does not promote a replacement. Choosing one
   * for the caller would be guessing at intent, and an account with no default is a
   * state checkout has to handle anyway — a first-time buyer has none.
   */
  async deleteAddress(addressId: string, userId: string): Promise<void> {
    const removed = await this.accounts.deleteAddressForUser(addressId, userId);
    if (removed === 0) throw new NotFoundError('No such address.');
  }
}

function toProfile(row: ProfileRow): Profile {
  // Field by field, so widening the projection later cannot add a column to a response
  // about someone's identity.
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    role: row.role,
    emailVerifiedAt: row.emailVerifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toAddress(row: AddressRow): Address {
  return {
    id: row.id,
    kind: row.kind,
    isDefault: row.isDefault,
    fullName: row.fullName,
    line1: row.line1,
    line2: row.line2,
    city: row.city,
    region: row.region,
    postalCode: row.postalCode,
    country: row.country,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function defaultCollision(): ConflictError {
  return new ConflictError('Another address is already the default for that kind. Try again.');
}

/**
 * A unique violation on the partial default index, matched structurally.
 *
 * `code` rather than `instanceof PrismaClientKnownRequestError`: the driver-adapter
 * build re-exports that class from a generated path, and an `instanceof` across two
 * copies of the module silently returns false — the same trap `auth.repository.ts`
 * documents, where it would have turned every duplicate email into a 500.
 *
 * Narrowed to the index by name so an unrelated unique violation still surfaces as the
 * 500 it is, rather than being mislabelled a default collision.
 */
function isDefaultCollision(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== UNIQUE_VIOLATION) return false;

  const target = candidate.meta?.target;
  const name = 'addresses_one_default_per_kind';
  if (typeof target === 'string') return target.includes(name);
  if (Array.isArray(target)) {
    return target.some((entry) => typeof entry === 'string' && entry.includes(name));
  }
  // Absent target: `addresses` has one other unique constraint (its primary key), which
  // this code path cannot violate, so a P2002 here is the default index.
  return true;
}
