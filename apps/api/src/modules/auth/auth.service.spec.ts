/**
 * AuthService rules, with fakes for the two collaborators (F7).
 *
 * The fakes record the ORDER of calls, because the order is the acceptance criterion:
 * AC3's timing half is satisfied by hashing before the database is touched, and no
 * amount of end-to-end assertion states that as directly as this does.
 */
import { registeredUserSchema } from '@repo/contracts';
import { ConflictError, ValidationError } from '../../common/errors/domain-error';
import { AuthRepository, type CreateUserOutcome, type NewUserRow } from './auth.repository';
import { AuthService } from './auth.service';
import type { PasswordHasher } from './password/password-hasher';

const CREATED_AT = new Date('2026-08-14T09:30:00.000Z');

const VALID = {
  email: 'Ada@Example.COM',
  password: 'marmalade-tuesday-gantry',
  firstName: 'Ada',
  lastName: 'Lovelace',
};

/**
 * The fake hash deliberately does NOT contain its input — otherwise "the plaintext
 * never reaches the repository" would be untestable through it.
 */
const FAKE_HASH = '$argon2id$fake$for$unit$tests';

/** One shared log, so "hashed before it wrote" is a single assertion. */
class Harness {
  readonly calls: string[] = [];
  readonly hashed: string[] = [];
  readonly created: NewUserRow[] = [];
  takenEmails = new Set<string>();

  readonly hasher: PasswordHasher = {
    hash: async (plaintext: string): Promise<string> => {
      this.calls.push('hash');
      this.hashed.push(plaintext);
      return Promise.resolve(FAKE_HASH);
    },
  };

  readonly repository = {
    createUser: async (input: NewUserRow): Promise<CreateUserOutcome> => {
      this.calls.push('createUser');
      if (this.takenEmails.has(input.email)) return Promise.resolve({ created: false });
      this.created.push(input);
      return Promise.resolve({
        created: true,
        user: {
          id: '018f1f77-bcf8-7c3d-9a3b-2c4c6b3f0a11',
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          createdAt: CREATED_AT,
        },
      });
    },
  } as unknown as AuthRepository;

  readonly service = new AuthService(this.repository, this.hasher);
}

describe('AuthService.register', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = new Harness();
  });

  it('stores the email canonicalised — trimmed and lower-cased (AC4)', async () => {
    await harness.service.register({ ...VALID, email: '  Ada@Example.COM  ' });
    expect(harness.created[0]?.email).toBe('ada@example.com');
  });

  it('stores the hash and never the plaintext (AC1)', async () => {
    await harness.service.register(VALID);

    // Hashed exactly what was submitted, byte for byte — no trimming, no case-folding.
    expect(harness.hashed).toEqual([VALID.password]);
    expect(harness.created[0]?.passwordHash).toBe(FAKE_HASH);
    expect(JSON.stringify(harness.created)).not.toContain(VALID.password);
  });

  it('hashes BEFORE touching the users table, so a duplicate costs the same (AC3)', async () => {
    await harness.service.register(VALID);
    expect(harness.calls).toEqual(['hash', 'createUser']);
  });

  it('still pays the hash on the duplicate path — no early return (AC3)', async () => {
    harness.takenEmails.add('ada@example.com');

    await expect(harness.service.register(VALID)).rejects.toBeInstanceOf(ConflictError);
    // Identical call sequence to the success case above: nothing about the wall clock
    // distinguishes a taken address from a free one.
    expect(harness.calls).toEqual(['hash', 'createUser']);
  });

  it('has no way to read a user by email — the index decides uniqueness (AC3)', () => {
    // A findByEmail on the repository is how the read-then-write oracle gets
    // reintroduced. There is nothing to call, so it cannot be called by accident.
    const methods = Object.getOwnPropertyNames(AuthRepository.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(methods).toEqual(['createUser']);
  });

  it('rejects a duplicate with a 409 that does not name the address (AC3)', async () => {
    harness.takenEmails.add('ada@example.com');

    await expect(harness.service.register(VALID)).rejects.toMatchObject({
      status: 409,
      message: expect.not.stringContaining('ada'),
    });
  });

  it('rejects a common password with a per-field 422, before hashing anything (AC2)', async () => {
    const failure = await harness.service
      .register({ ...VALID, password: 'password1234' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ValidationError);
    expect((failure as ValidationError).errors).toEqual([
      { path: 'password', message: expect.any(String) },
    ]);
    // The blocklist depends only on the password, so refusing early leaks nothing
    // about which addresses exist — and no row was written.
    expect(harness.calls).toEqual([]);
    expect(harness.created).toEqual([]);
  });

  it('returns exactly the contract shape, with no password material', async () => {
    const user = await harness.service.register(VALID);

    expect(registeredUserSchema.parse(user)).toEqual(user);
    expect(Object.keys(user).sort()).toEqual(['createdAt', 'email', 'firstName', 'id', 'lastName']);
    expect(user.createdAt).toBe(CREATED_AT.toISOString());
    expect(user.email).toBe('ada@example.com');
  });
});
