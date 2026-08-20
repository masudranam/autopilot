import { z } from 'zod';
import { AddressKind, ADDRESS_KIND_VALUES } from './enums.generated';
import {
  CONTROL_CHARACTER_MESSAGE,
  emailSchema,
  noControlCharacters,
  personNameSchema,
  roleSchema,
} from './auth';

/**
 * Profile and address-book contracts (SPEC.md F12).
 *
 * The only declaration of these shapes; apps import the inferred types (I2, ADR-0002).
 */

/** Address kind, from the Prisma enum rather than a hand-written union (§ Contracts). */
export const addressKindSchema = z.enum(ADDRESS_KIND_VALUES);

export type AddressKindName = z.infer<typeof addressKindSchema>;

/**
 * The caller's own profile (F12/AC1).
 *
 * `email` is present but is NOT editable through `PATCH /me`: changing an address of
 * record has to re-verify it, which is F11's job. Exposing it here read-only means a
 * client can render the account page without a second request, while the update schema
 * below simply has no field for it.
 *
 * `role` is included because a client legitimately needs it to decide what to render —
 * and it is not a secret: the caller already learns it by trying. It is typed from the
 * generated Prisma enum, never a hand-written union.
 */
export const profileSchema = z.object({
  id: z.uuid(),
  email: emailSchema,
  firstName: z.string(),
  lastName: z.string(),
  // From the generated Prisma enum via `roleSchema`. Writing z.enum(['CUSTOMER', ...])
  // here is the exact duplication § Contracts forbids, and the reason the generator
  // exists — I typed it that way first, which is how easy it is to do.
  role: roleSchema,
  emailVerifiedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export type Profile = z.infer<typeof profileSchema>;

/**
 * What `PATCH /me` accepts (F12/AC1).
 *
 * `strictObject`, and deliberately only the two name fields. An unknown key is a 422
 * rather than a silent no-op, so `{"role":"ADMIN"}` or `{"email":"..."}` fails loudly
 * instead of looking like it worked — the same reasoning as `registerRequestSchema`.
 *
 * Both fields optional, but `refine` rejects an empty body: a PATCH that changes nothing
 * is a client bug, and answering 200 to it hides the bug.
 */
export const updateProfileRequestSchema = z
  .strictObject({
    firstName: personNameSchema.optional(),
    lastName: personNameSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Provide at least one field to update',
  });

export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

/** ISO 3166-1 alpha-2, upper-cased. Two letters is the whole rule. */
export const countrySchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((value) => /^[A-Z]{2}$/.test(value), {
    message: 'Must be a two-letter ISO 3166-1 alpha-2 country code',
  });

const addressLineSchema = z
  .string()
  .trim()
  .min(1, 'Must not be empty')
  .max(200)
  .refine(noControlCharacters, { message: CONTROL_CHARACTER_MESSAGE });

const optionalAddressLineSchema = z
  .string()
  .trim()
  .max(200)
  .refine(noControlCharacters, { message: CONTROL_CHARACTER_MESSAGE })
  .nullable()
  .optional();

/** Same guard as the lines above; a postal code is not a place for a newline either. */
const postalCodeSchema = z
  .string()
  .trim()
  .min(1, 'Must not be empty')
  .max(32)
  .refine(noControlCharacters, { message: CONTROL_CHARACTER_MESSAGE });

/**
 * One address in the caller's address book (F12/AC2).
 *
 * No `userId` on the wire. Every address a caller can see is their own — the list is
 * scoped by the token and a single fetch is scoped by owner in the query — so putting
 * the owner id in the response would add a field that is either always the caller or a
 * bug, and inviting a client to read it is inviting a client to send it.
 */
export const addressSchema = z.object({
  id: z.uuid(),
  kind: addressKindSchema,
  isDefault: z.boolean(),
  fullName: z.string(),
  line1: z.string(),
  line2: z.string().nullable(),
  city: z.string(),
  region: z.string().nullable(),
  postalCode: z.string(),
  country: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Address = z.infer<typeof addressSchema>;

/**
 * Creating an address (F12/AC2).
 *
 * `isDefault` defaults to false rather than being required: most additions are not a
 * change of default, and requiring the flag on every create makes "add an address"
 * carry a decision the caller did not ask to make. Passing `true` clears the previous
 * default for that kind, in one transaction — see the repository.
 */
export const createAddressRequestSchema = z.strictObject({
  kind: addressKindSchema,
  isDefault: z.boolean().default(false),
  fullName: addressLineSchema,
  line1: addressLineSchema,
  line2: optionalAddressLineSchema,
  city: addressLineSchema,
  region: optionalAddressLineSchema,
  postalCode: postalCodeSchema,
  country: countrySchema,
});

export type CreateAddressRequest = z.infer<typeof createAddressRequestSchema>;

/**
 * Updating an address (F12/AC2).
 *
 * `kind` is absent on purpose. Moving an address between SHIPPING and BILLING while it
 * is the default for one of them is a two-constraint change dressed up as a field edit;
 * a caller who wants that can create the other and delete this one, which is explicit
 * about what happens to the defaults.
 */
export const updateAddressRequestSchema = z
  .strictObject({
    isDefault: z.boolean().optional(),
    fullName: addressLineSchema.optional(),
    line1: addressLineSchema.optional(),
    line2: optionalAddressLineSchema,
    city: addressLineSchema.optional(),
    region: optionalAddressLineSchema,
    postalCode: postalCodeSchema.optional(),
    country: countrySchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Provide at least one field to update',
  });

export type UpdateAddressRequest = z.infer<typeof updateAddressRequestSchema>;

/**
 * The address list.
 *
 * A bare array, not the paginated envelope.
 *
 * The first version of this comment justified that by asserting an address book is
 * "bounded by how many places one person ships to". That was an assumption, not a
 * constraint — the security review of PR #95 created 120 addresses in parallel and got
 * all 132 back in one 35 KB response. `MAX_ADDRESSES_PER_ACCOUNT` is the constraint
 * that makes the claim true, enforced in the service on create.
 *
 * `paginatedSchema` remains the rule for genuinely open-ended collections (§ Contracts).
 */
/**
 * How many addresses one account may hold.
 *
 * Generous for a person and small enough that the list stays one cheap query and a
 * small response. It is a resource cap, not rate limiting — F51's throttling would
 * slow an abuser down without ever bounding what they had already stored.
 */
export const MAX_ADDRESSES_PER_ACCOUNT = 50;

export const addressListSchema = z.array(addressSchema);

export type AddressList = z.infer<typeof addressListSchema>;

/** An address id in a path parameter — parsed at the edge, not passed through. */
export const addressIdSchema = z.uuid();

/** Re-exported so a caller can narrow on the kind without importing the generated file. */
export { AddressKind };
