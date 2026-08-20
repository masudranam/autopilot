import { Injectable } from '@nestjs/common';
import type { AddressKindName, RoleName } from '@repo/contracts';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * The only place the account module touches Prisma (CLAUDE.md § Backend).
 *
 * EVERY method here takes `userId` and puts it in the `WHERE` clause. Not one of them
 * fetches a row and compares the owner afterwards, and there is deliberately no
 * `findAddressById(id)` without an owner — the absence is the safeguard. A method that
 * can load another user's row is a method someone will call (I4).
 */

/** Row projections, not wire shapes. The service maps to the contract types (I2). */
export interface ProfileRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: RoleName;
  emailVerifiedAt: Date | null;
  createdAt: Date;
}

export interface AddressRow {
  id: string;
  kind: AddressKindName;
  isDefault: boolean;
  fullName: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string;
  country: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Never selects `passwordHash`. A column that is not read cannot be serialised. */
const PROFILE_PROJECTION = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  emailVerifiedAt: true,
  createdAt: true,
} as const;

/** Never selects `userId` — it is not on the wire, and the caller already knows it. */
const ADDRESS_PROJECTION = {
  id: true,
  kind: true,
  isDefault: true,
  fullName: true,
  line1: true,
  line2: true,
  city: true,
  region: true,
  postalCode: true,
  country: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * What a create must supply. Mirrors the non-nullable columns rather than making
 * everything optional — Prisma rejects a create missing one, and typing them optional
 * here would move that failure from compile time to runtime.
 */
export interface NewAddressFields {
  kind: AddressKindName;
  isDefault: boolean;
  fullName: string;
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postalCode: string;
  country: string;
}

/** What an update may set. All optional; `kind` is create-only (see the contract). */
export interface AddressFields {
  isDefault?: boolean;
  fullName?: string;
  line1?: string;
  line2?: string | null;
  city?: string;
  region?: string | null;
  postalCode?: string;
  country?: string;
}

@Injectable()
export class AccountRepository {
  constructor(private readonly prisma: PrismaService) {}

  findProfile(userId: string): Promise<ProfileRow | null> {
    return this.prisma.client.user.findUnique({
      where: { id: userId },
      select: PROFILE_PROJECTION,
    });
  }

  /**
   * Updates the caller's own names.
   *
   * `update` on the primary key is safe here in a way it would not be for an address:
   * the id comes from the verified token's `sub`, never from the path, so there is no
   * caller-supplied identifier to scope.
   */
  updateProfile(
    userId: string,
    data: { firstName?: string; lastName?: string },
  ): Promise<ProfileRow> {
    return this.prisma.client.user.update({
      where: { id: userId },
      data,
      select: PROFILE_PROJECTION,
    });
  }

  listAddresses(userId: string): Promise<AddressRow[]> {
    return this.prisma.client.address.findMany({
      where: { userId },
      select: ADDRESS_PROJECTION,
      // Defaults first, then newest — the order a person expects to see them in.
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  /** Scoped by owner, so another account's id is indistinguishable from a missing one. */
  findAddressForUser(addressId: string, userId: string): Promise<AddressRow | null> {
    return this.prisma.client.address.findFirst({
      where: { id: addressId, userId },
      select: ADDRESS_PROJECTION,
    });
  }

  /**
   * Creates an address, clearing the previous default for that kind when this one
   * claims it (F12/AC2).
   *
   * Both statements are in ONE transaction. Split apart, a failure between them leaves
   * the account with no default at all — and the partial unique index would reject the
   * insert anyway if the old default were still set, so the clear is not optional.
   *
   * The index is what makes this correct under concurrency rather than merely usually
   * correct: two parallel creates both claiming the default cannot both commit.
   */
  createAddress(userId: string, input: NewAddressFields): Promise<AddressRow> {
    const { kind, isDefault, ...fields } = input;

    return this.prisma.client.$transaction(async (tx) => {
      if (isDefault) {
        await tx.address.updateMany({
          where: { userId, kind, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.address.create({
        data: { userId, kind, isDefault, ...fields },
        select: ADDRESS_PROJECTION,
      });
    });
  }

  /**
   * Updates one of the caller's addresses, returning null when it is not theirs.
   *
   * The ownership check is the `updateMany` count, not a prior read: `updateMany` with
   * `{ id, userId }` touches zero rows for another account's address, and zero rows is
   * what the service turns into a 404. `update` on the id alone would succeed on
   * somebody else's row.
   *
   * Clearing the previous default happens first and inside the same transaction, for
   * the same reason as create.
   */
  async updateAddressForUser(
    addressId: string,
    userId: string,
    fields: AddressFields,
  ): Promise<AddressRow | null> {
    return this.prisma.client.$transaction(async (tx) => {
      if (fields.isDefault === true) {
        // Scoped to this address's own kind — read within the transaction and still
        // owner-scoped, so it cannot reveal or touch another account's row.
        const target = await tx.address.findFirst({
          where: { id: addressId, userId },
          select: { kind: true },
        });
        if (!target) return null;

        await tx.address.updateMany({
          where: { userId, kind: target.kind, isDefault: true, NOT: { id: addressId } },
          data: { isDefault: false },
        });
      }

      const changed = await tx.address.updateMany({
        where: { id: addressId, userId },
        data: fields,
      });
      if (changed.count === 0) return null;

      return tx.address.findFirstOrThrow({
        where: { id: addressId, userId },
        select: ADDRESS_PROJECTION,
      });
    });
  }

  /** Returns the number of rows removed — zero means "not this caller's", i.e. a 404. */
  async deleteAddressForUser(addressId: string, userId: string): Promise<number> {
    const deleted = await this.prisma.client.address.deleteMany({
      where: { id: addressId, userId },
    });
    return deleted.count;
  }
}
