/**
 * AuthService rules, with fakes for its collaborators (F7 registration, F8 login and
 * refresh).
 *
 * The fakes record the ORDER of calls, because the order is the acceptance criterion:
 * F7/AC3's timing half is satisfied by hashing before the database is touched, and
 * F8/AC4's by verifying a hash on the unknown-account path too. No amount of end-to-end
 * assertion states either as directly as this does.
 */
import { createHash } from 'node:crypto';
import { registeredUserSchema } from '@repo/contracts';
import type { AuthTokens } from '@repo/contracts';
import {
  ConflictError,
  UnauthenticatedError,
  ValidationError,
} from '../../common/errors/domain-error';
import type {
  AuthRepository,
  CredentialRow,
  CreateUserOutcome,
  NewUserRow,
  RotationOutcome,
  SessionOrigin,
  SessionRow,
} from './auth.repository';
import { AuthService, INVALID_CREDENTIALS, SESSION_NOT_VALID } from './auth.service';
import type { PasswordHasher } from './password/password-hasher';
import type { AccessTokenService } from './tokens/access-token.service';
import type { MintedRefreshToken, RefreshTokenService } from './tokens/refresh-token.service';

const CREATED_AT = new Date('2026-08-14T09:30:00.000Z');

const VALID = {
  email: 'Ada@Example.COM',
  password: 'marmalade-tuesday-gantry',
  firstName: 'Ada',
  lastName: 'Lovelace',
};

const USER_ID = '018f1f77-bcf8-7c3d-9a3b-2c4c6b3f0a11';
const ORIGIN: SessionOrigin = { device: 'jest', ip: '127.0.0.1' };

/**
 * The error a call was expected to reject with.
 *
 * Fails loudly when the call RESOLVES instead — a plain `.catch(e => e)` would hand the
 * resolved value on and the assertions below it would then be checking properties of a
 * successful login, which is how a test that should have caught a regression passes.
 */
async function rejection(promise: Promise<unknown>): Promise<UnauthenticatedError> {
  let resolved = false;
  const outcome = await promise.then(
    () => {
      resolved = true;
      return undefined;
    },
    (error: unknown) => error,
  );
  if (resolved) throw new Error('expected the call to reject, but it resolved');
  return outcome as UnauthenticatedError;
}

/**
 * The fake hash deliberately does NOT contain its input — otherwise "the plaintext
 * never reaches the repository" would be untestable through it.
 */
const FAKE_HASH = '$argon2id$fake$for$unit$tests';

/**
 * Stand-in for the keyed refresh-token hash. Real SHA-256 for the same reason as
 * above: a fake like `hmac(${token})` embeds the plaintext, and every "the token never
 * reaches the database" assertion would then be testing the fake rather than the code.
 */
function fakeTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** One shared log, so "hashed before it wrote" is a single assertion. */
class Harness {
  readonly calls: string[] = [];
  readonly hashed: string[] = [];
  readonly created: NewUserRow[] = [];
  readonly createdSessions: unknown[] = [];
  readonly revokedFamilies: string[] = [];
  readonly rotations: { presentedHash: string; nextHash: string }[] = [];

  takenEmails = new Set<string>();
  /** email → row. Absent means "no such account", which is AC4's expensive path. */
  credentials = new Map<string, CredentialRow>();
  /** What `rotateSession` should report next. */
  rotationOutcome: RotationOutcome = { outcome: 'unknown' };

  private mintCount = 0;

  readonly hasher = {
    hash: async (plaintext: string): Promise<string> => {
      this.calls.push('hash');
      this.hashed.push(plaintext);
      return Promise.resolve(FAKE_HASH);
    },
    verify: async (storedHash: string, candidate: string): Promise<boolean> => {
      this.calls.push('verify');
      // The real hasher compares an Argon2 digest; the fake accepts when the stored
      // hash is literally `hash:<password>`, which the credential fixtures use.
      return Promise.resolve(storedHash === `hash:${candidate}`);
    },
    verifyAgainstDummy: async (_candidate: string): Promise<false> => {
      this.calls.push('verifyAgainstDummy');
      return Promise.resolve(false as const);
    },
  } as unknown as PasswordHasher;

  readonly accessTokens = {
    issue: (input: { userId: string; sessionId: string }): AuthTokens => {
      this.calls.push('issueAccessToken');
      return {
        accessToken: `access-for:${input.userId}:${input.sessionId}`,
        tokenType: 'Bearer',
        expiresIn: 900,
      };
    },
  } as unknown as AccessTokenService;

  readonly refreshTokens = {
    mint: (): MintedRefreshToken => {
      this.mintCount += 1;
      const token = `refresh-plaintext-${this.mintCount}`;
      return {
        token,
        tokenHash: fakeTokenHash(token),
        expiresAt: new Date('2026-09-13T09:30:00.000Z'),
      };
    },
    hash: fakeTokenHash,
    newFamily: (): string => 'family-1',
  } as unknown as RefreshTokenService;

  readonly repository = {
    createUser: async (input: NewUserRow): Promise<CreateUserOutcome> => {
      this.calls.push('createUser');
      if (this.takenEmails.has(input.email)) return Promise.resolve({ created: false });
      this.created.push(input);
      return Promise.resolve({
        created: true,
        user: {
          id: USER_ID,
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          createdAt: CREATED_AT,
        },
      });
    },

    findCredentialsByEmail: async (email: string): Promise<CredentialRow | null> => {
      this.calls.push('findCredentialsByEmail');
      return Promise.resolve(this.credentials.get(email) ?? null);
    },

    createSession: async (input: {
      userId: string;
      family: string;
      refreshTokenHash: string;
    }): Promise<SessionRow> => {
      this.calls.push('createSession');
      this.createdSessions.push(input);
      return Promise.resolve({
        id: 'session-1',
        userId: input.userId,
        family: input.family,
        user: { role: 'CUSTOMER' },
      });
    },

    rotateSession: async (input: {
      presentedHash: string;
      next: { refreshTokenHash: string };
    }): Promise<RotationOutcome> => {
      this.calls.push('rotateSession');
      this.rotations.push({
        presentedHash: input.presentedHash,
        nextHash: input.next.refreshTokenHash,
      });
      return Promise.resolve(this.rotationOutcome);
    },

    revokeFamily: async (family: string): Promise<number> => {
      this.calls.push('revokeFamily');
      this.revokedFamilies.push(family);
      return Promise.resolve(3);
    },
  } as unknown as AuthRepository;

  readonly service = new AuthService(
    this.repository,
    this.hasher,
    this.accessTokens,
    this.refreshTokens,
  );
}

describe('AuthService.register', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = new Harness();
  });

  it('stores the email canonicalised — trimmed and lower-cased (F7/AC4)', async () => {
    await harness.service.register({ ...VALID, email: '  Ada@Example.COM  ' });
    expect(harness.created[0]?.email).toBe('ada@example.com');
  });

  it('stores the hash and never the plaintext (F7/AC1)', async () => {
    await harness.service.register(VALID);

    // Hashed exactly what was submitted, byte for byte — no trimming, no case-folding.
    expect(harness.hashed).toEqual([VALID.password]);
    expect(harness.created[0]?.passwordHash).toBe(FAKE_HASH);
    expect(JSON.stringify(harness.created)).not.toContain(VALID.password);
  });

  it('hashes BEFORE touching the users table, so a duplicate costs the same (F7/AC3)', async () => {
    await harness.service.register(VALID);
    expect(harness.calls).toEqual(['hash', 'createUser']);
  });

  it('still pays the hash on the duplicate path — no early return (F7/AC3)', async () => {
    harness.takenEmails.add('ada@example.com');

    await expect(harness.service.register(VALID)).rejects.toBeInstanceOf(ConflictError);
    // Identical call sequence to the success case above: nothing about the wall clock
    // distinguishes a taken address from a free one.
    expect(harness.calls).toEqual(['hash', 'createUser']);
  });

  /**
   * The replacement for "AuthRepository has no findByEmail at all", which stopped being
   * available when F8 gave login the lookup it genuinely needs.
   *
   * The property that mattered was never "the method does not exist" — it was
   * "registration does not call it", because a read-then-insert is both the race and
   * the timing oracle F7/AC3 forbids. The fake records every repository call, so the
   * exact sequence is asserted here on both the happy and the duplicate path.
   */
  it('never looks an address up before inserting, on either path (F7/AC3)', async () => {
    await harness.service.register(VALID);
    harness.takenEmails.add('ada@example.com');
    await expect(harness.service.register(VALID)).rejects.toBeInstanceOf(ConflictError);

    expect(harness.calls).toEqual(['hash', 'createUser', 'hash', 'createUser']);
    expect(harness.calls).not.toContain('findCredentialsByEmail');
  });

  it('rejects a duplicate with a 409 that does not name the address (F7/AC3)', async () => {
    harness.takenEmails.add('ada@example.com');

    await expect(harness.service.register(VALID)).rejects.toMatchObject({
      status: 409,
      message: expect.not.stringContaining('ada'),
    });
  });

  it('rejects a common password with a per-field 422, before hashing anything (F7/AC2)', async () => {
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

describe('AuthService.login (F8)', () => {
  let harness: Harness;

  const CREDENTIALS = { email: 'ada@example.com', password: 'marmalade-tuesday-gantry' };

  beforeEach(() => {
    harness = new Harness();
    harness.credentials.set('ada@example.com', {
      id: USER_ID,
      passwordHash: `hash:${CREDENTIALS.password}`,
      role: 'CUSTOMER',
    });
  });

  it('issues an access token bound to the session it just created (AC1)', async () => {
    const issued = await harness.service.login(CREDENTIALS, ORIGIN);

    expect(issued.tokens.accessToken).toBe(`access-for:${USER_ID}:session-1`);
    expect(issued.tokens.tokenType).toBe('Bearer');
    expect(harness.createdSessions).toEqual([
      expect.objectContaining({ userId: USER_ID, family: 'family-1' }),
    ]);
  });

  it('stores only the hash of the refresh token, never the token (AC1)', async () => {
    const issued = await harness.service.login(CREDENTIALS, ORIGIN);

    expect(issued.refreshToken).toBe('refresh-plaintext-1');
    expect(JSON.stringify(harness.createdSessions)).not.toContain(issued.refreshToken);
    expect(harness.createdSessions).toEqual([
      expect.objectContaining({ refreshTokenHash: fakeTokenHash('refresh-plaintext-1') }),
    ]);
    // …and the plaintext is not smuggled into the response body either.
    expect(JSON.stringify(issued.tokens)).not.toContain(issued.refreshToken);
  });

  it('canonicalises the email, so A@B logs in as a@b (AC1)', async () => {
    await expect(
      harness.service.login({ ...CREDENTIALS, email: '  ADA@Example.com ' }, ORIGIN),
    ).resolves.toBeDefined();
  });

  /**
   * THE enumeration test (AC4).
   *
   * An unknown address must still pay a full Argon2id verify. The call log is the
   * assertion: `verifyAgainstDummy` is the dummy-hash comparison, and its presence is
   * what makes the unknown-account path cost the same as the wrong-password one. The
   * e2e suite measures the resulting wall clock; this states the mechanism.
   */
  it('verifies against a dummy hash when the account does not exist (AC4)', async () => {
    await expect(
      harness.service.login({ ...CREDENTIALS, email: 'nobody@example.com' }, ORIGIN),
    ).rejects.toBeInstanceOf(UnauthenticatedError);

    expect(harness.calls).toEqual(['findCredentialsByEmail', 'verifyAgainstDummy']);
  });

  it('verifies against the stored hash when the password is wrong (AC4)', async () => {
    await expect(
      harness.service.login({ ...CREDENTIALS, password: 'not-the-password' }, ORIGIN),
    ).rejects.toBeInstanceOf(UnauthenticatedError);

    expect(harness.calls).toEqual(['findCredentialsByEmail', 'verify']);
  });

  it('answers the two failures with the identical error (AC4)', async () => {
    const unknown = await rejection(
      harness.service.login({ ...CREDENTIALS, email: 'nobody@example.com' }, ORIGIN),
    );
    const wrongPassword = await rejection(
      harness.service.login({ ...CREDENTIALS, password: 'not-the-password' }, ORIGIN),
    );

    expect(unknown.message).toBe(INVALID_CREDENTIALS);
    expect(wrongPassword.message).toBe(unknown.message);
    expect(wrongPassword.status).toBe(unknown.status);
    expect(wrongPassword.type).toBe(unknown.type);
    // Neither one names the address, which the message would otherwise do for free.
    expect(unknown.message).not.toContain('nobody');
    expect(unknown.message).not.toContain('ada');
  });

  it('creates no session when the credentials are wrong (AC4)', async () => {
    await expect(
      harness.service.login({ ...CREDENTIALS, password: 'wrong' }, ORIGIN),
    ).rejects.toBeInstanceOf(UnauthenticatedError);

    expect(harness.createdSessions).toEqual([]);
    expect(harness.calls).not.toContain('issueAccessToken');
  });
});

describe('AuthService.refresh (F8)', () => {
  let harness: Harness;
  const PRESENTED = 'a'.repeat(43);

  beforeEach(() => {
    harness = new Harness();
  });

  it('exchanges the presented token for a new one in the same session (AC2)', async () => {
    harness.rotationOutcome = {
      outcome: 'rotated',
      session: { id: 'session-2', userId: USER_ID, family: 'family-1', user: { role: 'CUSTOMER' } },
    };

    const issued = await harness.service.refresh(PRESENTED, ORIGIN);

    expect(harness.rotations).toEqual([
      {
        presentedHash: fakeTokenHash(PRESENTED),
        nextHash: fakeTokenHash('refresh-plaintext-1'),
      },
    ]);
    // The presented token is hashed before it goes anywhere near the repository.
    expect(JSON.stringify(harness.rotations)).not.toContain(PRESENTED);
    // A NEW token comes back — returning the presented one would satisfy "rotation
    // happened" from the client's side while invalidating nothing.
    expect(issued.refreshToken).not.toBe(PRESENTED);
    expect(issued.tokens.accessToken).toBe(`access-for:${USER_ID}:session-2`);
  });

  /**
   * AC3 as a rule, stated where the rule lives.
   *
   * Reuse revokes the FAMILY — every session descended from that login — and not just
   * the presented row. Revoking one row would leave the thief's freshly rotated token
   * working, which is the whole failure this criterion exists to prevent.
   */
  it('revokes the entire family when a rotated token is presented again (AC3)', async () => {
    harness.rotationOutcome = { outcome: 'reused', family: 'family-1', userId: USER_ID };

    const failure = await rejection(harness.service.refresh(PRESENTED, ORIGIN));

    expect(failure).toBeInstanceOf(UnauthenticatedError);
    expect(failure.status).toBe(401);
    expect(harness.revokedFamilies).toEqual(['family-1']);
  });

  it('does not revoke anything for a merely unknown or expired token (AC3)', async () => {
    for (const outcome of [{ outcome: 'unknown' } as const, { outcome: 'rejected' } as const]) {
      harness.rotationOutcome = outcome;
      await expect(harness.service.refresh(PRESENTED, ORIGIN)).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
    }
    // Revoking a family on an unknown token would let anyone log anyone else out by
    // guessing — there is no family to blame, so nothing is revoked.
    expect(harness.revokedFamilies).toEqual([]);
  });

  it('answers every failure with the same message (AC3)', async () => {
    const messages: string[] = [];
    for (const outcome of [
      { outcome: 'unknown' } as const,
      { outcome: 'rejected' } as const,
      { outcome: 'reused', family: 'family-1', userId: USER_ID } as const,
    ]) {
      harness.rotationOutcome = outcome;
      const failure = await rejection(harness.service.refresh(PRESENTED, ORIGIN));
      messages.push(failure.message);
    }

    expect(messages).toEqual([SESSION_NOT_VALID, SESSION_NOT_VALID, SESSION_NOT_VALID]);
  });

  it('rejects a missing or malformed cookie without a database round trip', async () => {
    for (const presented of [undefined, '', 'not-a-refresh-token', `${PRESENTED}extra`]) {
      await expect(harness.service.refresh(presented, ORIGIN)).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
    }
    // The contract schema rejects it before anything is hashed or looked up, so a
    // garbage cookie cannot be used to probe the sessions table at all.
    expect(harness.calls).toEqual([]);
  });
});
